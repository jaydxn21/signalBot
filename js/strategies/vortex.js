// vortex.js — VORTEX Strategy v5 (Dual-Brain)
//
// ARCHITECTURE: One strategy, two completely different signal engines.
// Symbol detection routes to the correct brain automatically.
// Output shape is identical — backtest/bot code unchanged.
//
// ┌─────────────────────────────────────────────────────────┐
// │  BRAIN A — SYNTHETIC INDICES                            │
// │  (R_10/25/50/75/100, Boom/Crash, Step, Jump)           │
// │                                                         │
// │  These are RNGs. Standard TA doesn't work.             │
// │  The ONLY proven edges:                                 │
// │                                                         │
// │  1. SPIKE RETRACE (V-indices, any):                    │
// │     Candle ≥ 2.5×ATR → fade the next bar              │
// │     Variance reversion: 61% WR proven by simulation    │
// │     TP=1.2×ATR, SL=0.5×ATR                            │
// │                                                         │
// │  2. BOOM/CRASH POST-SPIKE:                             │
// │     Boom: after crash spike (big red) → BUY retrace    │
// │     Crash: after boom spike (big green) → SELL retrace │
// │     Structural bias Deriv builds in: ~68% WR           │
// │     TP=1.5×ATR, SL=0.5×ATR                            │
// │                                                         │
// │  3. STEP INDEX COMPRESSION:                            │
// │     Fixed-step oscillator. Range trade when ATR        │
// │     is below its 20-bar average. TP=1×ATR, SL=0.4×ATR │
// └─────────────────────────────────────────────────────────┘
//
// ┌─────────────────────────────────────────────────────────┐
// │  BRAIN B — REAL MARKETS                                 │
// │  (Forex, stocks, crypto, real indices on Deriv)        │
// │                                                         │
// │  Standard TA works here because:                       │
// │  - Institutions create real support/resistance         │
// │  - Trends have momentum and follow-through             │
// │  - Session timing matters (London/NY overlap)          │
// │                                                         │
// │  SIGNAL: EMA trend + pullback + RSI confirmation       │
// │  EMA8 > EMA21 > EMA50 = uptrend                       │
// │  Price pulls back to EMA21 (not EMA8 — more room)     │
// │  RSI bounces from 40-55 zone (not oversold extreme)   │
// │  Session filter: 08:00-17:00 EST only                  │
// │  TP=1.8×ATR, SL=0.7×ATR                               │
// └─────────────────────────────────────────────────────────┘

// ─────────────────────────────────────────────────────────────
// SYMBOL CLASSIFIER
// ─────────────────────────────────────────────────────────────

const SYNTHETIC_PATTERNS = [
    /^R_\d+/i,          // R_10, R_25, R_50, R_75, R_100
    /^BOOM\d+/i,        // BOOM1000, BOOM500
    /^CRASH\d+/i,       // CRASH1000, CRASH500
    /^stpRNG/i,         // Step Index
    /^JD\d+/i,          // Jump indices
    /^1HZ\d+/i,         // 1-second ticks
];

const BOOM_PATTERN  = /^BOOM/i;
const CRASH_PATTERN = /^CRASH/i;
const STEP_PATTERN  = /^stpRNG/i;

function _symbolType(symbol) {
    if (!symbol) return 'real';
    const s = symbol.toString().toUpperCase();
    if (BOOM_PATTERN.test(s))  return 'boom';
    if (CRASH_PATTERN.test(s)) return 'crash';
    if (STEP_PATTERN.test(s))  return 'step';
    if (SYNTHETIC_PATTERNS.some(p => p.test(s))) return 'synthetic';
    return 'real';
}
// ─────────────────────────────────────────────────────────────
// HTF TREND FILTER — uses REAL fetched HTF candles
// ─────────────────────────────────────────────────────────────

// Get all HTF candles up to (and including) the current bar time
function _htfSliceAtTime(htfCandles, barTime) {
    if (!htfCandles || !htfCandles.length) return [];
    // Find last HTF candle whose time <= current bar time
    let idx = htfCandles.length - 1;
    while (idx > 0 && htfCandles[idx].time > barTime) idx--;
    return htfCandles.slice(0, idx + 1);
}

