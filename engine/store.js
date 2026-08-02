import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

function sanitizeBot(bot = {}) {
  return {
    id: bot.id,
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
  constructor({ persistPath, autoMt5 = true }) {
    super();
    this.persistPath = persistPath;
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
  }

  _load() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.state.connected = false;
      this.state.mt5Connected = false;
      this.state.autoMt5 = raw.autoMt5 ?? this.state.autoMt5;
      this.state.startedAt = raw.startedAt || this.state.startedAt;
      this.state.logs = Array.isArray(raw.logs) ? raw.logs.slice(-200) : [];
      this.state.trades = Array.isArray(raw.trades) ? raw.trades.slice(-500) : [];
      for (const bot of Array.isArray(raw.bots) ? raw.bots : []) {
        if (bot?.id != null) this.state.bots.set(String(bot.id), sanitizeBot(bot));
      }
    } catch (error) {
      console.error('[store] Failed to load persisted state:', error.message);
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
    return next;
  }

  removeBot(id) {
    this.state.bots.delete(String(id));
    this.emit('bots_list', this.getBotsList());
    this._persist();
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
    return entry;
  }

  getTrades() {
    return this.state.trades.slice();
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
