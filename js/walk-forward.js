// js/walk-forward.js
// Walk-Forward Analysis Engine
//
// Phase 1 — In-Sample (IS):  first 50% of candles, strategy is "trained"
// Phase 2 — Out-of-Sample (OOS): second 50%, blind test, no tuning
//
// Confidence score = weighted composite of IS/OOS consistency metrics
// Each result stored with full metadata for future AI training dataset

import { _simulate, _getBuiltinStrategy } from './backtest-core.js';
import { SessionState } from './session-state.js';

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────────────────────
export const WalkForward = {

    // Run full IS + OOS analysis
    // Returns { is, oos, confidence, suggestions, splitIdx }
    run(candles, h4Candles, strategyId, stake = 10, commission = 0, symbol = '') {
        if (candles.length < 100) {
            return { error: 'Need at least 100 candles for walk-forward analysis' };
        }

        const splitIdx = Math.floor(candles.length / 2);

        const isCandles  = candles.slice(0, splitIdx);
        const oosCandles = candles.slice(splitIdx);

        // H4 split — align by time
        const splitTime  = candles[splitIdx].time;
        const isH4       = h4Candles.filter(c => c.time <= splitTime);
        const oosH4      = h4Candles.filter(c => c.time >  splitTime);

        // Resolve strategy — accepts string ID or custom object
        const stratObj   = typeof strategyId === 'string'
            ? _getBuiltinStrategy(strategyId)
            : strategyId;

        const isResult   = _simulate(isCandles,  isH4,  stratObj, stake, commission, symbol);
        const oosResult  = _simulate(oosCandles, oosH4, stratObj, stake, commission, symbol);

        const isStats    = _calcStats(isResult.trades,  isResult.equity);
        const oosStats   = _calcStats(oosResult.trades, oosResult.equity);

        const confidence = _scoreConfidence(isStats, oosStats);
        const suggestions = SuggestionEngine.analyze(isStats, oosStats, strategyId, candles, isResult.trades, oosResult.trades);

        // Store to dataset for future AI training
        _recordToDataset({
            strategyId, symbol: '', tf: 0,
            totalCandles: candles.length, splitIdx,
            isStats, oosStats, confidence, suggestions,
            timestamp: Date.now(),
        });

        return {
            is:          { ...isResult,  stats: isStats  },
            oos:         { ...oosResult, stats: oosStats },
            confidence,
            suggestions,
            splitIdx,
            splitTime,
        };
    },

    // Live walk-forward: compare running live trades to backtest expectancy
    // Call after every live trade closes
    checkLiveDivergence(strategyId, symbol) {
        const trades      = (SessionState.get().trades || [])
            .filter(t => t.strategy === strategyId && t.symbol === symbol);
        const dataset     = SessionState.get().wfDataset || [];
        const latest      = dataset.filter(d => d.strategyId === strategyId).slice(-1)[0];
        if (!latest || trades.length < 5) return null;

        const liveStats = _calcStats(trades.map(t => ({
            outcome: t.outcome, pnl: Math.abs(t.pnl),
            entry: t.entry, sl: t.sl, tp: t.tp,
        })), null);

        const modelWR  = latest.oosStats.winRate;
        const liveWR   = liveStats.winRate;
        const diverge  = modelWR - liveWR;

        return {
            modelWR:     modelWR,
            liveWR:      liveWR,
            divergence:  diverge,
            trades:      trades.length,
            status:      diverge > 20 ? 'warning' : diverge > 10 ? 'watch' : 'ok',
            message:     diverge > 20
                ? `⚠ Live underperforming model by ${diverge.toFixed(0)}% WR (${trades.length} trades)`
                : diverge > 10
                ? `👁 Live tracking below model by ${diverge.toFixed(0)}% — monitor`
                : `✓ Live performance consistent with model`,
        };
    },
};