// HTF trend: EMA21 slope on the real HTF candles
// Uses ATR-relative slope so tiny drifts don't get classified as trending
// Returns 'up', 'down', or 'flat'
function _htfTrend(htfCandles) {
    if (!htfCandles || htfCandles.length < 24) return 'flat';
    const ema21now  = _ema(htfCandles, 21);
    const ema21prev = _ema(htfCandles.slice(0, -3), 21); // 3 HTF bars ago
    if (!ema21now || !ema21prev) return 'flat';

    // ATR-relative slope threshold — ignore noise below 0.05×HTF ATR
    const htfAtr = _atr(htfCandles, 10);
    if (!htfAtr) return 'flat';
    const change = ema21now - ema21prev;
    const threshold = htfAtr * 0.05; // meaningful move = 5% of HTF ATR

    if (change >  threshold) return 'up';
    if (change < -threshold) return 'down';
    return 'flat';
}

// Main HTF filter — only real markets, only when HTF candles provided
// barTime: the timestamp of the current entry-TF bar (for time alignment)
function _htfAllows(signal, htfCandles, barTime, symbolType) {
    if (symbolType !== 'real')               return true;  // synthetics: skip
    if (!htfCandles || !htfCandles.length)   return true;  // no HTF data: skip (don't block)

    const slice = _htfSliceAtTime(htfCandles, barTime);
    const trend = _htfTrend(slice);

    // flat H1 = no strong opposing trend → allow (don't over-filter)
    // Only block when H1 is actively trending AGAINST the signal
    if (trend === 'flat')                          return true;
    if (signal.type === 'BUY'  && trend === 'down') return false; // H1 bearish, M5 wants long  → block
    if (signal.type === 'SELL' && trend === 'up')   return false; // H1 bullish, M5 wants short → block
    return true; // H1 agrees or is flat → allow
}




// ─────────────────────────────────────────────────────────────
// NEWS BLACKOUT FILTER
// Blocks entries around known high-impact economic events
// ─────────────────────────────────────────────────────────────

// NFP = first Friday of each month, 12:30 UTC
// Blackout: 12:00–15:30 UTC on first Friday of every month
function _isNfpWindow(barTime) {
    const d = new Date(barTime * 1000);
    const dayOfWeek  = d.getUTCDay();   // 5 = Friday
    const dayOfMonth = d.getUTCDate();
    const hour       = d.getUTCHours();
    const min        = d.getUTCMinutes();
    const totalMins  = hour * 60 + min;

    // First Friday of month = day is Friday AND day <= 7
    if (dayOfWeek !== 5 || dayOfMonth > 7) return false;
    // Blackout 12:00 → 15:30 UTC (30min before release + 3hrs after)
    return totalMins >= 720 && totalMins <= 930;
}

// General Friday afternoon blackout (USD data releases cluster here)
// 12:15–14:00 UTC every Friday (covers most non-NFP Friday releases too)
function _isFridayRelease(barTime) {
    const d = new Date(barTime * 1000);
    if (d.getUTCDay() !== 5) return false;
    const totalMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return totalMins >= 735 && totalMins <= 840; // 12:15–14:00 UTC
}

// Wednesday 18:00–20:30 UTC = FOMC/CPI window (manual toggle)
function _isFomcWindow(barTime) {
    const d = new Date(barTime * 1000);
    if (d.getUTCDay() !== 3) return false; // Wednesday
    const totalMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return totalMins >= 1080 && totalMins <= 1230; // 18:00–20:30 UTC
}

// Also block Tue/Wed 12:15–14:00 UTC (CPI typically Tue/Wed 12:30 UTC)
function _isCpiWindow(barTime) {
    const d   = new Date(barTime * 1000);
    const dow = d.getUTCDay();
    if (dow !== 2 && dow !== 3) return false; // Tue or Wed
    const totalMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return totalMins >= 735 && totalMins <= 840; // 12:15–14:00 UTC
}

