# Auto-Researcher

An unattended background service that runs walk-forward backtests across a
symbol/timeframe/strategy matrix on a schedule, grades the results for
overfit, writes a full report, and periodically retrains the AI trade
prediction model — so you don't have to manually backtest and can review a
report and apply a few tweaks instead.

## What it does, every cycle

1. Pulls fresh historical candles from Deriv for every configured
   `symbol × timeframe` pair.
2. For every `strategy` configured, grid-searches a range of SL/TP
   multipliers and runs the existing IS/OOS walk-forward simulator
   (`js/backtest-core.js` — the same engine `backtest.html` uses in the
   browser) for each combination.
3. Grades every result with the existing overfit-detection scoring
   (0–115 score, A–F grade) and keeps the best parameter set per
   `symbol/strategy/timeframe`.
4. Saves every graded result to Supabase (`research_runs` table), or to
   `data/research-runs.json` locally if Supabase isn't configured.
5. For results that clear `RESEARCH_MIN_WINNER_SCORE`, exports the
   simulated trades into `data/research-trades.json` in the same shape
   `trade_learner.py` already knows how to train on.
6. If enough new trades have accumulated since the last model version,
   retrains the RandomForest model (`trade_learner.py`), writes a
   timestamped model file under `models/`, updates `models/latest.pkl` and
   `models/trade_model.pkl`, and records the new version (accuracy, feature
   importance) in Supabase's `model_versions` table (or locally).

## Running it

```bash
# One-off cycle, useful for testing:
npm run research:once

# Continuous, scheduled (used by pm2 in production):
npm run research
```

Under pm2 (recommended for the always-on HP setup), it's already wired up
in `ecosystem.config.cjs` as its own app, independent of the live trading
engine:

```bash
pm2 start ecosystem.config.cjs   # starts both signalbot-engine and signalbot-researcher
pm2 logs signalbot-researcher
pm2 restart signalbot-researcher
```

## One-time Supabase setup

Run `supabase/research_runs.sql` once against your Supabase project (SQL
editor or `psql`) to create the `research_runs` and `model_versions` tables.
If you skip this, the researcher still runs fine — it just falls back to
local JSON files under `data/` (`research-runs.json`,
`research-model-versions.json`), which is enough to try it out without any
cloud setup.

## Configuration (environment variables)

All optional — sensible defaults are used if unset. Set these in `.env`
alongside your existing `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` /
`DERIV_APP_ID` / `DERIV_TOKEN` / `DERIV_ACCOUNT_ID` variables.

| Variable | Default | Purpose |
|---|---|---|
| `RESEARCH_SYMBOLS` | `R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ75V,1HZ100V` | Symbols to sweep (comma-separated) |
| `RESEARCH_TIMEFRAMES` | `300,900` | Candle granularities in seconds (M5, M15) |
| `RESEARCH_STRATEGIES` | `breakout,vwap_reversion` | Strategy IDs to test |
| `RESEARCH_CANDLE_COUNT` | `3000` | Candles fetched per symbol/timeframe for the IS+OOS split |
| `RESEARCH_H4_CANDLE_COUNT` | `500` | H4 candles fetched for higher-timeframe trend context |
| `RESEARCH_SL_MIN` / `RESEARCH_SL_MAX` / `RESEARCH_SL_STEP` | `0.8` / `2.4` / `0.4` | SL multiplier grid |
| `RESEARCH_TP_MIN` / `RESEARCH_TP_MAX` / `RESEARCH_TP_STEP` | `1.2` / `4.0` / `0.6` | TP multiplier grid |
| `RESEARCH_MAX_COMBOS` | `40` | Cap on SL/TP combinations tested per symbol/strategy/timeframe |
| `RESEARCH_STAKE` | `10` | Stake used in the simulator's PnL model |
| `RESEARCH_INTERVAL_HOURS` | `6` | Hours between cycles |
| `RESEARCH_RUN_ON_START` | `true` | Run one cycle immediately on process start |
| `RESEARCH_COMBO_DELAY_MS` | `500` | Delay between grid-search combos (politeness) |
| `RESEARCH_MIN_WINNER_SCORE` | `65` | Minimum overfit-adjusted score to flag a result as a "winner" |
| `RESEARCH_AUTO_RETRAIN` | `true` | Whether to retrain the model automatically after each cycle |
| `RESEARCH_MIN_NEW_TRADES_FOR_RETRAIN` | `25` | Minimum new labeled trades required before retraining again |
| `RESEARCH_PYTHON_BIN` | `python3` | Python executable used to run `trade_learner.py` |

## Reviewing a report and applying tweaks

Query the `research_runs` table (or `data/research-runs.json`) for the
latest `cycle_id`, sorted by `score` descending, per `symbol`/`strategy`.
Each row already contains everything the interactive backtester's overfit
report shows: IS/OOS stats, grade, verdict, and warnings — the same fields
`js/backtest-core.js`'s `_detectOverfit()` produces for the manual
backtester, so a winning row's `params` (SL/TP multipliers) can be copied
directly into the corresponding strategy's live configuration in
`engine/strategy-runner.js` / the strategy builder UI.

This release intentionally stops at "review the report and apply the
change yourself" rather than auto-applying winning parameters to the live
bot — see the plan discussion for why (safety: a human should confirm a
change before it affects real trading).

## Requirements on the host (the "old HP")

- Node >= 18 (already required by this project) and the same `.env` used
  by `engine/engine.js` (Deriv credentials, optionally Supabase creds).
- Python 3 with `pandas`, `scikit-learn`, `joblib` installed (already listed
  in `requirements.txt`) if you want automatic model retraining. Without
  Python available, everything else (fetching candles, walk-forward
  grading, Supabase reports) still works — only the retrain step is
  skipped (it logs an error and continues on to the next cycle).
