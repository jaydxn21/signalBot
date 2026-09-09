// engine/research/config.js
// Configuration for the Auto-Researcher: which symbols/timeframes/strategies
// to sweep, how big the parameter grid is, and how often to run.
//
// Everything can be overridden via environment variables (loaded from .env
// by engine/config.js's loadConfig(), which already runs before this module
// is imported by engine/auto-researcher.js) so the matrix can be tuned per
// machine without code changes.

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// Deriv symbol codes this repo's strategies already understand
// (kept in sync with engine/strategy-runner.js's SYMBOL_MAP), expanded to
// match every symbol the repo already has training_data/*.csv for — those
// are the instruments this project is actively tracking/trading, so the
// researcher covers all of them by default rather than a narrow subset.
const DEFAULT_SYMBOLS = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ75V', '1HZ100V',
  'JD10', 'JD75', 'JD100',
  'BOOM1000', 'CRASH1000',
  'stpRNG',
  'frxEURUSD', 'frxUSDJPY', 'frxXAUUSD', 'frxEURGBP',
  'cryBTCUSD', 'cryETHUSD',
];

const DEFAULT_STRATEGIES = ['breakout', 'vwap_reversion'];

// Timeframe in seconds (matches Deriv `granularity`).
const DEFAULT_TIMEFRAMES = [300, 900]; // M5, M15

export function loadResearchConfig() {
  return {
    // Data
    symbols: parseList(process.env.RESEARCH_SYMBOLS, DEFAULT_SYMBOLS),
    timeframes: parseList(process.env.RESEARCH_TIMEFRAMES, DEFAULT_TIMEFRAMES.join(','))
      .map((n) => toNumber(n, 300)),
    strategies: parseList(process.env.RESEARCH_STRATEGIES, DEFAULT_STRATEGIES),
    candleCount: toNumber(process.env.RESEARCH_CANDLE_COUNT, 3000),
    h4CandleCount: toNumber(process.env.RESEARCH_H4_CANDLE_COUNT, 500),

    // Parameter grid (SL/TP multiplier sweep)
    grid: {
      slMin: toNumber(process.env.RESEARCH_SL_MIN, 0.8),
      slMax: toNumber(process.env.RESEARCH_SL_MAX, 2.4),
      slStep: toNumber(process.env.RESEARCH_SL_STEP, 0.4),
      tpMin: toNumber(process.env.RESEARCH_TP_MIN, 1.2),
      tpMax: toNumber(process.env.RESEARCH_TP_MAX, 4.0),
      tpStep: toNumber(process.env.RESEARCH_TP_STEP, 0.6),
      maxCombos: toNumber(process.env.RESEARCH_MAX_COMBOS, 40),
    },

    // Simulation
    stake: toNumber(process.env.RESEARCH_STAKE, 10),
    commission: toNumber(process.env.RESEARCH_COMMISSION, 0),

    // Scheduling
    // Default 8h — chosen as a middle ground between "system" (an 8h cycle
    // comfortably finishes background CPU work on modest HP hardware
    // between runs, even with the expanded default symbol matrix) and
    // "limits" (roughly 3 cycles/day × ~114 Deriv WS candle requests/cycle
    // stays well clear of anything resembling abuse, especially spaced out
    // by delayBetweenFetchesMs below).
    intervalHours: toNumber(process.env.RESEARCH_INTERVAL_HOURS, 8),
    runOnStart: process.env.RESEARCH_RUN_ON_START !== 'false',
    // Politeness pause after each symbol/timeframe's candle fetch (the only
    // network-bound step — grid-search combos afterward are pure in-memory
    // CPU work), so a 19-symbol × 2-timeframe sweep doesn't hammer Deriv's
    // WS endpoint back-to-back.
    delayBetweenFetchesMs: toNumber(process.env.RESEARCH_FETCH_DELAY_MS, 1500),

    // Grading thresholds — only combos scoring at/above this are kept as
    // "winners" in the report and eligible to feed the model retrainer.
    minWinnerScore: toNumber(process.env.RESEARCH_MIN_WINNER_SCORE, 65),

    // Model retraining — triggered only once enough *new* labeled trades
    // have accumulated since the last successful train (not every cycle
    // regardless), so the model isn't repeatedly refit on near-identical
    // data. Cheap to raise/lower per RESEARCH_MIN_NEW_TRADES_FOR_RETRAIN.
    autoRetrain: process.env.RESEARCH_AUTO_RETRAIN !== 'false',
    minNewTradesForRetrain: toNumber(process.env.RESEARCH_MIN_NEW_TRADES_FOR_RETRAIN, 25),
    pythonBin: process.env.RESEARCH_PYTHON_BIN || 'python3',

    // Optional secondary report sink (opt-in, off by default). Primary
    // record stays Supabase/local JSON (dashboard-queryable); this commits
    // a Markdown summary per cycle to a `reports/` folder via the GitHub
    // Contents API for anyone who prefers reviewing reports as commits.
    githubReportsEnabled: process.env.RESEARCH_GITHUB_REPORTS === 'true',
    githubRepo: process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY || null,
    githubBranch: process.env.GITHUB_BRANCH || null,
    githubReportsPath: process.env.RESEARCH_REPORTS_PATH || 'reports',
  };
}