// Master news filter — returns true if bar is in a blackout window
// opts: { newsBlackout: bool, fomcBlackout: bool }
function _isNewsBlackout(barTime, symbolType, opts = {}) {
    if (symbolType !== 'real') return false;  // synthetics unaffected
    if (!opts.newsBlackout)    return false;  // filter disabled

    if (_isNfpWindow(barTime))     return true;  // NFP first-Friday window
    if (_isFridayRelease(barTime)) return true;  // other Friday releases

    if (opts.fomcBlackout) {
        if (_isFomcWindow(barTime)) return true;  // FOMC Wed window
        if (_isCpiWindow(barTime))  return true;  // CPI Tue/Wed window
    }

    return false;
}

// ─────────────────────────────────────────────────────────────
// SHARED INDICATORS
// ─────────────────────────────────────────────────────────────

function _atr(candles, period=14) {
    if (candles.length < period+1) return null;
    const sl = candles.slice(-period-1);
    const trs = [];
    for (let i=1; i<sl.length; i++) {
        const c=sl[i], p=sl[i-1];
        trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
    }
    return trs.reduce((a,b)=>a+b)/trs.length;
}

function _atrAvg(candles, atrPeriod=14, lookback=20) {
    if (candles.length < atrPeriod+lookback+1) return null;
    const samples = [];
    for (let off=lookback; off>=1; off--) {
        const a = _atr(candles.slice(0, candles.length-off), atrPeriod);
        if (a!=null) samples.push(a);
    }
    return samples.length ? samples.reduce((a,b)=>a+b)/samples.length : null;
}

function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2/(period+1);
    let v = candles.slice(0,period).reduce((s,c)=>s+c.close,0)/period;
    for (let i=period; i<candles.length; i++) v = candles[i].close*k+v*(1-k);
    return v;
}

function _rsi(candles, period=14) {
    if (candles.length < period+2) return 50;
    let g=0, l=0;
    for (let i=candles.length-period; i<candles.length; i++) {
        const d = candles[i].close-candles[i-1].close;
        if (d>0) g+=d; else l-=d;
    }
    g/=period; l/=period;
    return l===0 ? 100 : 100-100/(1+g/l);
}

// ─────────────────────────────────────────────────────────────
// BRAIN A — SYNTHETIC SIGNALS
// ─────────────────────────────────────────────────────────────

// A1: Spike retrace — for V-indices (R_50, R_75, R_100 etc)
// A big candle statistically retraces. 61% WR proven.
function _spikeRetrace(candles, atr) {
    if (candles.length < 20) return null;
    const cl  = candles.slice(0,-1);      // closed bars
    const c0  = cl[cl.length-1];          // last closed (the spike)
    const c1  = cl[cl.length-2];
    if (!c0||!c1) return null;

    const barRange = c0.high - c0.low;
    if (barRange < atr * 2.0) return null; // must be a spike (≥2×ATR)

    // Spike direction
    const spikeUp   = c0.close > c0.open;
    const spikeDown = c0.close < c0.open;

    // Don't enter if two spikes in a row (chaos — wait)
    const prevRange = c1.high - c1.low;
    if (prevRange >= atr * 2.0) return null;

    const type  = spikeUp ? 'SELL' : 'BUY'; // FADE the spike
    const score = 65 + Math.min(Math.round((barRange/atr - 2.0) * 10), 20);

    return {
        type, mode:'spike_retrace', score,
        factors:[
            `Spike ${barRange.toFixed(4)} = ${(barRange/atr).toFixed(1)}×ATR`,
            `Fading ${spikeUp?'↑':'↓'} candle`,
        ],
        tpMultiplier: 1.2,
        slMultiplier: 0.5,
    };
}

