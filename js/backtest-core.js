// js/backtest-core.js  v2
// One engine. Correct PnL. Real numbers. Overfit detection built in.
//
// PnL MODEL (Deriv):
//   WIN:  +stake × tpMultiplier
//   LOSS: -stake × slMultiplier
//   This is how Deriv digital options/CFDs work — you stake an amount
//   and get back a multiple. NOT price_distance × stake.

const WS_URL    = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const CHUNK_SIZE  = 1500;
const CHUNK_DELAY = 800;
export { WS_URL, CHUNK_SIZE, CHUNK_DELAY };

// ─────────────────────────────────────────────────────────────
// CANDLE FETCHING
// ─────────────────────────────────────────────────────────────
export async function _fetchCandles(symbol, granularity, count, onProgress) {
    if (count <= CHUNK_SIZE) {
        return _fetchChunk(symbol, granularity, count, 'latest');
    }
    const chunks = [];
    let remaining = count;
    let endTime   = 'latest';
    while (remaining > 0) {
        const chunkSize = Math.min(remaining, CHUNK_SIZE);
        const batch     = await _fetchChunk(symbol, granularity, chunkSize, endTime);
        if (!batch.length) break;
        chunks.unshift(batch);
        remaining -= batch.length;
        endTime    = batch[0].time - 1;
        if (onProgress) onProgress(count - remaining, count);
        if (remaining > 0) await _sleep(CHUNK_DELAY);
    }
    const merged = chunks.flat();
    const seen   = new Set();
    return merged
        .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
        .sort((a, b) => a.time - b.time);
}

export function _fetchChunk(symbol, granularity, count, end) {
    return new Promise((resolve, reject) => {
        const ws      = new WebSocket(WS_URL);
        let resolved  = false;
        const payload = {
            ticks_history: symbol, granularity,
            count, style: 'candles', adjust_start_time: 1,
            end: end === 'latest' ? 'latest' : end,
        };
        ws.onopen    = () => ws.send(JSON.stringify(payload));
        ws.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            if (msg.error)   { reject(new Error(msg.error.message)); ws.close(); return; }
            if (msg.candles) {
                resolved = true; ws.close();
                resolve(msg.candles.map(c => ({
                    time: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
                })));
            }
        };
        ws.onerror = () => reject(new Error('WebSocket error'));
        ws.onclose = () => { if (!resolved) reject(new Error('Connection closed')); };
        setTimeout(() => { if (!resolved) { ws.close(); reject(new Error('Timeout')); } }, 25000);
    });
}

