// engine/research/optimizer.js
// Headless grid-search + walk-forward grading, reusing the exact same
// pure simulation engine the interactive backtester in the browser uses
// (js/backtest-core.js has no DOM/browser dependency at all — only its
// candle *fetcher* was browser-only, which is why candle-fetcher.js exists).

import {
  _walkForward,
  _getBuiltinStrategy,
} from '../../js/backtest-core.js';

// Build a small SL/TP multiplier grid around sane defaults. Kept
// intentionally modest so a full symbol×timeframe×strategy sweep stays
// fast enough to run every few hours on modest hardware.
export function buildParamGrid({
  slMin = 0.8, slMax = 2.4, slStep = 0.4,
  tpMin = 1.2, tpMax = 4.0, tpStep = 0.6,
  maxCombos = 40,
} = {}) {
  const combos = [];
  for (let sl = slMin; sl <= slMax + 1e-9; sl += slStep) {
    for (let tp = tpMin; tp <= tpMax + 1e-9; tp += tpStep) {
      if (tp <= sl) continue; // never test negative-expectancy R:R on purpose
      combos.push({ slMultiplier: +sl.toFixed(2), tpMultiplier: +tp.toFixed(2) });
    }
  }
  return combos.slice(0, maxCombos);
}

// Run a full walk-forward pass for one { symbol, timeframe, strategy, params }
// combination and return a normalized report row.
export async function runWalkForwardCombo({
  symbol, timeframeSeconds, strategyId, params,
  strategyOptions = {},
  candles, h4Candles, stake = 10, commission = 0,
}) {
  const strategyObj = _getBuiltinStrategy(strategyId, { ...strategyOptions, ...params });
  if (!strategyObj) {
    return { symbol, timeframeSeconds, strategyId, params, error: `Unknown strategy: ${strategyId}` };
  }

  const wf = await _walkForward(candles, h4Candles, strategyObj, stake, commission, symbol);

  return {
    symbol,
    timeframeSeconds,
    strategyId,
    params,
    candleCount: candles.length,
    isStats: wf.is.stats,
    oosStats: wf.oos.stats,
    overfit: wf.overfit,
    score: wf.overfit.score,
    grade: wf.overfit.grade,
    verdict: wf.overfit.verdict,
    warnings: wf.overfit.warnings,
    trades: [...wf.is.trades, ...wf.oos.trades].filter((t) => t.outcome && t.outcome !== 'OPEN'),
    timestamp: Date.now(),
  };
}

// Grid-search a single symbol/timeframe/strategy combo across a param grid,
// returning every result sorted best-first (by overfit-adjusted score).
export async function runGridSearch({
  symbol, timeframeSeconds, strategyId,
  candles, h4Candles, stake = 10, commission = 0,
  strategyOptions = {},
  grid = buildParamGrid(),
}) {
  const results = [];
  for (const params of grid) {
    try {
      const result = await runWalkForwardCombo({
        symbol, timeframeSeconds, strategyId, params, strategyOptions, candles, h4Candles, stake, commission,
      });
      results.push(result);
    } catch (err) {
      results.push({
        symbol, timeframeSeconds, strategyId, params,
        error: err.message || String(err),
      });
    }
  }

  return results
    .filter((r) => !r.error)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}