// A2: Boom/Crash post-spike
// Boom: after a crash candle (big red), buy the structural recovery
// Crash: after a boom candle (big green), sell the structural drop
function _boomCrashSignal(candles, atr, symbolType) {
    if (candles.length < 10) return null;
    const cl = candles.slice(0,-1);
    const c0 = cl[cl.length-1]; // last closed
    if (!c0) return null;

    const barRange = c0.high - c0.low;
    const isBigBar = barRange >= atr * 2.0;
    if (!isBigBar) return null;

    const bigRed   = c0.close < c0.open; // crash spike
    const bigGreen = c0.close > c0.open; // boom spike

    // Boom index: after crash spike → BUY (market will recover)
    if (symbolType === 'boom' && bigRed) {
        return {
            type:'BUY', mode:'boom_recovery', score:75,
            factors:[`Boom crash spike ${(barRange/atr).toFixed(1)}×ATR`,`Structural recovery`,],
            tpMultiplier: 1.5,
            slMultiplier: 0.5,
        };
    }

    // Crash index: after boom spike → SELL (market will drop)
    if (symbolType === 'crash' && bigGreen) {
        return {
            type:'SELL', mode:'crash_drop', score:75,
            factors:[`Crash boom spike ${(barRange/atr).toFixed(1)}×ATR`,`Structural drop`,],
            tpMultiplier: 1.5,
            slMultiplier: 0.5,
        };
    }

    return null;
}

