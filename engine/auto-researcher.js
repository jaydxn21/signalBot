#!/usr/bin/env node
// engine/auto-researcher.js
// Unattended "Auto-Researcher": on a schedule, pulls fresh historical
// candles, runs walk-forward + grid-search backtests across a configurable
// symbol/timeframe/strategy matrix, grades every result for overfit, saves
// a full report (Supabase, with local-JSON fallback), exports newly
// discovered wins/losses as training data, and periodically retrains the
// AI prediction model — so you can be away from the machine and come back
// to a report instead of having to backtest manually.
//
// Run directly:            node engine/auto-researcher.js
// Run once (no schedule):  node engine/auto-researcher.js --once
// Run under pm2:           pm2 start ecosystem.config.cjs --only signalbot-researcher

import { loadConfig } from './config.js';
import { loadResearchConfig } from './research/config.js';
import { fetchCandles } from './research/candle-fetcher.js';
import { runGridSearch, buildParamGrid } from './research/optimizer.js';
import { ResearchStore } from './research/store.js';
import { toLearnerTrades } from './research/trade-export.js';
import { retrainModel } from './research/model-trainer.js';

const config = loadConfig();
const rConfig = loadResearchConfig();
const store = new ResearchStore({ dataDir: config.dataDir });

const RUN_ONCE = process.argv.includes('--once');

function log(msg) {
  console.log(`[auto-researcher] ${new Date().toISOString()} ${msg}`);
}