// ─────────────────────────────────────────────────────────────
// STATS CALCULATOR
// ─────────────────────────────────────────────────────────────
function _calcStats(trades, equity) {
    const closed   = trades.filter(t => t.outcome === 'TP' || t.outcome === 'SL');
    const wins     = closed.filter(t => t.outcome === 'TP');
    const losses   = closed.filter(t => t.outcome === 'SL');
    const total    = closed.length;
    if (total === 0) return _emptyStats();

    const winRate    = wins.length / total * 100;
    const grossWin   = wins.reduce((s, t) => s + Math.abs(t.pnl), 0);
    const grossLoss  = losses.reduce((s, t) => s + Math.abs(t.pnl), 0);
    const netPnL     = grossWin - grossLoss;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgWin     = wins.length   ? grossWin  / wins.length   : 0;
    const avgLoss    = losses.length ? grossLoss / losses.length : 0;

    // Max drawdown from equity curve
    let maxDD = 0;
    if (equity) {
        let peak = 0;
        equity.forEach(v => { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; });
    }

    // Max consecutive losses
    let streak = 0, maxStreak = 0;
    closed.forEach(t => {
        if (t.outcome === 'SL') { streak++; maxStreak = Math.max(maxStreak, streak); }
        else streak = 0;
    });

    // Avg R:R
    const rrVals = closed
        .filter(t => t.sl && t.tp && t.entry)
        .map(t => {
            const sl = Math.abs(t.entry - t.sl);
            const tp = Math.abs(t.entry - t.tp);
            return sl > 0 ? tp / sl : 0;
        }).filter(r => r > 0);
    const avgRR = rrVals.length ? rrVals.reduce((a,b)=>a+b,0)/rrVals.length : 0;

    // Trade frequency (trades per 100 candles) — approximate
    const expectancy = (winRate/100 * avgWin) - ((1-winRate/100) * avgLoss);

    return {
        total, wins: wins.length, losses: losses.length,
        winRate, grossWin, grossLoss, netPnL,
        profitFactor, avgWin, avgLoss, maxDD,
        maxStreak, avgRR, expectancy,
    };
}

function _emptyStats() {
    return {
        total:0, wins:0, losses:0, winRate:0,
        grossWin:0, grossLoss:0, netPnL:0,
        profitFactor:0, avgWin:0, avgLoss:0, maxDD:0,
        maxStreak:0, avgRR:0, expectancy:0,
    };
}

// ─────────────────────────────────────────────────────────────
// CONFIDENCE SCORER
// ─────────────────────────────────────────────────────────────
function _scoreConfidence(is, oos) {
    if (is.total < 5 || oos.total < 3) {
        return { score: 0, grade: 'F', color: '#94a3b8', breakdown: [], verdict: 'Insufficient trades for analysis' };
    }

    const breakdown = [];
    let   total     = 0;

    // 1. OOS Win Rate (25 pts) — absolute performance
    const oosWR = oos.winRate;
    const wrPts  = oosWR >= 60 ? 25 : oosWR >= 50 ? 18 : oosWR >= 40 ? 10 : oosWR >= 30 ? 4 : 0;
    total += wrPts;
    breakdown.push({ label: 'OOS Win Rate', value: `${oosWR.toFixed(1)}%`, pts: wrPts, max: 25 });

    // 2. IS → OOS consistency (25 pts) — key overfit detector
    const wrDrop    = is.winRate - oos.winRate;
    const consPts   = wrDrop <= 5  ? 25
                    : wrDrop <= 10 ? 20
                    : wrDrop <= 20 ? 12
                    : wrDrop <= 30 ? 5
                    : 0;
    total += consPts;
    breakdown.push({ label: 'IS→OOS Consistency', value: `${wrDrop > 0 ? '-' : '+'}${Math.abs(wrDrop).toFixed(1)}% WR drop`, pts: consPts, max: 25 });

    // 3. OOS Profit Factor (20 pts)
    const pf     = oos.profitFactor;
    const pfPts  = pf >= 1.5 ? 20 : pf >= 1.2 ? 14 : pf >= 1.0 ? 8 : pf >= 0.8 ? 3 : 0;
    total += pfPts;
    breakdown.push({ label: 'OOS Profit Factor', value: pf === Infinity ? '∞' : pf.toFixed(2), pts: pfPts, max: 20 });

    // 4. Drawdown stability (15 pts) — OOS DD not much worse than IS DD
    const ddRatio = is.maxDD > 0 ? oos.maxDD / is.maxDD : 1;
    const ddPts   = ddRatio <= 1.2 ? 15 : ddRatio <= 1.5 ? 10 : ddRatio <= 2.0 ? 5 : 0;
    total += ddPts;
    breakdown.push({ label: 'Drawdown Stability', value: `${ddRatio.toFixed(1)}× IS DD`, pts: ddPts, max: 15 });

    // 5. Trade frequency consistency (10 pts)
    const freqRatio = is.total > 0 ? oos.total / is.total : 0;
    const freqPts   = freqRatio >= 0.7 && freqRatio <= 1.3 ? 10
                    : freqRatio >= 0.5 && freqRatio <= 1.5 ? 6
                    : 2;
    total += freqPts;
    breakdown.push({ label: 'Signal Frequency', value: `${oos.total} vs ${is.total} trades`, pts: freqPts, max: 10 });

    // 6. Positive expectancy OOS (5 pts)
    const expPts = oos.expectancy > 0 ? 5 : 0;
    total += expPts;
    breakdown.push({ label: 'OOS Expectancy', value: oos.expectancy.toFixed(4), pts: expPts, max: 5 });

    total = Math.min(total, 100);

    const grade  = total >= 75 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : total >= 20 ? 'D' : 'F';
    const color  = total >= 75 ? '#10b981' : total >= 60 ? '#f59e0b' : total >= 40 ? '#f97316' : '#ef4444';

    const verdict = total >= 75 ? 'Strong — deploy with confidence'
                  : total >= 60 ? 'Acceptable — monitor live performance'
                  : total >= 40 ? 'Marginal — needs parameter tuning'
                  : total >= 20 ? 'Weak — significant overfit detected'
                  : 'Failed — strategy does not generalise';

    return { score: total, grade, color, breakdown, verdict };
}