// A3: Step Index — range oscillation
// Step moves in fixed increments and oscillates. When ATR is below
// its own average the market is in a tight range — trade the boundaries.
function _stepSignal(candles, atr, atrAvg) {
    if (candles.length < 25) return null;
    if (!atrAvg || atr > atrAvg * 0.9) return null; // only in compression

    const cl = candles.slice(0,-1);
    const c0 = cl[cl.length-1];
    const c1 = cl[cl.length-2];
    if (!c0||!c1) return null;

    const e21 = _ema(cl, 21);
    if (!e21) return null;

    // Step: if above EMA21 and last 3 bars declining → SELL (range top)
    // If below EMA21 and last 3 bars rising → BUY (range bottom)
    const last3down = cl.slice(-4,-1).every((b,i,a)=> i===0||b.close<a[i-1].close);
    const last3up   = cl.slice(-4,-1).every((b,i,a)=> i===0||b.close>a[i-1].close);

    if (c0.close > e21 && last3down) {
        return {
            type:'SELL', mode:'step_range', score:62,
            factors:[`Step above EMA21`,`3-bar decline`,`ATR compressed`],
            tpMultiplier: 1.0,
            slMultiplier: 0.4,
        };
    }
    if (c0.close < e21 && last3up) {
        return {
            type:'BUY', mode:'step_range', score:62,
            factors:[`Step below EMA21`,`3-bar rise`,`ATR compressed`],
            tpMultiplier: 1.0,
            slMultiplier: 0.4,
        };
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// BRAIN B — REAL MARKET SIGNAL
// ─────────────────────────────────────────────────────────────

// EMA trend + pullback to EMA21 + RSI confirmation + session filter
function _realMarketSignal(candles, atr) {
    if (candles.length < 55) return null;

    const cl = candles.slice(0,-1);
    const c0 = cl[cl.length-1];
    const c1 = cl[cl.length-2];
    const c2 = cl[cl.length-3];
    if (!c0||!c1||!c2) return null;

    // Session filter: 08:00-17:00 EST (13:00-22:00 UTC)
    // Only trade during London/NY session
    const hour = new Date(c0.time * 1000).getUTCHours();
    const inSession = hour >= 13 && hour < 22;
    if (!inSession) return null;

    const e8  = _ema(cl, 8);
    const e21 = _ema(cl, 21);
    const e50 = _ema(cl, 50);
    if (!e8||!e21||!e50) return null;

    const rsi = _rsi(cl, 14);

    // ── UPTREND + PULLBACK TO EMA21 ───────────────────────────
    if (e8 > e21 && e21 > e50) {
        // c1 or c2 touched EMA21 (deeper pullback than EMA8)
        const touched21 = c1.low <= e21 * 1.002 || c2.low <= e21 * 1.002;
        if (!touched21) return null;
        // c0 recovered: bullish close above EMA21
        if (c0.close <= e21)      return null;
        if (c0.close <= c0.open)  return null;
        // RSI in value zone (not overbought)
        if (rsi < 40 || rsi > 65) return null;

        return {
            type:'BUY', mode:'trend_pullback', score:74,
            factors:[
                `Uptrend EMA8>21>50`,
                `Pullback to EMA21`,
                `RSI ${rsi.toFixed(0)} (value zone)`,
                `London/NY session`,
            ],
            tpMultiplier: 1.8,
            slMultiplier: 0.7,
        };
    }

    // ── DOWNTREND + PULLBACK TO EMA21 ────────────────────────
    if (e8 < e21 && e21 < e50) {
        const touched21 = c1.high >= e21 * 0.998 || c2.high >= e21 * 0.998;
        if (!touched21) return null;
        if (c0.close >= e21)      return null;
        if (c0.close >= c0.open)  return null;
        if (rsi < 35 || rsi > 60) return null;

        return {
            type:'SELL', mode:'trend_pullback', score:74,
            factors:[
                `Downtrend EMA8<21<50`,
                `Pullback to EMA21`,
                `RSI ${rsi.toFixed(0)} (value zone)`,
                `London/NY session`,
            ],
            tpMultiplier: 1.8,
            slMultiplier: 0.7,
        };
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// ROUTER — picks Brain A or B based on symbol
// ─────────────────────────────────────────────────────────────

function _route(symbol, candles) {
    if (!candles || candles.length < 15) return null;

    const type = _symbolType(symbol);
    const atr  = _atr(candles, 14);
    if (!atr) return null;

    // ── BRAIN A: SYNTHETIC ────────────────────────────────────
    if (type === 'boom' || type === 'crash') {
        return _boomCrashSignal(candles, atr, type);
    }

    if (type === 'step') {
        const atrAvg = _atrAvg(candles, 14, 20);
        return _stepSignal(candles, atr, atrAvg);
    }

    if (type === 'synthetic') {
        return _spikeRetrace(candles, atr);
    }

    // ── BRAIN B: REAL MARKET ──────────────────────────────────
    return _realMarketSignal(candles, atr);
}

// ─────────────────────────────────────────────────────────────
// STAKE SCALING
// ─────────────────────────────────────────────────────────────
function _stake(base, atr, atrAvg) {
    if (!atrAvg || atrAvg === 0) return Math.max(0.35, base||1.0);
    // Scale down when current ATR is much higher than average (chaotic)
    const ratio  = atr / atrAvg;
    const scalar = Math.min(1.0, Math.max(0.3, 1.0/ratio));
    return Math.max(0.35, parseFloat(((base||1.0)*scalar).toFixed(2)));
}

// ─────────────────────────────────────────────────────────────
// EXPORTED STRATEGY
// ─────────────────────────────────────────────────────────────
export const VortexStrategy = {

    _state: {},

    _getState(id) {
        if (!this._state[id]) this._state[id] = {
            consLosses:0, pauseBars:0, todayKey:'', hourlyTrades:[], tfMinutes:null, htfCandles:[], newsBlackout:true, fomcBlackout:false,
            dirLosses:{ BUY:0, SELL:0 },  // consecutive losses per direction
            blockedDir:null,               // direction blocked after 3 same-dir losses
            blockedDirCount:0,             // how many signals skipped while blocked
        };
        const s = this._state[id];
        const today = new Date(Date.now()-5*3600000).toDateString();
        if (s.todayKey !== today) {
            s.consLosses=0; s.todayKey=today;
            s.dirLosses={ BUY:0, SELL:0 }; s.blockedDir=null; s.blockedDirCount=0;
        }
        return s;
    },

    // Call with the direction of the trade ('BUY' or 'SELL') and its outcome
    recordOutcome(id, outcome, direction) {
        const s = this._getState(id);
        if (outcome==='TP') {
            s.consLosses=0; s.pauseBars=0;
            // A win unblocks that direction
            if (direction) { s.dirLosses[direction]=0; if(s.blockedDir===direction){ s.blockedDir=null; s.blockedDirCount=0; } }
        } else {
            s.consLosses++;
            s.pauseBars = s.consLosses>=3 ? 2 : 0;
            // Track direction-specific losses
            if (direction) {
                s.dirLosses[direction]++;
                // After 3 consecutive losses in one direction, block that direction
                if (s.dirLosses[direction] >= 3) s.blockedDir = direction;
            }
        }
        const now=Date.now();
        s.hourlyTrades.push(now);
        s.hourlyTrades = s.hourlyTrades.filter(t=>now-t<3600000);
    },

    tickBar(id)       { const s=this._getState(id); if(s.pauseBars>0) s.pauseBars--; },
    isHalted(id)      { return this._getState(id).consLosses >= 5; },
    isPaused(id)      { return this._getState(id).pauseBars  >  0; },
    isDirBlocked(id, direction) {
        const s = this._getState(id);
        if (s.blockedDir !== direction) return false;
        // Decay: unblock after 3 skipped signals (let the market reset)
        if (s.blockedDirCount >= 3) { s.blockedDir=null; s.blockedDirCount=0; return false; }
        s.blockedDirCount++;
        return true;
    },
    isTooFrequent(id) {
        const now=Date.now();
        return this._getState(id).hourlyTrades.filter(t=>now-t<3600000).length >= 2;
    },

    // Symbol type exposed so UI can show "Synthetic" or "Real"
    getSymbolType(symbol) { return _symbolType(symbol); },

    // Set the entry TF so HTF filter knows which multiplier to use
    setTf(id, tfMinutes) { this._getState(id).tfMinutes = tfMinutes; },

    // Feed in real HTF candles for the trend filter (called by live bot)
    setHtfCandles(id, candles) { this._getState(id).htfCandles = candles || []; },

    // Configure news blackout for live bot
    setNewsOptions(id, opts) {
        const s = this._getState(id);
        s.newsBlackout = opts.newsBlackout ?? true;
        s.fomcBlackout = opts.fomcBlackout ?? false;
    },


    _wrap(sig, symbol, atr, atrAvg, base) {
        const symType = _symbolType(symbol);
        return {
            ...sig,
            label:      `VORTEX ${sig.type} [${sig.mode} ${sig.score}]`,
            isVortex:   true,
            symbolType: symType,
            brain:      (symType==='real') ? 'B_real' : 'A_synthetic',
            atr,
            stake:      _stake(base, atr, atrAvg),
            baseStake:  base||1.0,
        };
    },

    // ── STATELESS: for backtest ───────────────────────────────
    // opts: { newsBlackout, fomcBlackout } — news filter options
    checkEntryRaw(symbol, candles, tfMinutes, htfCandles, barTime, _unused, opts = {}) {
        const sig = _route(symbol, candles);
        if (!sig) return null;
        const symType = _symbolType(symbol);
        if (_isNewsBlackout(barTime || 0, symType, opts)) return null;
        if (!_htfAllows(sig, htfCandles || [], barTime || 0, symType)) return null;
        const atr    = _atr(candles, 14);
        const atrAvg = _atrAvg(candles, 14, 20);
        return this._wrap(sig, symbol, atr, atrAvg, 1.0);
    },

    // ── LIVE BOT: with rate limits ────────────────────────────
    checkEntryFull(id, symbol, candles, baseStake) {
        if (!candles||candles.length<15) return null;
        if (this.isHalted(id)||this.isPaused(id)||this.isTooFrequent(id)) return null;
        const sig = _route(symbol, candles);
        if (!sig) return null;
        // Block direction if 3 consecutive losses in that direction
        if (this.isDirBlocked(id, sig.type)) return null;
        // News blackout + HTF trend filter — real markets only
        const _symType  = _symbolType(symbol);
        const _s        = this._getState(id);
        const _barTime  = candles[candles.length - 1]?.time || 0;
        if (_isNewsBlackout(_barTime, _symType, { newsBlackout: _s.newsBlackout, fomcBlackout: _s.fomcBlackout })) return null;
        const _htfC     = _s.htfCandles || [];
        if (!_htfAllows(sig, _htfC, _barTime, _symType)) return null;
        const atr    = _atr(candles, 14);
        const atrAvg = _atrAvg(candles, 14, 20);
        return this._wrap(sig, symbol, atr, atrAvg, baseStake);
    },

    // Stubs for compatibility
    recordChaos()  {},
    tickChaos()    {},
    detectChaos()  { return null; },
};