function formatProgress(current, total, width = 20) {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.min(Math.max(current / safeTotal, 0), 1);
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, ' ');
  return `[${bar}] ${pct}% (${current}/${total})`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(symbol, granularity, count, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchCandles(symbol, granularity, count);
    } catch (err) {
      lastErr = err;
      log(`⚠ fetch ${symbol}@${granularity} attempt ${i + 1}/${attempts} failed: ${err.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

// Runs one full sweep of the configured symbol × timeframe × strategy
// matrix, grid-searching parameters within each combo, saving every
// graded result, and collecting winners for the retrain step.
async function runCycle() {
  const cycleId = `cycle_${Date.now()}`;
  log(`🔬 Starting research cycle ${cycleId} — ${rConfig.symbols.length} symbols × ${rConfig.timeframes.length} timeframes × ${rConfig.strategies.length} strategies`);

  const grid = buildParamGrid(rConfig.grid);
  const totalUnits = rConfig.symbols.length * rConfig.timeframes.length * rConfig.strategies.length;
  let completedUnits = 0;
  const winners = [];
  const allResults = [];
  let totalCombosRun = 0;
  let totalTradesExported = 0;

  for (const symbol of rConfig.symbols) {
    // Fetch H4 trend-context candles once per symbol (not once per
    // timeframe) — with a 19-symbol default matrix, redundant H4 fetches
    // would needlessly multiply Deriv API calls. H4 context is optional
    // (strategies treat an empty array as "no higher-TF filter"), so a
    // failure here doesn't block the symbol's timeframes.
    let h4Candles = [];
    try {
      h4Candles = await fetchWithRetry(symbol, 14400, rConfig.h4CandleCount);
    } catch (err) {
      log(`⚠ H4 fetch failed for ${symbol}, continuing without H4 trend context: ${err.message}`);
    }

    for (const timeframeSeconds of rConfig.timeframes) {
      let candles;
      try {
        candles = await fetchWithRetry(symbol, timeframeSeconds, rConfig.candleCount);
      } catch (err) {
        log(`❌ Skipping ${symbol}@${timeframeSeconds}s — candle fetch failed: ${err.message}`);
        completedUnits += rConfig.strategies.length;
        continue;
      }

      if (candles.length < 100) {
        log(`⚠ Skipping ${symbol}@${timeframeSeconds}s — only ${candles.length} candles returned`);
        completedUnits += rConfig.strategies.length;
        continue;
      }

      for (const strategyId of rConfig.strategies) {
        let results;
        try {
          const currentUnit = completedUnits + 1;
          log(`⏳ ${formatProgress(currentUnit, totalUnits)} ${symbol}@${timeframeSeconds}s ${strategyId}`);
          results = await runGridSearch({
            symbol, timeframeSeconds, strategyId, candles, h4Candles,
            stake: rConfig.stake,
            commission: rConfig.commission,
            grid,
            strategyOptions: { verboseLogs: rConfig.verboseStrategyLogs },
          });
        } catch (err) {
          log(`❌ ${symbol}/${strategyId}@${timeframeSeconds}s grid search failed: ${err.message}`);
          completedUnits += 1;
          continue;
        }

        totalCombosRun += results.length;
        const best = results[0];
        if (!best) {
          log(`⚠ ${symbol}/${strategyId}@${timeframeSeconds}s — no valid results`);
          completedUnits += 1;
          continue;
        }

        const isWinner = best.score >= rConfig.minWinnerScore;
        await store.saveRun({ ...best, cycleId, isWinner });
        completedUnits += 1;
        log(`${isWinner ? '✅' : '·'} ${formatProgress(completedUnits, totalUnits)} ${symbol}/${strategyId}@${timeframeSeconds}s score=${best.score.toFixed(1)} grade=${best.grade}`);

        allResults.push({ ...best, cycleId, isWinner });
        if (isWinner) {
          winners.push(best);
          const learnerTrades = toLearnerTrades({ trades: best.trades, symbol, strategyId });
          totalTradesExported += store.appendTrades(learnerTrades);
        }
      }

      // Politeness pause between symbol/timeframe fetches — this is where
      // network load actually happens (grid-search combos afterward are
      // pure in-memory CPU work on the already-fetched candles).
      await sleep(rConfig.delayBetweenFetchesMs);
    }
  }

  log(`🏁 Cycle ${cycleId} complete — ${totalCombosRun} combos evaluated, ${winners.length} winners, ${totalTradesExported} trades exported for training`);

  if (rConfig.githubReportsEnabled) {
    try {
      const { publishReportToGitHub } = await import('./research/github-reporter.js');
      const published = await publishReportToGitHub({
        cycleId, results: allResults,
        repo: rConfig.githubRepo, branch: rConfig.githubBranch, reportsPath: rConfig.githubReportsPath,
      });
      log(`📝 Published report to GitHub: ${published.path}`);
    } catch (err) {
      log(`⚠ GitHub report publish failed (Supabase/local report already saved): ${err.message}`);
    }
  }

  if (rConfig.autoRetrain) {
    await maybeRetrain();
  }

  return { cycleId, totalCombosRun, winners, totalTradesExported };
}

async function maybeRetrain() {
  const latest = await store.getLatestModelVersion();
  const sinceMs = latest ? new Date(latest.created_at).getTime() : 0;
  const newTradeCount = store.countTradesSince(sinceMs);

  if (newTradeCount < rConfig.minNewTradesForRetrain) {
    log(`⏭ Skipping retrain — only ${newTradeCount} new trades since last model (need ${rConfig.minNewTradesForRetrain})`);
    return;
  }

  log(`🧠 Retraining model on ${newTradeCount} new trades...`);
  try {
    const result = await retrainModel({ rootDir: config.rootDir, pythonBin: rConfig.pythonBin });
    await store.saveModelVersion(result);
    log(`✅ Model retrained: v${result.versionTag}, accuracy=${(result.accuracy * 100).toFixed(1)}%, trained on ${result.trainedOnCount} trades`);
  } catch (err) {
    log(`❌ Retrain failed: ${err.message}`);
  }
}

async function main() {
  log(`Auto-Researcher starting — symbols=[${rConfig.symbols.join(',')}] strategies=[${rConfig.strategies.join(',')}] intervalHours=${rConfig.intervalHours}`);

  if (RUN_ONCE) {
    await runCycle();
    process.exit(0);
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) { log('⏭ Previous cycle still running, skipping this tick'); return; }
    running = true;
    try {
      await runCycle();
    } catch (err) {
      log(`❌ Cycle failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  if (rConfig.runOnStart) await tick();

  const intervalMs = rConfig.intervalHours * 3600 * 1000;
  const timer = setInterval(tick, intervalMs);

  const shutdown = () => {
    log('Shutting down...');
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[auto-researcher] Fatal error:', err);
  process.exit(1);
});
