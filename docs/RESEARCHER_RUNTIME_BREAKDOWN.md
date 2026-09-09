# SignalBot Researcher Runtime Breakdown

This explains what `signalbot-researcher` is doing under PM2, why logs are very noisy, whether it is headless, and where/when outputs are saved.

## 1) Is it headless?

Yes.  
`signalbot-researcher` runs as a Node background process (`engine/auto-researcher.js`) under PM2 and does not require browser UI interaction.

- PM2 app: `signalbot-researcher` (`ecosystem.config.cjs`)
- Script: `./engine/auto-researcher.js`
- Runs continuously and schedules cycles internally (`RESEARCH_INTERVAL_HOURS`)

## 2) Why are there so many logs?

High log volume is expected because each cycle prints:

- startup/status lines
- per-symbol + per-timeframe processing
- per-strategy winner/score lines
- warnings/retries for network fetches
- retrain decisions/results

With default symbols/timeframes/strategies, this is a lot of iterations, so `researcher-out.log` grows quickly.

## 3) How the cycle works (high level)

For each cycle, the researcher:

1. Generates a new `cycle_id` (`cycle_<timestamp>`).
2. Fetches candles from Deriv for each configured symbol/timeframe.
3. Runs grid-search backtests for each strategy.
4. Grades results and picks best candidates.
5. Saves best run rows via `saveRun(...)`.
6. Exports winner trades for model training.
7. Optionally retrains model if enough new trades exist.
8. Optionally publishes a Markdown report to GitHub (only if enabled).

## 4) Where results are saved

Primary path (when Supabase is configured and tables exist):

- Table: `public.research_runs`
- Table: `public.model_versions`

Fallback path (if Supabase is unavailable/misconfigured/table missing):

- `/home/atomicprod/signalBot/data/research-runs.json`
- `/home/atomicprod/signalBot/data/research-model-versions.json`

Training trade export file:

- `/home/atomicprod/signalBot/data/research-trades.json`

Optional GitHub report export (off by default):

- `reports/<date>-<cycleId>.md` in repo (requires `RESEARCH_GITHUB_REPORTS=true`)

## 5) When results are saved

- `research_runs`: saved during each cycle immediately after a best result is computed for a `symbol/timeframe/strategy`.
- `research-trades.json`: appended when a result qualifies as a winner.
- `model_versions`: saved only after a successful retrain.
- Cycle frequency: every `RESEARCH_INTERVAL_HOURS` (default 8h), plus one immediate run on start unless `RESEARCH_RUN_ON_START=false`.

## 6) Useful PM2 log commands (less noisy)

```bash
# only researcher logs (not all processes)
pm2 logs signalbot-researcher --lines 100

# clear historical logs to view only fresh events
pm2 flush signalbot-researcher

# restart with latest .env values
pm2 restart signalbot-researcher --update-env

# quick runtime status
pm2 status
```

## 7) Quick health checklist

- Process stays `online` in PM2.
- New timestamps appear in `researcher-out.log`.
- No repeated `research_runs/model_versions not found` errors in `researcher-err.log`.
- New rows appear in Supabase `research_runs` over time.