// ─────────────────────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────────────────────
export function _calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = candles.slice(-period - 1);
    const vals = [];
    for (let i = 1; i < trs.length; i++) {
        const c = trs[i], p = trs[i - 1];
        vals.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function _calcRSI(candles, state, period = 14) {
    if (candles.length < 2) return 50;
    const d = candles[candles.length - 1].close - candles[candles.length - 2].close;
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (!state.initialized) { state.prevAvgGain = g; state.prevAvgLoss = l; state.initialized = true; }
    const k = 1 / period;
    state.prevAvgGain = state.prevAvgGain * (1 - k) + g * k;
    state.prevAvgLoss = state.prevAvgLoss * (1 - k) + l * k;
    if (state.prevAvgLoss === 0) return 100;
    return 100 - 100 / (1 + state.prevAvgGain / state.prevAvgLoss);
}

export function _tfLabel(tf) {
    return { 60:'M1', 300:'M5', 900:'M15', 1800:'M30', 3600:'H1', 14400:'H4' }[tf] || tf;
}

export function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// STATS  (shared by simulate + walk-forward)
// ─────────────────────────────────────────────────────────────
export function _calcStats(trades, equity) {
    const closed = trades.filter(t => t.outcome === 'TP' || t.outcome === 'SL');
    if (!closed.length) return _emptyStats();

    const wins   = closed.filter(t => t.outcome === 'TP');
    const losses = closed.filter(t => t.outcome === 'SL');
    const gw     = wins.reduce((a, t) => a + (t.pnl || 0), 0);
    const gl     = Math.abs(losses.reduce((a, t) => a + (t.pnl || 0), 0));
    const wr     = wins.length / closed.length;
    const avgW   = wins.length   ? gw / wins.length   : 0;
    const avgL   = losses.length ? gl / losses.length : 0;
    const pf     = gl > 0 ? gw / gl : (wins.length > 0 ? 999 : 0);
    const net    = gw - gl;

    // R:R from actual multipliers stored on trades
    const rrVals = closed.map(t => t.tpMult && t.slMult ? t.tpMult / t.slMult : 0).filter(r => r > 0);
    const avgRR  = rrVals.length ? rrVals.reduce((a, b) => a + b, 0) / rrVals.length : 1.5;

    // Max drawdown from equity curve
    let maxDD = 0, peak = -Infinity;
    for (const v of equity) {
        if (v > peak) peak = v;
        if (peak - v > maxDD) maxDD = peak - v;
    }

    // Max consecutive losses
    let streak = 0, maxStreak = 0;
    for (const t of closed) {
        if (t.outcome === 'SL') { streak++; maxStreak = Math.max(maxStreak, streak); }
        else streak = 0;
    }

    const expectancy = wr * avgW - (1 - wr) * avgL;

    return {
        total: closed.length, wins: wins.length, losses: losses.length,
        winRate: wr, profitFactor: pf, netPnL: net,
        grossWin: gw, grossLoss: gl, avgWin: avgW, avgLoss: avgL,
        maxDD, avgRR, maxStreak, expectancy,
    };
}

function _emptyStats() {
    return {
        total:0, wins:0, losses:0, winRate:0, profitFactor:0, netPnL:0,
        grossWin:0, grossLoss:0, avgWin:0, avgLoss:0,
        maxDD:0, avgRR:0, maxStreak:0, expectancy:0,
    };
}

// ─────────────────────────────────────────────────────────────
// OVERFIT DETECTION
// Compares in-sample (IS) to out-of-sample (OOS) performance.
// Real edge degrades gracefully. Overfit collapses in OOS.
// ─────────────────────────────────────────────────────────────
export function _detectOverfit(isStats, oosStats) {
    const warnings = [];
    let   score    = 100; // starts perfect, deductions applied

    // 1. OOS win rate vs IS win rate
    const wrDrop = isStats.winRate - oosStats.winRate;
    if (wrDrop > 0.20) { warnings.push(`Win rate drops ${(wrDrop*100).toFixed(0)}% in OOS (IS: ${(isStats.winRate*100).toFixed(0)}% → OOS: ${(oosStats.winRate*100).toFixed(0)}%)`); score -= 30; }
    else if (wrDrop > 0.10) { warnings.push(`Win rate drops ${(wrDrop*100).toFixed(0)}% in OOS`); score -= 15; }

    // 2. OOS profit factor vs IS
    const pfRatio = isStats.profitFactor > 0 ? oosStats.profitFactor / isStats.profitFactor : 0;
    if (pfRatio < 0.5 && isStats.profitFactor > 1) { warnings.push(`OOS profit factor is ${(pfRatio*100).toFixed(0)}% of IS (severe degradation)`); score -= 30; }
    else if (pfRatio < 0.7 && isStats.profitFactor > 1) { warnings.push(`OOS profit factor degrades significantly vs IS`); score -= 15; }

    // 3. OOS net PnL negative when IS was positive
    if (isStats.netPnL > 0 && oosStats.netPnL < 0) { warnings.push('Strategy profitable in IS but loses money in OOS'); score -= 25; }

    // 4. Too few trades — unreliable stats
    if (oosStats.total < 10) { warnings.push(`Only ${oosStats.total} trades in OOS — results not statistically reliable`); score -= 20; }
    if (isStats.total < 15)  { warnings.push(`Only ${isStats.total} trades in IS — increase candle count for reliable results`); score -= 10; }

    // 5. IS win rate suspiciously high
    if (isStats.winRate > 0.85 && isStats.total > 20) { warnings.push(`IS win rate ${(isStats.winRate*100).toFixed(0)}% is suspiciously high — possible overfit`); score -= 15; }

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';

    return {
        score:    Math.max(0, score),
        grade,
        color:    score >= 80 ? '#10b981' : score >= 65 ? '#34d399' : score >= 50 ? '#a78bfa' : score >= 35 ? '#f59e0b' : '#ef4444',
        warnings,
        isOverfit: score < 50,
        verdict:   score >= 80 ? 'No overfit detected — edge looks real'
                 : score >= 65 ? 'Mild degradation — acceptable'
                 : score >= 50 ? 'Moderate overfit risk — test on more data'
                 : score >= 35 ? 'Likely overfit — do not use live'
                 :               'SEVERE OVERFIT — results are meaningless',
    };
}

// ─────────────────────────────────────────────────────────────
// CORE SIMULATION ENGINE
// Works for ALL strategies. Correct PnL formula throughout.
// strategyFn: function(candles, atr, symbol) → signal | null
// signal = { type:'BUY'|'SELL', tpMultiplier, slMultiplier }
// ─────────────────────────────────────────────────────────────
export function _simulate(candles, h4Candles, strategyObj, stake = 1, commission = 0, symbol = '') {
    const trades   = [];
    const equity   = [0];
    let   running  = 0;
    let   open     = null;
    let   lastFired= 0;
    const rsiState = { prevAvgGain: 0, prevAvgLoss: 0, initialized: false };
    const WARMUP   = 50;

    for (let i = WARMUP; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const bar   = slice[slice.length - 1];

        // ── Manage open trade ─────────────────────────────────
        if (open) {
            const { type, sl, tp, slMult, tpMult, stakeAmt } = open;
            let hit = null;
            if (type === 'BUY') {
                if      (bar.low  <= sl) hit = 'SL';
                else if (bar.high >= tp) hit = 'TP';
            } else {
                if      (bar.high >= sl) hit = 'SL';
                else if (bar.low  <= tp) hit = 'TP';
            }
            if (hit) {
                // CORRECT PnL: stake × multiplier, not price distance
                const pnl = hit === 'TP'
                    ? stakeAmt * tpMult - commission
                    : -(stakeAmt * slMult) - commission;
                running += pnl;
                const t = trades[trades.length - 1];
                t.outcome = hit; t.exit = bar.close; t.pnl = pnl;
                t.tpMult = tpMult; t.slMult = slMult;
                equity.push(running);
                open = null;
                continue;
            }
            equity.push(running);
            continue;
        }

        if (i - lastFired < 2) { equity.push(running); continue; }
        if (!strategyObj)      { equity.push(running); continue; }

        const atr = _calcATR(slice, 14);
        const rsi = _calcRSI(slice, rsiState);
        const h4s = h4Candles ? h4Candles.filter(c => c.time <= bar.time) : [];

        let signal = null;
        try {
            signal = strategyObj.analyze('__bt__', slice, h4s, rsiState, atr, symbol, rsi);
        } catch(e) { /* skip */ }

        if (!signal) { equity.push(running); continue; }

        const type   = signal.type;
        const slMult = signal.slMultiplier || 1.0;
        const tpMult = signal.tpMultiplier || 2.0;
        const slDist = atr ? atr * slMult : bar.close * 0.001;
        const tpDist = atr ? atr * tpMult : bar.close * 0.002;
        const sl     = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
        const tp     = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

        open = { type, entry: bar.close, sl, tp, slMult, tpMult, stakeAmt: stake };
        lastFired = i;
        trades.push({ time: bar.time, barIdx: i, type, entry: bar.close, sl, tp, outcome: null, exit: null, pnl: null, tpMult, slMult });
        equity.push(running);
    }

    // Force-close open trade at last bar
    if (open) {
        const last = candles[candles.length - 1];
        const move = open.type === 'BUY' ? last.close - open.entry : open.entry - last.close;
        const slD  = Math.abs(open.entry - open.sl);
        const pnl  = slD > 0 ? (move / slD) * open.slMult * stake - commission : 0;
        running += pnl;
        const t = trades[trades.length - 1];
        t.outcome = 'OPEN'; t.exit = last.close; t.pnl = pnl;
        t.tpMult = open.tpMult; t.slMult = open.slMult;
        equity.push(running);
    }

    return { trades, equity, stats: _calcStats(trades, equity) };
}

// ─────────────────────────────────────────────────────────────
// WALK-FORWARD  (IS + OOS split, overfit check)
// ─────────────────────────────────────────────────────────────
export function _walkForward(candles, h4Candles, strategyObj, stake, commission, symbol) {
    const splitIdx  = Math.floor(candles.length * 0.6); // 60% IS / 40% OOS
    const splitTime = candles[splitIdx].time;
    const isC       = candles.slice(0, splitIdx);
    const oosC      = candles.slice(splitIdx);
    const isH4      = h4Candles ? h4Candles.filter(c => c.time <= splitTime) : [];
    const oosH4     = h4Candles ? h4Candles.filter(c => c.time >  splitTime) : [];

    const isRes  = _simulate(isC,  isH4,  strategyObj, stake, commission, symbol);
    const oosRes = _simulate(oosC, oosH4, strategyObj, stake, commission, symbol);
    const overfit = _detectOverfit(isRes.stats, oosRes.stats);

    return {
        splitIdx, splitTime,
        is:      { trades: isRes.trades,  equity: isRes.equity,  stats: isRes.stats  },
        oos:     { trades: oosRes.trades, equity: oosRes.equity, stats: oosRes.stats },
        overfit,
        // Legacy field names expected by render functions
        confidence: overfit,
    };
}

// ─────────────────────────────────────────────────────────────
// MULTI-TF PHANTOM SIMULATION  (unchanged logic, correct PnL)
// ─────────────────────────────────────────────────────────────
export async function _simulatePhantomMultiTF(
    m1Candles, m5Candles, m15Candles,
    stake = 1, commission = 0,
    phantomStrategy = null,
    onProgress = null,
    htfCandles = []
) {
    const trades  = [];
    const equity  = [0];
    let   running = 0;
    let   open    = null;
    let   lastFired = 0;
    const WARMUP  = 90;

    // Reset direction block state for clean backtest run
    if (phantomStrategy?.recordOutcome) {
        phantomStrategy.recordOutcome('_bt', 'BUY',  'TP');
        phantomStrategy.recordOutcome('_bt', 'SELL', 'TP');
    }

    const m1s  = [...m1Candles].sort((a, b) => a.time - b.time);
    const m15s = [...m15Candles].sort((a, b) => a.time - b.time);

    function _upperIdx(arr, t) {
        let lo = 0, hi = arr.length - 1, res = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].time <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return res;
    }

    for (let i = WARMUP; i < m5Candles.length; i++) {
        const bar   = m5Candles[i];
        const m5s   = m5Candles.slice(0, i + 1);
        const m1sl  = m1s.slice(0, _upperIdx(m1s, bar.time) + 1);
        const m15sl = m15s.slice(0, _upperIdx(m15s, bar.time) + 1);

        if (onProgress && i % 100 === 0) { onProgress(i, m5Candles.length); await _sleep(4); }

        if (open) {
            const { type, sl, tp, slMult, tpMult } = open;
            let hit = null;
            if (type === 'BUY') { if (bar.low <= sl) hit = 'SL'; else if (bar.high >= tp) hit = 'TP'; }
            else                { if (bar.high >= sl) hit = 'SL'; else if (bar.low  <= tp) hit = 'TP'; }
            if (hit) {
                const pnl = hit === 'TP' ? stake * tpMult - commission : -(stake * slMult) - commission;
                running += pnl;
                const t = trades[trades.length - 1];
                t.outcome = hit; t.exit = bar.close; t.pnl = pnl; t.tpMult = tpMult; t.slMult = slMult;
                if (phantomStrategy?.recordOutcome) phantomStrategy.recordOutcome('_bt', t.type, hit);
                equity.push(running); open = null; continue;
            }
            equity.push(running); continue;
        }

        if (i - lastFired < 2) { equity.push(running); continue; }

        let signal = null;
        try {
            if (phantomStrategy) signal = phantomStrategy.checkEntryRaw(m1sl, m5s, m15sl, '_bt', htfCandles, bar.time);
        } catch(e) { console.warn('[PHANTOM BT] bar', i, e.message); }

        if (!signal) { equity.push(running); continue; }

        const atr    = _calcATR(m5s, 14);
        const slMult = signal.slMultiplier || 1.0;
        const tpMult = signal.tpMultiplier || 2.0;
        const slDist = atr ? atr * slMult : bar.close * 0.001;
        const tpDist = atr ? atr * tpMult : bar.close * 0.002;
        const sl     = signal.type === 'BUY' ? bar.close - slDist : bar.close + slDist;
        const tp     = signal.type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

        open = { type: signal.type, entry: bar.close, sl, tp, slMult, tpMult };
        lastFired = i;
        trades.push({ time: bar.time, barIdx: i, type: signal.type, entry: bar.close, sl, tp, outcome: null, exit: null, pnl: null, tpMult, slMult, factors: signal.factors, score: signal.score });
        equity.push(running);
    }

    if (open) {
        const last = m5Candles[m5Candles.length - 1];
        const move = open.type === 'BUY' ? last.close - open.entry : open.entry - last.close;
        const slD  = Math.abs(open.entry - open.sl);
        const pnl  = slD > 0 ? (move / slD) * open.slMult * stake - commission : 0;
        running += pnl;
        const t = trades[trades.length - 1];
        t.outcome = 'OPEN'; t.exit = last.close; t.pnl = pnl; t.tpMult = open.tpMult; t.slMult = open.slMult;
        equity.push(running);
    }

    return { trades, equity, stats: _calcStats(trades, equity) };
}

