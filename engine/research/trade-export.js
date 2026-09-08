// engine/research/trade-export.js
// Converts walk-forward simulation trades (js/backtest-core.js's `_simulate`
// output shape) into the flat record shape trade_learner.py's load_data()
// already knows how to parse, so every research cycle keeps expanding the
// AI model's training set with fresh, labeled wins/losses.

export function toLearnerTrades({ trades, symbol, strategyId }) {
  return (trades || [])
    .filter((t) => t.outcome === 'TP' || t.outcome === 'SL')
    .map((t) => ({
      symbol,
      mode: strategyId.toUpperCase(),
      entry: t.entry,
      sl: t.sl,
      tp: t.tp,
      outcome: t.outcome,
      pnl: t.pnl,
      close_time: t.time,
      source: 'auto-researcher',
    }));
}
