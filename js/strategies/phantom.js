// phantom.js — PHANTOM Scalper v3
// Fixed: removed signal conflict between trend-following and mean-reversion.
// Now uses a two-mode system:
//   TREND mode  — EMA aligned + momentum. RSI used as confirmation (>50 for BUY, <50 for SELL).
//   PULLBACK mode — EMA aligned but price pulled back to EMA. RSI must be recovering.
// BB touch is now a FILTER (avoid entries at extremes) not a vote source.

const _sessionKey = 'phantom_session';

function _loadSession() {
    try {
        const raw = localStorage.getItem(_sessionKey);
        if (!raw) return _freshSession();
        const s = JSON.parse(raw);
        const todayEST = new Date(Date.now() - 5 * 3600000).toDateString();
        if (s.date !== todayEST) return _freshSession();
        return s;
    } catch { return _freshSession(); }
}

function _freshSession() {
    return {
        date:         new Date(Date.now() - 5 * 3600000).toDateString(),
        profitTarget: 0,
        lossLimit:    0,
        realizedPnL:  0,
        trades:       0,
        wins:         0,
        losses:       0,
        mode:         'active',
        configured:   false,
    };
}

function _saveSession(s) {
    try { localStorage.setItem(_sessionKey, JSON.stringify(s)); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────────────────────
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let v = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) v = candles[i].close * k + v * (1 - k);
    return v;
}