// ─────────────────────────────────────────────────────────────
// VORTEX SIMULATION  (volatility-aware, any symbol)
// ─────────────────────────────────────────────────────────────
export async function _simulateVortex(candles, stake = 1, commission = 0, symbol = '', onProgress = null, VortexStrategy = null, tfMinutes = null, htfCandles = [], newsBlackout = true, fomcBlackout = false) {
    if (!VortexStrategy) throw new Error('VortexStrategy must be passed to _simulateVortex');

    const trades   = [];
    const equity   = [0];
    let   running  = 0;
    let   open     = null;
    let   lastFired= 0;
    const WARMUP   = 35; // need 35 bars for ATR baseline

    // Simulate direction block (mirrors live bot VortexStrategy state)
    const _ds = { losses:{ BUY:0, SELL:0 }, blockedDir:null, blockedCount:0 };
    function _dirBlocked(dir) {
        if (_ds.blockedDir !== dir) return false;
        if (_ds.blockedCount >= 3) { _ds.blockedDir=null; _ds.blockedCount=0; return false; }
        _ds.blockedCount++; return true;
    }
    function _dirRecord(dir, outcome) {
        if (outcome === 'TP') {
            _ds.losses[dir]=0;
            if (_ds.blockedDir===dir) { _ds.blockedDir=null; _ds.blockedCount=0; }
        } else {
            _ds.losses[dir]++;
            if (_ds.losses[dir] >= 3) { _ds.blockedDir=dir; _ds.blockedCount=0; }
        }
    }

    for (let i = WARMUP; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const bar   = slice[slice.length - 1];

        if (onProgress && i % 100 === 0) { onProgress(i, candles.length); await _sleep(4); }

        if (open) {
            const { type, sl, tp, slMult, tpMult } = open;
            let hit = null;
            if (type === 'BUY') { if (bar.low <= sl) hit = 'SL'; else if (bar.high >= tp) hit = 'TP'; }
            else                { if (bar.high >= sl) hit = 'SL'; else if (bar.low  <= tp) hit = 'TP'; }
            if (hit) {
                const pnl = hit === 'TP' ? stake * tpMult - commission : -(stake * slMult) - commission;
                running += pnl;
                const t = trades[trades.length - 1];
                t.outcome = hit; t.exit = bar.close; t.pnl = pnl; t.tpMult = tpMult; t.slMult = slMult;
                _dirRecord(t.type, hit);
                equity.push(running); open = null; continue;
            }
            equity.push(running); continue;
        }

        if (i - lastFired < 2) { equity.push(running); continue; }

        let signal = null;
        try {
            signal = VortexStrategy.checkEntryRaw(symbol, slice, tfMinutes, htfCandles, bar.time, null, { newsBlackout, fomcBlackout });
        } catch(e) {}

        if (!signal) { equity.push(running); continue; }
        if (_dirBlocked(signal.type)) { equity.push(running); continue; }

        const atr    = _calcATR(slice, 10);
        const slMult = signal.slMultiplier || 0.4;
        const tpMult = signal.tpMultiplier || 2.0;
        const slDist = atr ? atr * slMult : bar.close * 0.001;
        const tpDist = atr ? atr * tpMult : bar.close * 0.002;
        const sl     = signal.type === 'BUY' ? bar.close - slDist : bar.close + slDist;
        const tp     = signal.type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

        open = { type: signal.type, entry: bar.close, sl, tp, slMult, tpMult };
        lastFired = i;
        trades.push({ time: bar.time, barIdx: i, type: signal.type, entry: bar.close, sl, tp, outcome: null, exit: null, pnl: null, tpMult, slMult, mode: signal.mode, volRatio: signal.volRatio });
        equity.push(running);
    }

    if (open) {
        const last = candles[candles.length - 1];
        const move = open.type === 'BUY' ? last.close - open.entry : open.entry - last.close;
        const slD  = Math.abs(open.entry - open.sl);
        const pnl  = slD > 0 ? (move / slD) * open.slMult * stake - commission : 0;
        running += pnl;
        const t = trades[trades.length - 1];
        t.outcome = 'OPEN'; t.exit = last.close; t.pnl = pnl;
        equity.push(running);
    }

    return { trades, equity, stats: _calcStats(trades, equity) };
}

