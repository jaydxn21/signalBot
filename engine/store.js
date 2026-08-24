// engine/store.js
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createClient } from '@supabase/supabase-js';

function sanitizeBot(bot = {}) {
  return {
    id: bot.id,
    userId: bot.userId || bot.user_id || null,
    config: bot.config || null,
    isActive: Boolean(bot.isActive),
    wins: bot.wins || 0,
    losses: bot.losses || 0,
    pnl: bot.pnl || 0,
    openSignal: bot.openSignal || null,
    accountEquity: bot.accountEquity || 10000,
    sessionStart: bot.sessionStart || null,
    lastFiredMs: bot.lastFiredMs || 0,
  };
}

export class Store extends EventEmitter {
  constructor({
    persistPath,
    autoMt5 = true,
    supabaseUrl = process.env.SUPABASE_URL,
    supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
    syncToCloud = true,
  }) {
    super();
    this.persistPath = persistPath;
    this.syncToCloud = syncToCloud;
    this.cloudSyncQueue = [];
    this.isCloudSyncRunning = false;
    this.currentUserId = process.env.DEFAULT_USER_ID || null;

    const resolvedKey = supabaseKey
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_KEY
      || process.env.SUPABASE_ANON_KEY;

    if (supabaseUrl && resolvedKey) {
      this.supabase = createClient(supabaseUrl, resolvedKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
      console.log('[store] Supabase admin client initialized successfully');
    } else {
      this.supabase = null;
      console.log('[store] Running in local-only mode (missing URL or Key)');
    }

    const resolvedAnonKey = supabaseAnonKey || process.env.SUPABASE_ANON_KEY || resolvedKey;
    if (supabaseUrl && resolvedAnonKey) {
      this.supabaseAnon = createClient(supabaseUrl, resolvedAnonKey);
      console.log('[store] Supabase anon client initialized');
    } else {
      this.supabaseAnon = null;
    }

    this.state = {
      connected: false,
      mt5Connected: false,
      autoMt5,
      bots: new Map(),
      logs: [],
      trades: [],
      startedAt: Date.now(),
    };

    this._load();

    if (this.syncToCloud && this.supabase) {
      this._startCloudSync();
    }
  }

  // Helper to safely get a valid user ID for database constraints
  _getValidUserId(botUserId) {
    return this.currentUserId || botUserId || process.env.DEFAULT_USER_ID || '00000000-0000-0000-0000-000000000000';
  }

  setUser(userId) {
    this.currentUserId = userId;
  }

  _load() {
    try {
      if (!fs.existsSync(this.persistPath)) {
        if (this.supabase) {
          this._loadFromSupabase();
        }
        return;
      }

      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.state.connected = false;
      this.state.mt5Connected = false;
      this.state.autoMt5 = raw.autoMt5 ?? this.state.autoMt5;
      this.state.startedAt = raw.startedAt || this.state.startedAt;
      this.state.logs = Array.isArray(raw.logs) ? raw.logs.slice(-200) : [];
      this.state.trades = Array.isArray(raw.trades) ? raw.trades.slice(-500) : [];

      for (const bot of Array.isArray(raw.bots) ? raw.bots : []) {
        if (bot?.id != null) {
          this.state.bots.set(String(bot.id), sanitizeBot(bot));
        }
      }

      if (this.supabase && this.syncToCloud) {
        this._syncLocalToCloud();
      }
    } catch (error) {
      console.error('[store] Failed to load persisted state:', error.message);
      if (this.supabase) {
        this._loadFromSupabase();
      }
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const data = {
        startedAt: this.state.startedAt,
        autoMt5: this.state.autoMt5,
        bots: this.listBots(),
        logs: this.state.logs.slice(-200),
        trades: this.state.trades.slice(-500),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[store] Failed to persist state:', error.message);
    }
  }

  async _loadFromSupabase() {
    if (!this.supabase) return;

    try {
      console.log('[store] Loading from Supabase...');

      const { data: bots, error: botsError } = await this.supabase
        .from('bots')
        .select('*')
        .order('created_at', { ascending: true });

      if (botsError) throw botsError;

      bots?.forEach(bot => {
        this.state.bots.set(String(bot.id), sanitizeBot({
          id: bot.id,
          userId: bot.user_id,
          config: bot.strategy_config,
          isActive: bot.is_active,
          wins: bot.wins || 0,
          losses: bot.losses || 0,
          pnl: bot.pnl || 0,
          openSignal: bot.open_signal || null,
          accountEquity: bot.account_equity || 10000,
          sessionStart: bot.session_start ? new Date(bot.session_start).getTime() : null,
          lastFiredMs: bot.last_fired_ms || 0,
        }));
      });

      const { data: signals, error: signalsError } = await this.supabase
        .from('signals')
        .select('*')
        .eq('is_processed', false)
        .order('created_at', { ascending: true });

      if (!signalsError && signals) {
        signals.forEach(signal => {
          this.emit('signal_pending', signal);
        });
      }

      const { data: trades, error: tradesError } = await this.supabase
        .from('trades')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(500);

      if (!tradesError && trades) {
        this.state.trades = trades.map(t => ({
          ...t,
          time: new Date(t.timestamp).getTime(),
        }));
      }

      console.log(`[store] Loaded ${this.state.bots.size} bots from Supabase`);
      this.emit('bots_list', this.getBotsList());
      this._persist();

    } catch (error) {
      console.error('[store] Failed to load from Supabase:', error.message);
    }
  }

  async _syncLocalToCloud() {
    if (!this.supabase) return;

    try {
      console.log('[store] Syncing local data to Supabase...');

      for (const [id, bot] of this.state.bots) {
        try {
          await this.supabase
            .from('bots')
            .upsert({
              id: id,
              user_id: this._getValidUserId(bot.userId),
              strategy_config: bot.config,
              is_active: bot.isActive,
              wins: bot.wins || 0,
              losses: bot.losses || 0,
              pnl: bot.pnl || 0,
              open_signal: bot.openSignal,
              account_equity: bot.accountEquity || 10000,
              session_start: bot.sessionStart ? new Date(bot.sessionStart).toISOString() : null,
              last_fired_ms: bot.lastFiredMs || 0,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'id' });
        } catch (botErr) {
          console.warn(`[store] Failed to sync bot ${id}: ${botErr.message}`);
          this.cloudSyncQueue.push({ type: 'upsert_bot', data: bot });
        }
      }

      console.log('[store] Sync to Supabase complete');
    } catch (error) {
      console.error('[store] Failed to sync to Supabase:', error.message);
    }
  }

  async _startCloudSync() {
    setInterval(async () => {
      if (this.cloudSyncQueue.length > 0) {
        await this._processCloudQueue();
      }
    }, 30000);
  }

  async _processCloudQueue() {
    if (this.isCloudSyncRunning || !this.supabase) return;
    this.isCloudSyncRunning = true;

    try {
      const queue = [...this.cloudSyncQueue];
      this.cloudSyncQueue = [];

      for (const operation of queue) {
        switch (operation.type) {
          case 'upsert_bot':
            await this._upsertBotToCloud(operation.data);
            break;
          case 'create_signal':
            await this._createSignalInCloud(operation.data);
            break;
          case 'record_trade':
            await this._recordTradeInCloud(operation.data);
            break;
          case 'add_log':
            await this._addLogToCloud(operation.data);
            break;
        }
      }
    } catch (error) {
      console.error('[store] Cloud sync error:', error.message);
    } finally {
      this.isCloudSyncRunning = false;
    }
  }

  async _upsertBotToCloud(bot) {
    if (!this.supabase) return;
    try {
      const targetUserId = this._getValidUserId(bot.userId);
      const { error } = await this.supabase
        .from('bots')
        .upsert({
          id: bot.id,
          user_id: targetUserId,
          strategy_config: bot.config,
          is_active: bot.isActive,
          wins: bot.wins || 0,
          losses: bot.losses || 0,
          pnl: bot.pnl || 0,
          open_signal: bot.openSignal,
          account_equity: bot.accountEquity || 10000,
          session_start: bot.sessionStart ? new Date(bot.sessionStart).toISOString() : null,
          last_fired_ms: bot.lastFiredMs || 0,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'id',
          ignoreDuplicates: false,
        });

      if (error) {
        console.error('[store] Supabase upsert error:', error.message);
        this.cloudSyncQueue.push({ type: 'upsert_bot', data: bot });
      }
    } catch (error) {
      // Network / fetch failures — requeue instead of silently dropping
      const msg = error?.cause?.message || error.message || 'Network unreachable';
      console.warn(`[store] Cloud sync temporary network error (${msg}). Requeuing for retry.`);
      this.cloudSyncQueue.push({ type: 'upsert_bot', data: bot });
    }
  }

  async _createSignalInCloud(signal) {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase
        .from('signals')
        .insert({
          bot_id: signal.botId,
          signal_type: signal.type,
          price: signal.entry,
          sl: signal.sl,
          tp: signal.tp,
          lot_size: signal.lotSize,
          confidence: signal.confidence || {},
          metadata: signal.metadata || {},
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      this.emit('signal_created', data);
      return data;
    } catch (error) {
      const msg = error?.cause?.message || error.message || 'Unknown error';
      console.error('[store] Failed to create signal in cloud:', msg);
      this.cloudSyncQueue.push({ type: 'create_signal', data: signal });
    }
  }

  async _recordTradeInCloud(trade) {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase
        .from('trades')
        .insert({
          bot_id: trade.botId,
          symbol: trade.symbol,
          strategy: trade.strategy,
          type: trade.type,
          entry: trade.entry,
          sl: trade.sl,
          tp: trade.tp,
          outcome: trade.outcome,
          pnl: trade.pnl,
          lot_size: trade.lotSize || 0.01,
          confidence: trade.confidence || {},
          timestamp: trade.time ? new Date(trade.time).toISOString() : new Date().toISOString(),
        });

      if (error) throw error;
    } catch (error) {
      const msg = error?.cause?.message || error.message || 'Unknown error';
      console.error('[store] Failed to record trade in cloud:', msg);
      this.cloudSyncQueue.push({ type: 'record_trade', data: trade });
    }
  }

  async _addLogToCloud(log) {
    if (!this.supabase) return;
    const targetUserId = this._getValidUserId();

    try {
      const { error } = await this.supabase
        .from('logs')
        .insert({
          user_id: targetUserId,
          text: log.text,
          type: log.type || 'info',
          time: log.time ? new Date(log.time).toISOString() : new Date().toISOString(),
        });

      if (error) throw error;
    } catch (error) {
      const msg = error?.cause?.message || error.message || 'Unknown error';
      console.error('[store] Failed to add log to cloud:', msg);
      // Logs are lower-value / high-volume — don't requeue to avoid unbounded growth
    }
  }

  getEngineStatus() {
    return {
      connected: this.state.connected,
      mt5Connected: this.state.mt5Connected,
      startedAt: this.state.startedAt,
    };
  }

  setConnectionStatus(connected) {
    this.state.connected = Boolean(connected);
    this.emit('engine_status', this.getEngineStatus());
    this._persist();
  }

  setMt5Status(connected) {
    this.state.mt5Connected = Boolean(connected);
    this.emit('engine_status', this.getEngineStatus());
    this._persist();
  }

  setAutoMt5(enabled) {
    this.state.autoMt5 = Boolean(enabled);
    this.emit('settings', { autoMt5: this.state.autoMt5 });
    this._persist();
  }

  getAutoMt5() {
    return this.state.autoMt5;
  }

  addLog(text, type = 'info') {
    const line = { text, type, time: Date.now() };
    this.state.logs.push(line);
    if (this.state.logs.length > 200) this.state.logs.shift();
    this.emit('log_line', line);
    this._persist();

    if (this.syncToCloud && this.supabase) {
      this.cloudSyncQueue.push({ type: 'add_log', data: line });
    }

    return line;
  }

  getLogs() {
    return this.state.logs.slice();
  }

  upsertBot(bot) {
    const current = this.state.bots.get(String(bot.id)) || {};
    const next = sanitizeBot({ ...current, ...bot });
    this.state.bots.set(String(next.id), next);
    this.emit('bots_list', this.getBotsList());
    this._persist();

    if (this.syncToCloud && this.supabase) {
      this.cloudSyncQueue.push({ type: 'upsert_bot', data: next });
    }

    return next;
  }

  removeBot(id) {
    this.state.bots.delete(String(id));
    this.emit('bots_list', this.getBotsList());
    this._persist();

    if (this.syncToCloud && this.supabase) {
      this.cloudSyncQueue.push({ type: 'remove_bot', data: { id } });
    }
  }

  getBot(id) {
    return this.state.bots.get(String(id)) || null;
  }

  listBots() {
    return Array.from(this.state.bots.values()).map(sanitizeBot);
  }

  getBotsList() {
    return this.listBots().map(bot => ({
      id: bot.id,
      userId: bot.userId,
      config: bot.config,
      isActive: bot.isActive,
      wins: bot.wins,
      losses: bot.losses,
      pnl: bot.pnl,
      openSignal: bot.openSignal,
      accountEquity: bot.accountEquity,
      sessionStart: bot.sessionStart,
    }));
  }

  recordTrade(trade) {
    const entry = { ...trade, time: trade.time || Date.now() };
    this.state.trades.unshift(entry);
    if (this.state.trades.length > 500) this.state.trades.pop();
    this.emit('trade_event', entry);
    this._persist();

    if (this.syncToCloud && this.supabase) {
      this.cloudSyncQueue.push({ type: 'record_trade', data: entry });
    }

    return entry;
  }

  getTrades() {
    return this.state.trades.slice();
  }

  async createSignal(botId, signal) {
    const signalData = {
      botId,
      ...signal,
      metadata: signal.metadata || {},
      created_at: new Date().toISOString(),
    };

    this.emit('new_signal', signalData);

    if (this.syncToCloud && this.supabase) {
      const result = await this._createSignalInCloud(signalData);
      return result;
    }

    return signalData;
  }

  async getPendingSignals(botId = null) {
    if (!this.supabase) {
      return this._getLocalPendingSignals(botId);
    }

    try {
      let query = this.supabase
        .from('signals')
        .select('*')
        .eq('is_processed', false)
        .order('created_at', { ascending: true });

      if (botId) {
        query = query.eq('bot_id', botId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[store] Failed to get pending signals:', error.message);
      return this._getLocalPendingSignals(botId);
    }
  }

  _getLocalPendingSignals(botId = null) {
    return [];
  }

  async markSignalProcessed(signalId) {
    if (!this.supabase) return;

    try {
      await this.supabase
        .from('signals')
        .update({
          is_processed: true,
          processed_at: new Date().toISOString()
        })
        .eq('id', signalId);
    } catch (error) {
      console.error('[store] Failed to mark signal processed:', error.message);
    }
  }

  async close() {
    if (this.cloudSyncQueue.length > 0) {
      await this._processCloudQueue();
    }
    this._persist();
  }

  snapshot() {
    return {
      engineStatus: this.getEngineStatus(),
      autoMt5: this.getAutoMt5(),
      bots: this.getBotsList(),
      logs: this.getLogs(),
      trades: this.getTrades(),
    };
  }
}