function _rsi(candles, period = 14) {
    if (candles.length < period + 2) return null;
    const cl = candles.slice(-(period + 1)).map(c => c.close);
    let g = 0, l = 0;
    for (let i = 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function _atr(candles, period = 10) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _bb(candles, period = 20) {
    if (candles.length < period) return null;
    const sl   = candles.slice(-period);
    const mean = sl.reduce((a, c) => a + c.close, 0) / period;
    const std  = Math.sqrt(sl.reduce((a, c) => a + (c.close - mean) ** 2, 0) / period);
    return { upper: mean + 2 * std, lower: mean - 2 * std, mid: mean, std };
}

function _engulf(prev, curr) {
    if (!prev || !curr) return { bull: false, bear: false };
    const pBull = prev.close > prev.open;
    const cBull = curr.close > curr.open;
    return {
        bull: !pBull && cBull && curr.close > prev.open && curr.open < prev.close,
        bear:  pBull && !cBull && curr.close < prev.open && curr.open > prev.close,
    };
}

// ─────────────────────────────────────────────────────────────
// SINGLE-TF SIGNAL  — v3 clean logic
// Two entry modes, no contradicting signals
// ─────────────────────────────────────────────────────────────
function _signalOnTF(candles, tfLabel) {
    if (candles.length < 30) return null;

    const cl  = candles.slice(0, -1);
    const c0  = cl[cl.length - 1];
    const c1  = cl[cl.length - 2];
    const c2  = cl[cl.length - 3];
    const c3  = cl[cl.length - 4];
    if (!c0 || !c1 || !c2 || !c3) return null;

    const rsiVal  = _rsi(cl);
    const rsiPrev = _rsi(cl.slice(0, -1)); // RSI one bar ago — for rising/falling check
    const ema8    = _ema(cl, 8);
    const ema8p   = _ema(cl.slice(0, -3), 8); // EMA8 three bars ago — slope check
    const ema21   = _ema(cl, 21);
    const ema50   = _ema(cl, 50);
    const bbVal   = _bb(cl, 20);
    const atrVal  = _atr(cl, 10);

    if (!rsiVal || !rsiPrev || !ema8 || !ema8p || !ema21 || !ema50 || !bbVal || !atrVal) return null;

    // ── FILTER: skip if price is at BB extreme (risk of reversal against us) ──
    const atBBUpper = c0.high >= bbVal.upper;
    const atBBLower = c0.low  <= bbVal.lower;

    const { bull: engBull, bear: engBear } = _engulf(c1, c0);

    // EMA8 slope — is the fast EMA itself accelerating in trend direction?
    const ema8SlopeUp   = ema8 > ema8p;   // EMA8 rising over last 3 bars
    const ema8SlopeDown = ema8 < ema8p;   // EMA8 falling over last 3 bars

    // RSI momentum direction
    const rsiRising  = rsiVal > rsiPrev;
    const rsiFalling = rsiVal < rsiPrev;

    // ── TREND MODE ────────────────────────────────────────────
    // FIX: BUY now requires c0.close <= ema8 * 1.002 — enter AT the EMA8,
    // not after price has already pushed above it (mirrors SELL logic).
    // Also requires EMA8 slope up + RSI rising to confirm momentum is real.

    const trendBuy =
        ema8   > ema21 &&
        ema21  > ema50 &&                         // full EMA stack aligned up
        c0.close > ema8 &&                        // price above fast EMA
        rsiVal > 50 && rsiVal < 75 &&             // RSI confirms momentum, not overbought
        !atBBUpper &&
        (engBull || (c0.close > c1.close && c1.close > c2.close));

    const trendSell =
        ema8   < ema21 &&
        ema21  < ema50 &&                         // full EMA stack aligned down
        c0.close < ema8 &&                        // price below fast EMA
        rsiVal < 55 && rsiVal > 25 &&             // RSI confirms momentum, not oversold
        !atBBLower &&
        (engBear || (c0.close < c1.close && c1.close < c2.close));

    // ── PULLBACK MODE ─────────────────────────────────────────
    // Trend is established, price pulled back to EMA8, now bouncing.
    // BUY pullback: price dipped to/below EMA8, now engulfing back up.
    // No change needed here — pullback already enters at EMA8 level.

    const pullbackBuy =
        ema8   > ema21 &&
        ema21  > ema50 &&                         // trend is up
        c0.close > ema8 &&                        // price back above EMA8
        c1.close <= ema8 * 1.001 &&              // previous bar was at/below EMA8 (the pullback)
        rsiVal > 42 && rsiVal < 65 &&            // RSI recovering
        rsiRising &&                              // RSI must be turning up (FIX)
        !atBBUpper &&
        engBull;                                  // engulf confirms the bounce

    const pullbackSell =
        ema8   < ema21 &&
        ema21  < ema50 &&                         // trend is down
        c0.close < ema8 &&                        // price back below EMA8
        c1.close >= ema8 * 0.999 &&              // previous bar was at/above EMA8 (the pullback)
        rsiVal < 58 && rsiVal > 35 &&            // RSI recovering from pullback
        !atBBLower &&
        engBear;                                  // engulf confirms the rejection

    // ── SCORE AND RETURN ─────────────────────────────────────
    if (trendBuy || pullbackBuy) {
        const mode    = trendBuy ? 'trend' : 'pullback';
        const factors = [`${tfLabel} EMA↑`, `${tfLabel} RSI ${rsiVal.toFixed(0)}`];
        if (engBull)      factors.push(`${tfLabel} engulf↑`);
        if (pullbackBuy)  factors.push(`${tfLabel} EMA bounce`);
        if (ema21 > ema50) factors.push(`${tfLabel} EMA50↑`);
        return { dir: 'BUY',  count: factors.length, factors, atr: atrVal, mode };
    }

    if (trendSell || pullbackSell) {
        const mode    = trendSell ? 'trend' : 'pullback';
        const factors = [`${tfLabel} EMA↓`, `${tfLabel} RSI ${rsiVal.toFixed(0)}`];
        if (engBear)      factors.push(`${tfLabel} engulf↓`);
        if (pullbackSell) factors.push(`${tfLabel} EMA reject`);
        if (ema21 < ema50) factors.push(`${tfLabel} EMA50↓`);
        return { dir: 'SELL', count: factors.length, factors, atr: atrVal, mode };
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// REVERSAL DETECTOR  (early exit trigger)
// ─────────────────────────────────────────────────────────────
export function PhantomReversalCheck(candles, openSignal, rsi) {
    if (!openSignal || candles.length < 3) return false;
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const { bull, bear } = _engulf(c1, c2);
    // Only exit on reversal if RSI confirms the turn
    if (openSignal.type === 'BUY')  return bear && (rsi !== null && rsi < 45);
    if (openSignal.type === 'SELL') return bull && (rsi !== null && rsi > 55);
    return false;
}

// ─────────────────────────────────────────────────────────────
// PHANTOM STRATEGY
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// HTF TREND FILTER  (same logic as VORTEX Brain B)
// Uses EMA21 slope on HTF candles vs ATR threshold
// flat = allow, only blocks when HTF actively opposes signal
// Works on both real markets and synthetics
// ─────────────────────────────────────────────────────────────

function _htfEma(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let v = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) v = candles[i].close * k + v * (1 - k);
    return v;
}

function _htfAtr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = candles.length - period - 1; i < candles.length; i++) {
        if (i < 1) continue;
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

// Slice HTF candles up to (but not exceeding) barTime
function _htfSlice(htfCandles, barTime) {
    if (!htfCandles || !htfCandles.length) return [];
    let hi = htfCandles.length - 1;
    while (hi >= 0 && htfCandles[hi].time > barTime) hi--;
    return htfCandles.slice(0, hi + 1);
}

// Returns 'up', 'down', or 'flat'
function _htfTrend(htfCandles) {
    if (!htfCandles || htfCandles.length < 25) return 'flat';
    const now  = _htfEma(htfCandles, 21);
    const prev = _htfEma(htfCandles.slice(0, -3), 21); // 3 HTF bars ago
    if (!now || !prev) return 'flat';
    const htfAtr = _htfAtr(htfCandles, 14);
    if (!htfAtr) return 'flat';
    const change    = now - prev;
    const threshold = htfAtr * 0.05; // 5% of HTF ATR = meaningful slope
    if (change >  threshold) return 'up';
    if (change < -threshold) return 'down';
    return 'flat';
}

// Returns true if HTF allows the signal (flat = allow, only block opposition)
function _htfAllows(signalDir, htfCandles, barTime) {
    if (!htfCandles || !htfCandles.length) return true; // no HTF data → allow
    const slice = _htfSlice(htfCandles, barTime);
    const trend = _htfTrend(slice);
    if (trend === 'flat')                              return true;
    if (signalDir === 'BUY'  && trend === 'down')      return false;
    if (signalDir === 'SELL' && trend === 'up')        return false;
    return true;
}

// ─────────────────────────────────────────────────────────────
// DIRECTION BLOCK STATE  (per-bot, same logic as VORTEX)
// After 3 consecutive losses in same direction → block it
// Decays after 3 skipped signals in that direction
// ─────────────────────────────────────────────────────────────
const _phantomDirState = {};
const _phantomHtfCandles = {};

function _pdState(id) {
    if (!_phantomDirState[id]) _phantomDirState[id] = {
        losses: { BUY: 0, SELL: 0 },
        blockedDir: null, blockedCount: 0,
    };
    return _phantomDirState[id];
}

export const PhantomStrategy = {

    getSession:  _loadSession,
    saveSession: _saveSession,

    configureSession(profitTarget, lossLimit) {
        const s = _loadSession();
        s.profitTarget = parseFloat(profitTarget) || 0;
        s.lossLimit    = Math.abs(parseFloat(lossLimit)) || 0;
        s.configured   = true;
        s.mode         = 'active';
        _saveSession(s);
        return s;
    },

    resetSession() {
        const s = _freshSession();
        _saveSession(s);
        return s;
    },

    // ── HTF STATE MANAGEMENT ─────────────────────────────────
    setHtfCandles(botId, candles) {
        _phantomHtfCandles[botId] = candles || [];
    },

    getHtfCandles(botId) {
        return _phantomHtfCandles[botId] || [];
    },

    resetDirState(botId = '_bt') {
        _phantomDirState[botId] = { losses: { BUY: 0, SELL: 0 }, blockedDir: null, blockedCount: 0 };
        _phantomHtfCandles[botId] = [];
    },

    // ── DIRECTION BLOCK ──────────────────────────────────────
    isDirBlocked(botId, dir) {
        const s = _pdState(botId);
        if (s.blockedDir !== dir) return false;
        if (s.blockedCount >= 3) { s.blockedDir = null; s.blockedCount = 0; return false; }
        s.blockedCount++;
        return true;
    },

    recordOutcome(botId, dir, outcome) {
        const s = _pdState(botId);
        if (outcome === 'TP') {
            s.losses[dir] = 0;
            if (s.blockedDir === dir) { s.blockedDir = null; s.blockedCount = 0; }
        } else {
            s.losses[dir]++;
            if (s.losses[dir] >= 3) { s.blockedDir = dir; s.blockedCount = 0; }
        }
    },

    recordTrade(botId, outcome, pnlAmt) {
        const s = _loadSession();
        if (s.mode === 'halted') return s;
        s.realizedPnL += outcome === 'TP' ? pnlAmt : -pnlAmt;
        s.trades++;
        outcome === 'TP' ? s.wins++ : s.losses++;
        if (s.profitTarget > 0 && s.realizedPnL >= s.profitTarget) s.mode = 'observer';
        else if (s.lossLimit > 0 && s.realizedPnL <= -s.lossLimit)  s.mode = 'halted';
        _saveSession(s);
        return s;
    },

    getMode() { return _loadSession().mode; },

    // ── BACKTEST ENTRY — bypasses session state ───────────────
    // htfCandles + barTime enable the HTF trend filter in backtest.
    checkEntryRaw(m1Candles, m5Candles, m15Candles, botId = '_bt', htfCandles = [], barTime = 0) {
        const results = [];
        if (m5Candles?.length  >= 30) { const r = _signalOnTF(m5Candles,  'M5');  if (r) results.push({ ...r, tf: 'M5',  weight: 2 }); }
        if (m15Candles?.length >= 30) { const r = _signalOnTF(m15Candles, 'M15'); if (r) results.push({ ...r, tf: 'M15', weight: 2 }); }
        if (m1Candles?.length  >= 30) { const r = _signalOnTF(m1Candles,  'M1');  if (r) results.push({ ...r, tf: 'M1',  weight: 1 }); }

        if (results.length === 0) return null;

        const buyVotes   = results.filter(r => r.dir === 'BUY');
        const sellVotes  = results.filter(r => r.dir === 'SELL');
        const buyWeight  = buyVotes.reduce((a, r)  => a + r.weight, 0);
        const sellWeight = sellVotes.reduce((a, r) => a + r.weight, 0);

        // Require M5+M15 agreement (weight ≥ 4). M1 alone is never enough.
        const winner = buyWeight  >= 4 && buyWeight  > sellWeight ? buyVotes
                     : sellWeight >= 4 && sellWeight > buyWeight  ? sellVotes
                     : null;
        if (!winner) return null;

        const dir         = winner[0].dir;
        const tfCount     = winner.length;
        const allFactors  = [...new Set(winner.flatMap(r => r.factors))];
        const bestATR     = winner.reduce((a, r) => Math.max(a, r.atr || 0), 0);
        const tfNames     = winner.map(r => r.tf).join('+');
        const hasPullback = winner.some(r => r.mode === 'pullback');
        const hasEngulf   = allFactors.some(f => f.includes('engulf'));

        const score = Math.min(100,
            50 + (tfCount - 2) * 15 + (hasPullback ? 10 : 0) + (hasEngulf ? 10 : 0)
            + winner.reduce((a, r) => a + r.count * 2, 0)
        );

        // HTF trend filter — block signals opposing the higher timeframe trend
        if (!_htfAllows(dir, htfCandles, barTime)) return null;

        // Direction block: skip if this direction has 3 consecutive losses
        if (this.isDirBlocked(botId, dir)) return null;

        return {
            type:         dir,
            label:        `PHANTOM ${dir} [${tfNames} ${score}]`,
            score,
            factors:      allFactors,
            tfCount,
            tfNames,
            tpMultiplier: hasPullback ? 2.5 : 2.0,
            slMultiplier: 1.0,
            isPhantom:    true,
            atr:          bestATR || null,
        };
    },

    // ── LIVE ENTRY — checks session state ────────────────────
    checkEntry(m1Candles, m5Candles, m15Candles, botId = 'default') {
        const session = _loadSession();
        if (session.mode !== 'active') return null;

        const results = [];
        if (m5Candles?.length  >= 30) { const r = _signalOnTF(m5Candles,  'M5');  if (r) results.push({ ...r, tf: 'M5',  weight: 2 }); }
        if (m15Candles?.length >= 30) { const r = _signalOnTF(m15Candles, 'M15'); if (r) results.push({ ...r, tf: 'M15', weight: 2 }); }
        if (m1Candles?.length  >= 30) { const r = _signalOnTF(m1Candles,  'M1');  if (r) results.push({ ...r, tf: 'M1',  weight: 1 }); }

        if (results.length === 0) return null;

        const buyVotes   = results.filter(r => r.dir === 'BUY');
        const sellVotes  = results.filter(r => r.dir === 'SELL');
        const buyWeight  = buyVotes.reduce((a, r)  => a + r.weight, 0);
        const sellWeight = sellVotes.reduce((a, r) => a + r.weight, 0);

        // M5+M15 must agree (weight ≥ 4). M1 alone is never enough.
        const winner = buyWeight  >= 4 && buyWeight  > sellWeight ? buyVotes
                     : sellWeight >= 4 && sellWeight > buyWeight  ? sellVotes
                     : null;
        if (!winner) return null;

        const dir        = winner[0].dir;
        const tfCount    = winner.length;
        const allFactors = [...new Set(winner.flatMap(r => r.factors))];
        const bestATR    = winner.reduce((a, r) => Math.max(a, r.atr || 0), 0);
        const tfNames    = winner.map(r => r.tf).join('+');
        const hasPullback = winner.some(r => r.mode === 'pullback');
        const hasEngulf   = allFactors.some(f => f.includes('engulf'));

        const score = Math.min(100,
            50                              // base — requires 2 TFs
            + (tfCount - 2) * 15            // +15 for third TF
            + (hasPullback ? 10 : 0)        // pullback entries are higher quality
            + (hasEngulf   ? 10 : 0)
            + winner.reduce((a, r) => a + r.count * 2, 0)
        );

        // HTF trend filter — uses candles stored by setHtfCandles()
        const _liveHtf = this.getHtfCandles(botId);
        const _barTime = m5Candles?.[m5Candles.length - 1]?.time || 0;
        if (!_htfAllows(dir, _liveHtf, _barTime)) return null;

        // Direction block check
        if (this.isDirBlocked(botId, dir)) return null;

        return {
            type:         dir,
            label:        `PHANTOM ${dir} [${tfNames} ${score}]`,
            score,
            factors:      allFactors,
            tfCount,
            tfNames,
            tpMultiplier: hasPullback ? 2.5 : 2.0,  // pullback entries get bigger TP
            slMultiplier: 1.0,
            isPhantom:    true,
            atr:          bestATR || null,
        };
    },
};