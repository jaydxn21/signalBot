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
  const winners = [];
  let totalCombosRun = 0;
  let totalTradesExported = 0;

  for (const symbol of rConfig.symbols) {
    for (const timeframeSeconds of rConfig.timeframes) {
      let candles;
      let h4Candles;
      try {
        candles = await fetchWithRetry(symbol, timeframeSeconds, rConfig.candleCount);
        h4Candles = await fetchWithRetry(symbol, 14400, rConfig.h4CandleCount);
      } catch (err) {
        log(`❌ Skipping ${symbol}@${timeframeSeconds}s — candle fetch failed: ${err.message}`);
        continue;
      }

      if (candles.length < 100) {
        log(`⚠ Skipping ${symbol}@${timeframeSeconds}s — only ${candles.length} candles returned`);
        continue;
      }

      for (const strategyId of rConfig.strategies) {
        let results;
        try {
          results = await runGridSearch({
            symbol, timeframeSeconds, strategyId, candles, h4Candles,
            stake: rConfig.stake, commission: rConfig.commission, grid,
          });
        } catch (err) {
          log(`❌ ${symbol}/${strategyId}@${timeframeSeconds}s grid search failed: ${err.message}`);
          continue;
        }

        totalCombosRun += results.length;
        const best = results[0];
        if (!best) {
          log(`⚠ ${symbol}/${strategyId}@${timeframeSeconds}s — no valid results`);
          continue;
        }

        const isWinner = best.score >= rConfig.minWinnerScore;
        await store.saveRun({ ...best, cycleId, isWinner });
        log(`${isWinner ? '✅' : '·'} ${symbol}/${strategyId}@${timeframeSeconds}s best=${JSON.stringify(best.params)} score=${best.score.toFixed(1)} grade=${best.grade} oosWR=${(best.oosStats.winRate * 100).toFixed(1)}%`);

        if (isWinner) {
          winners.push(best);
          const learnerTrades = toLearnerTrades({ trades: best.trades, symbol, strategyId });
          totalTradesExported += store.appendTrades(learnerTrades);
        }

        await sleep(rConfig.delayBetweenCombosMs);
      }
    }
  }

  log(`🏁 Cycle ${cycleId} complete — ${totalCombosRun} combos evaluated, ${winners.length} winners, ${totalTradesExported} trades exported for training`);

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
