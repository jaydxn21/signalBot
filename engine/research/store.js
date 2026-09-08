// engine/research/store.js
// Persistence for Auto-Researcher reports: Supabase primary (table
// `research_runs`), local JSON file fallback so the pipeline still works
// with no Supabase credentials configured (mirrors the pattern already
// used in engine/store.js for bots/trades/signals).

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const MAX_LOCAL_RUNS = 500;

export class ResearchStore {
  constructor({
    dataDir,
    supabaseUrl = process.env.SUPABASE_URL,
    supabaseKey = process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_KEY,
  } = {}) {
    this.dataDir = dataDir;
    this.runsFile = path.join(dataDir, 'research-runs.json');
    this.tradesFile = path.join(dataDir, 'research-trades.json');
    this.modelsFile = path.join(dataDir, 'research-model-versions.json');

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      console.log('[research-store] Supabase client initialized');
    } else {
      this.supabase = null;
      console.log('[research-store] Running in local-only mode (missing SUPABASE_URL/key)');
    }
  }

  _readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[research-store] Failed to read ${file}:`, err.message);
      return fallback;
    }
  }

  _writeJson(file, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
    } catch (err) {
      console.error(`[research-store] Failed to write ${file}:`, err.message);
    }
  }

  // ─── RESEARCH RUN REPORTS ─────────────────────────────────────────
  // `run` is one row of a cycle's report — a single symbol/timeframe/
  // strategy/param combination's walk-forward result plus grading.
  async saveRun(run) {
    const record = {
      cycle_id: run.cycleId,
      symbol: run.symbol,
      timeframe_seconds: run.timeframeSeconds,
      strategy_id: run.strategyId,
      params: run.params,
      candle_count: run.candleCount,
      is_stats: run.isStats,
      oos_stats: run.oosStats,
      score: run.score,
      grade: run.grade,
      verdict: run.verdict,
      warnings: run.warnings,
      is_winner: run.isWinner,
      created_at: new Date(run.timestamp || Date.now()).toISOString(),
    };

    if (this.supabase) {
      try {
        const { error } = await this.supabase.from('research_runs').insert(record);
        if (error) throw error;
      } catch (err) {
        console.error('[research-store] Supabase saveRun failed, falling back to local file:', err.message);
        this._appendLocal(this.runsFile, record);
      }
    } else {
      this._appendLocal(this.runsFile, record);
    }
  }

  _appendLocal(file, record) {
    const list = this._readJson(file, []);
    list.push(record);
    this._writeJson(file, list.slice(-MAX_LOCAL_RUNS));
  }

  async getRecentRuns(limit = 100) {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('research_runs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[research-store] Supabase getRecentRuns failed, using local file:', err.message);
      }
    }
    return this._readJson(this.runsFile, []).slice(-limit).reverse();
  }

  // ─── TRADE EXPORT (for model retraining) ───────────────────────────
  // Appends walk-forward trades in the same shape trade_learner.py expects
  // (see load_data() in trade_learner.py), so newly discovered wins/losses
  // continuously expand the AI's training set.
  appendTrades(trades) {
    if (!trades?.length) return 0;
    const existing = this._readJson(this.tradesFile, []);
    const merged = existing.concat(trades);
    this._writeJson(this.tradesFile, merged);
    return trades.length;
  }

  getAllTrades() {
    return this._readJson(this.tradesFile, []);
  }

  countTradesSince(timestampMs) {
    return this.getAllTrades().filter((t) => (t.close_time || 0) * 1000 >= timestampMs).length;
  }

  // ─── MODEL VERSIONS ─────────────────────────────────────────────────
  async saveModelVersion(version) {
    const record = {
      version_tag: version.versionTag,
      model_path: version.modelPath,
      trained_on_count: version.trainedOnCount,
      accuracy: version.accuracy,
      feature_importance: version.featureImportance,
      created_at: new Date(version.timestamp || Date.now()).toISOString(),
    };

    if (this.supabase) {
      try {
        const { error } = await this.supabase.from('model_versions').insert(record);
        if (error) throw error;
        return;
      } catch (err) {
        console.error('[research-store] Supabase saveModelVersion failed, falling back to local file:', err.message);
      }
    }
    const list = this._readJson(this.modelsFile, []);
    list.push(record);
    this._writeJson(this.modelsFile, list.slice(-100));
  }

  async getLatestModelVersion() {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('model_versions')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if (data) return data;
      } catch (err) {
        console.error('[research-store] Supabase getLatestModelVersion failed, using local file:', err.message);
      }
    }
    const list = this._readJson(this.modelsFile, []);
    return list.length ? list[list.length - 1] : null;
  }
}