// ─────────────────────────────────────────────────────────────
// SUGGESTION ENGINE
// Rule-based analysis → specific actionable tweaks
// Data structure is AI-training-ready: observation + tweak + expected_impact
// ─────────────────────────────────────────────────────────────
export const SuggestionEngine = {

    analyze(isStats, oosStats, strategyId, candles, isTrades, oosTrades) {
        const suggestions = [];
        const id = () => `sug_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        const all = [...isTrades, ...oosTrades].filter(t => t.outcome);

        // ── OVERFIT DETECTION ────────────────────────────────
        const wrDrop = isStats.winRate - oosStats.winRate;
        if (wrDrop > 20) {
            suggestions.push({
                id: id(), priority: 'high', type: 'overfit',
                icon: '🔴',
                observation: `Win rate drops ${wrDrop.toFixed(1)}% from in-sample to out-of-sample — strong overfit signal.`,
                tweak: 'Reduce number of entry conditions. Fewer rules = less curve fitting. Try removing the least impactful condition and re-running.',
                expected_impact: 'Reduce IS→OOS gap by 10–15%',
                param: null, applied: false, result: null,
            });
        } else if (wrDrop > 10) {
            suggestions.push({
                id: id(), priority: 'medium', type: 'overfit',
                icon: '🟡',
                observation: `Moderate IS→OOS drop of ${wrDrop.toFixed(1)}%. Strategy may be slightly over-optimised.`,
                tweak: 'Widen entry conditions slightly — e.g. if RSI threshold is 30, try 35. Tighter thresholds = fewer but more overfit signals.',
                expected_impact: 'Improve OOS consistency by 5–10%',
                param: null, applied: false, result: null,
            });
        }

        // ── DIRECTION BIAS ───────────────────────────────────
        const buys  = all.filter(t => t.type === 'BUY');
        const sells = all.filter(t => t.type === 'SELL');
        if (buys.length >= 5 && sells.length >= 5) {
            const buyWR  = buys.filter(t=>t.outcome==='TP').length  / buys.length  * 100;
            const sellWR = sells.filter(t=>t.outcome==='TP').length / sells.length * 100;
            const diff   = Math.abs(buyWR - sellWR);
            if (diff > 20) {
                const good = buyWR > sellWR ? 'BUY' : 'SELL';
                const bad  = good === 'BUY' ? 'SELL' : 'BUY';
                suggestions.push({
                    id: id(), priority: 'high', type: 'direction_bias',
                    icon: '🎯',
                    observation: `${good} signals: ${(good==='BUY'?buyWR:sellWR).toFixed(0)}% WR vs ${bad} signals: ${(bad==='BUY'?buyWR:sellWR).toFixed(0)}% WR — ${diff.toFixed(0)}pt gap.`,
                    tweak: `Restrict strategy to ${good}-only signals, or add H4 trend confirmation before ${bad} entries.`,
                    expected_impact: `Could lift overall WR by ${(diff/2).toFixed(0)}–${diff.toFixed(0)}pts`,
                    param: { filter: `direction === '${good}'` }, applied: false, result: null,
                });
            }
        }

        // ── SL TOO TIGHT ────────────────────────────────────
        const slLosses = all.filter(t => t.outcome === 'SL' && t.entry && t.sl);
        if (slLosses.length > 3 && oosStats.maxStreak >= 4) {
            const slPct = slLosses.map(t => Math.abs(t.entry - t.sl) / t.entry * 100);
            const avgSLpct = slPct.reduce((a,b)=>a+b,0) / slPct.length;
            if (avgSLpct < 0.3) {
                suggestions.push({
                    id: id(), priority: 'high', type: 'sl_too_tight',
                    icon: '📏',
                    observation: `Average SL distance is ${avgSLpct.toFixed(3)}% of price — very tight. ${oosStats.maxStreak} consecutive losses on OOS.`,
                    tweak: `Widen SL multiplier from current setting to 1.8–2.2× ATR. Tight SLs get clipped by normal noise before the move develops.`,
                    expected_impact: `Reduce max consecutive losses, improve WR by reducing premature stops`,
                    param: { slMultiplier: 2.0 }, applied: false, result: null,
                });
            }
        }

        // ── LOW R:R ──────────────────────────────────────────
        if (oosStats.avgRR > 0 && oosStats.avgRR < 1.2) {
            suggestions.push({
                id: id(), priority: 'medium', type: 'low_rr',
                icon: '⚖️',
                observation: `Average R:R on OOS is ${oosStats.avgRR.toFixed(2)} — below 1.2:1 means you need >55% WR just to break even.`,
                tweak: `Increase TP multiplier to target 1.5–2.0 R:R minimum. Even if fewer TPs hit, net P&L improves if WR stays above 40%.`,
                expected_impact: `At 45% WR, moving from 1.1 R:R to 1.8 R:R turns a losing system positive`,
                param: { tpMultiplier: 1.8 }, applied: false, result: null,
            });
        }

        // ── OVERTRADING ─────────────────────────────────────
        const tradesPerCandle = all.length / candles.length;
        if (tradesPerCandle > 0.15) {
            suggestions.push({
                id: id(), priority: 'medium', type: 'overtrading',
                icon: '🔁',
                observation: `${all.length} trades across ${candles.length} candles — signal fires on ${(tradesPerCandle*100).toFixed(0)}% of bars. Too frequent.`,
                tweak: `Add a minimum spacing rule: no new signal within 3 bars of last entry. Also consider raising RSI/BB threshold to filter weak setups.`,
                expected_impact: `Reduce trade count by 30–50%, improve quality per trade`,
                param: { minBarsBetweenSignals: 3 }, applied: false, result: null,
            });
        }

        // ── GOOD PROFIT FACTOR but LOW TRADE COUNT ───────────
        if (oosStats.profitFactor >= 1.5 && oosStats.total < 10) {
            suggestions.push({
                id: id(), priority: 'low', type: 'low_frequency',
                icon: '📉',
                observation: `Profit factor is strong (${oosStats.profitFactor.toFixed(2)}) but only ${oosStats.total} OOS trades — too few to be statistically reliable.`,
                tweak: `Loosen entry conditions slightly to generate more signals, or run on a lower timeframe to capture more opportunities. Need ≥20 OOS trades for reliable stats.`,
                expected_impact: `More data = more reliable confidence score`,
                param: null, applied: false, result: null,
            });
        }

        // ── CONSECUTIVE LOSS PROTECTION ──────────────────────
        if (oosStats.maxStreak >= 5) {
            suggestions.push({
                id: id(), priority: 'high', type: 'consecutive_losses',
                icon: '🛑',
                observation: `${oosStats.maxStreak} consecutive losses detected in OOS phase — this will trigger the 3× loss protection and stop your bot.`,
                tweak: `Add a 30-minute cooldown after 2 consecutive SLs (not just 3). Also consider pausing during low-volatility hours when the strategy underperforms.`,
                expected_impact: `Reduce max drawdown by 30–40%`,
                param: { cooldownAfterLosses: 2, cooldownMinutes: 30 }, applied: false, result: null,
            });
        }

        // ── STRONG PERFORMANCE — deploy suggestion ───────────
        if (oosStats.winRate >= 60 && oosStats.profitFactor >= 1.4 && wrDrop <= 10) {
            suggestions.push({
                id: id(), priority: 'positive', type: 'deploy_ready',
                icon: '🚀',
                observation: `OOS WR ${oosStats.winRate.toFixed(1)}%, PF ${oosStats.profitFactor.toFixed(2)}, minimal IS→OOS drop. Strategy generalises well.`,
                tweak: `Ready to deploy live. Start with minimum stake and monitor first 10 live trades against the model WR (${oosStats.winRate.toFixed(1)}%) before increasing size.`,
                expected_impact: `Live expectancy: +${oosStats.expectancy.toFixed(4)} per trade`,
                param: null, applied: false, result: null,
            });
        }

        // Sort: high → medium → low → positive
        const order = { high:0, medium:1, low:2, positive:3 };
        return suggestions.sort((a,b) => (order[a.priority]||9) - (order[b.priority]||9));
    },

    // Mark a suggestion as applied and store result after re-run
    markApplied(id, newStats) {
        const dataset = SessionState.get().wfDataset || [];
        dataset.forEach(entry => {
            (entry.suggestions || []).forEach(s => {
                if (s.id === id) {
                    s.applied = true;
                    s.result  = newStats ? {
                        winRate:      newStats.winRate,
                        profitFactor: newStats.profitFactor,
                        timestamp:    Date.now(),
                    } : null;
                }
            });
        });
        SessionState.set({ wfDataset: dataset });
    },
};

// ─────────────────────────────────────────────────────────────
// DATASET PERSISTENCE (AI training data)
// ─────────────────────────────────────────────────────────────
function _recordToDataset(entry) {
    const dataset = SessionState.get().wfDataset || [];
    dataset.push(entry);
    // Keep last 200 runs
    SessionState.set({ wfDataset: dataset.slice(-200) });
}