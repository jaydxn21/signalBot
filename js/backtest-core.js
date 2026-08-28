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
import { BreakoutTrendStrategy } from './strategies/breakout_trend.js';
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
export async function _walkForward(candles, h4Candles, strategyObj, stake, commission, symbol) {
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
// BUILT-IN STRATEGIES
// Only BREAKOUT strategy is supported now.
// ─────────────────────────────────────────────────────────────
// 📄 Location: js/backtest-core.js
export function _getBuiltinStrategy(id) {
    if (id !== 'breakout') {
        console.warn(`[backtest-core] Strategy "${id}" is not supported. Only "breakout" is available.`);
        return null;
    }

    const strategyWrapper = {
        analyze(stratId, candles, h4, rsiState, atr, symbol, rsi) {
            try {
                // 1. You don't even need 'new BreakoutTrendStrategy()' if everything is static!
                // But if the class constructor initializes tracking properties, you can leave it.
                
                // 2. FIX: Call checkEntry on the Class Name directly, not 'strategy'
                const signal = BreakoutTrendStrategy.checkEntry(candles, atr, symbol);
                if (!signal) return null;
                
                return {
                    type: signal.type,
                    tpMultiplier: 2.0,
                    slMultiplier: signal.slMultiplier || 1.2,
                    ...signal
                };
            } catch (e) {
                console.error('[backtest-core] Error in breakout strategy:', e.message);
                return null;
            }
        }
    };

    return strategyWrapper;
}