// ─────────────────────────────────────────────────────────────
// BUILT-IN STRATEGIES  (only the 2 we're keeping: nova + vortex)
// Others kept for backwards compat but marked legacy.
// ─────────────────────────────────────────────────────────────
export function _getBuiltinStrategy(id) {
    const strats = {

        // ── NOVA v2 ───────────────────────────────────────────
        nova: (candles, h4, rsiState, atr, symbol) => {
            const c = candles; if (c.length < 25) return null;
            const isCrash = symbol && symbol.toUpperCase().includes('CRASH');
            const isBoom  = symbol && symbol.toUpperCase().includes('BOOM');
            const bias    = isCrash ? 'BUY' : isBoom ? 'SELL' : null;
            if (!bias) return null;
            const cl = c.slice(0, -1);
            const c0 = cl[cl.length-1], c1 = cl[cl.length-2], c2 = cl[cl.length-3];
            if (!c0 || !c1 || !c2) return null;
            const ema = (arr, p) => { if(arr.length<p)return null; const k=2/(p+1); let v=arr.slice(0,p).reduce((s,x)=>s+x.close,0)/p; for(let i=p;i<arr.length;i++) v=arr[i].close*k+v*(1-k); return v; };
            const rsi = _calcRSI(cl, rsiState);
            const e8  = ema(cl,8), e21 = ema(cl,21), e50 = ema(cl,50);
            if (!rsi || !e8 || !e21) return null;
            // Block entries during spikes
            if (atr) { const wU=c0.high-Math.max(c0.open,c0.close), wD=Math.min(c0.open,c0.close)-c0.low; if(wU>=atr*4||wD>=atr*4) return null; }
            // Trend filter
            if (e50) { if (bias==='BUY'&&c0.close<e50*0.998) return null; if (bias==='SELL'&&c0.close>e50*1.002) return null; }
            const pBull=c1.close>c1.open, cBull=c0.close>c0.open;
            const engBull=!pBull&&cBull&&c0.close>c1.open&&c0.open<c1.close;
            const engBear= pBull&&!cBull&&c0.close<c1.open&&c0.open>c1.close;
            let votes = 1; // bias
            if (bias==='BUY') {
                if(e8>e21&&c0.close>e8) votes++;
                if(rsi>40&&rsi<65) votes++;
                if(c0.low<=(ema(cl,20)||0)-2*1) votes++;
                if(engBull) votes+=2;
                if(c0.close>c1.close&&c1.close>c2.close) votes++;
                if(votes>=3) return { type:'BUY', tpMultiplier:1.5, slMultiplier:0.8 };
            } else {
                if(e8<e21&&c0.close<e8) votes++;
                if(rsi<60&&rsi>35) votes++;
                if(engBear) votes+=2;
                if(c0.close<c1.close&&c1.close<c2.close) votes++;
                if(votes>=3) return { type:'SELL', tpMultiplier:1.5, slMultiplier:0.8 };
            }
            return null;
        },

        // ── Legacy strategies kept for compare mode ───────────
        phantom: (candles, h4, rsiState, atr) => {
            const c=candles; if(c.length<30)return null;
            const cl=c.slice(0,-1); const c0=cl[cl.length-1],c1=cl[cl.length-2],c2=cl[cl.length-3]; if(!c0||!c1||!c2)return null;
            const ema=(arr,p)=>{if(arr.length<p)return null;const k=2/(p+1);let v=arr.slice(0,p).reduce((a,x)=>a+x.close,0)/p;for(let i=p;i<arr.length;i++)v=arr[i].close*k+v*(1-k);return v;};
            const rsi=_calcRSI(cl,rsiState); const e8=ema(cl,8),e21=ema(cl,21),e50=ema(cl,50);
            const sl20=cl.slice(-20);const mean=sl20.reduce((a,c)=>a+c.close,0)/20;
            const std=Math.sqrt(sl20.reduce((s,v)=>s+(v.close-mean)**2,0)/20);
            const bbU=mean+2*std,bbL=mean-2*std;
            if(!rsi||!e8||!e21||!e50)return null;
            const pBull=c1.close>c1.open,cBull=c0.close>c0.open;
            const engBull=!pBull&&cBull&&c0.close>c1.open&&c0.open<c1.close;
            const engBear=pBull&&!cBull&&c0.close<c1.open&&c0.open>c1.close;
            const trendBuy=e8>e21&&e21>e50&&c0.close>e8&&rsi>50&&rsi<75&&c0.high<bbU&&(engBull||(c0.close>c1.close&&c1.close>c2.close));
            const trendSell=e8<e21&&e21<e50&&c0.close<e8&&rsi<50&&rsi>25&&c0.low>bbL&&(engBear||(c0.close<c1.close&&c1.close<c2.close));
            const pbBuy=e8>e21&&e21>e50&&c0.close>e8&&c1.close<=e8*1.001&&rsi>45&&rsi<65&&c0.high<bbU&&engBull;
            const pbSell=e8<e21&&e21<e50&&c0.close<e8&&c1.close>=e8*0.999&&rsi<55&&rsi>35&&c0.low>bbL&&engBear;
            const tpMult=(pbBuy||pbSell)?2.5:2.0;
            if(trendBuy||pbBuy)  return{type:'BUY', tpMultiplier:tpMult,slMultiplier:1.0};
            if(trendSell||pbSell)return{type:'SELL',tpMultiplier:tpMult,slMultiplier:1.0};
            return null;
        },
    };

    const fn = strats[id];
    if (!fn) return null;
    return {
        analyze(stratId, candles, h4, rsiState, atr, symbol) {
            return fn(candles, h4, rsiState, atr, symbol);
        }
    };
}