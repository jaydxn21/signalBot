const HTF_GRAN_MAP = { 60: 1800, 120: 3600, 180: 3600, 300: 3600, 600: 7200, 900: 14400, 1800: 14400, 3600: 86400, 14400: 604800 };

function normalizeSymbol(raw) {
  if (!raw) return raw;
  const map = {
    'Jump 10 Index': 'JD10',
    'Jump 25 Index': 'JD25',
    'Jump 50 Index': 'JD50',
    'Jump 75 Index': 'JD75',
    'Jump 100 Index': 'JD100',
  };
  return map[raw] || raw;
}

function makeRuntimeBot(snapshot) {
  return {
    id: String(snapshot.id),
    config: snapshot.config,
    candles: [],
    h4Candles: [],
    htfCandles: [],
    htfGran: HTF_GRAN_MAP[snapshot.config?.tf] || 14400,
    rsiState: { prevAvgGain: 0, prevAvgLoss: 0, initialized: false },
    openSignal: snapshot.openSignal || null,
    lastFiredMs: snapshot.lastFiredMs || 0,
    isActive: Boolean(snapshot.isActive),
    sessionStart: snapshot.sessionStart || null,
    wins: snapshot.wins || 0,
    losses: snapshot.losses || 0,
    pnl: snapshot.pnl || 0,
    accountEquity: snapshot.accountEquity || 10000,
  };
}

export class BotManager {
  constructor({ api, store, runner }) {
    this.api = api;
    this.store = store;
    this.runner = runner;
    this.bots = new Map();
    this.subscriptionRefs = new Map();
    this.symbolMap = {};
    this.restoreBots();
  }

  restoreBots() {
    for (const snapshot of this.store.listBots()) {
      const bot = makeRuntimeBot(snapshot);
      this.bots.set(bot.id, bot);
    }
  }

  listBots() {
    return this.store.getBotsList();
  }

  getBot(id) {
    return this.bots.get(String(id)) || null;
  }

  getCandles(id) {
    const bot = this.getBot(id);
    if (!bot) return null;
    return {
      candles: bot.candles.slice(),
      h4Candles: bot.h4Candles.slice(),
      htfCandles: bot.htfCandles.slice(),
    };
  }

  createBot(config, id = Date.now().toString()) {
    const bot = makeRuntimeBot({ id: String(id), config, isActive: false });
    this.bots.set(bot.id, bot);
    this.store.upsertBot(bot);
    this.store.addLog(`Created bot #${bot.id} — ${config.strategy} on ${config.symbol}`, 'info');
    return this.store.getBot(bot.id);
  }

  updateBot(id, config) {
    const bot = this.getBot(id);
    if (!bot) throw new Error(`Bot ${id} not found`);

    const wasActive = bot.isActive;
    const previous = { ...bot.config };
    if (wasActive) this.unsubscribeBot(bot);

    bot.config = config;
    bot.htfGran = HTF_GRAN_MAP[config.tf] || 14400;
    bot.candles = [];
    bot.h4Candles = [];
    bot.htfCandles = [];
    bot.rsiState = { prevAvgGain: 0, prevAvgLoss: 0, initialized: false };
    bot.openSignal = null;

    if (wasActive && this.store.getEngineStatus().connected) this.subscribeBot(bot);

    this.store.upsertBot(bot);
    this.store.addLog(`Updated bot #${bot.id} config ${previous.symbol}/${previous.tf} → ${config.symbol}/${config.tf}`, 'info');
    return this.store.getBot(bot.id);
  }

  startBot(id) {
    const bot = this.getBot(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    if (bot.isActive) return this.store.getBot(bot.id);

    bot.isActive = true;
    bot.sessionStart = Date.now();
    this.store.upsertBot(bot);
    this.store.addLog(`Started bot #${bot.id} — ${bot.config.strategy} on ${bot.config.symbol}`, 'info');

    if (this.store.getEngineStatus().connected) {
      this.subscribeBot(bot);
    } else {
      this.store.addLog(`Bot #${bot.id} queued until Deriv reconnects`, 'warn');
    }

    return this.store.getBot(bot.id);
  }

  stopBot(id) {
    const bot = this.getBot(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    if (!bot.isActive) return this.store.getBot(bot.id);

    bot.isActive = false;
    bot.openSignal = null;
    this.unsubscribeBot(bot);
    this.store.upsertBot(bot);
    this.store.addLog(`Stopped bot #${bot.id}`, 'info');
    return this.store.getBot(bot.id);
  }

  removeBot(id) {
    const bot = this.getBot(id);
    if (!bot) return;
    if (bot.isActive) this.unsubscribeBot(bot);
    this.bots.delete(String(id));
    this.store.removeBot(String(id));
    this.store.addLog(`Removed bot #${id}`, 'info');
  }

  subscribeBot(bot) {
    const keys = this._subscriptionKeys(bot);
    for (const [symbol, granularity] of keys) {
      const key = `${symbol}_${granularity}`;
      const nextCount = (this.subscriptionRefs.get(key) || 0) + 1;
      this.subscriptionRefs.set(key, nextCount);
      if (nextCount === 1) this.api.subscribe(symbol, granularity);
    }
  }

  unsubscribeBot(bot) {
    const keys = this._subscriptionKeys(bot);
    for (const [symbol, granularity] of keys) {
      const key = `${symbol}_${granularity}`;
      const currentCount = this.subscriptionRefs.get(key) || 0;
      if (currentCount <= 1) {
        this.subscriptionRefs.delete(key);
        this.api.forgetSymbol(symbol, granularity);
      } else {
        this.subscriptionRefs.set(key, currentCount - 1);
      }
    }
  }

  _subscriptionKeys(bot) {
    const keys = [[bot.config.symbol, bot.config.tf]];
    if (bot.htfGran) keys.push([bot.config.symbol, bot.htfGran]);
    if (bot.htfGran !== 14400) keys.push([bot.config.symbol, 14400]);
    return keys;
  }

  handleApiMessage(data) {
    if (data.error) {
      const req = data.echo_req || {};
      const sym = req.ticks_history || req.subscribe || '?';
      this.store.addLog(`API error [${sym}]: ${data.error.message}`, 'warn');
      return;
    }

    if (data.msg_type === 'authorize') {
      this.store.addLog(`Authorized as ${data.authorize?.loginid || 'unknown account'}`, 'info');
    }

    if (data.msg_type === 'active_symbols') {
      for (const symbol of data.active_symbols || []) {
        this.symbolMap[symbol.symbol] = symbol.display_name;
      }
      this.store.addLog(`Loaded ${Object.keys(this.symbolMap).length} symbols`, 'info');
      return;
    }

    if (data.msg_type === 'candles') {
      const gran = Number(data.echo_req?.granularity);
      const symbol = normalizeSymbol(data.echo_req?.ticks_history);
      const history = (data.candles || []).map(c => ({
        time: Number.parseInt(c.epoch, 10),
        open: Number.parseFloat(c.open),
        high: Number.parseFloat(c.high),
        low: Number.parseFloat(c.low),
        close: Number.parseFloat(c.close),
      }));

      for (const bot of this.bots.values()) {
        if (!bot.isActive || bot.config.symbol !== symbol) continue;
        if (gran === bot.config.tf) bot.candles = history.slice(-1000);
        if (gran === 14400) bot.h4Candles = history.slice(-500);
        if (gran === bot.htfGran) bot.htfCandles = history.slice(-500);
      }
      return;
    }

    if (data.msg_type === 'ohlc') {
      const gran = Number(data.echo_req?.granularity);
      const symbol = normalizeSymbol(data.ohlc?.symbol || data.echo_req?.ticks_history);
      const bar = {
        time: Number.parseInt(data.ohlc.open_time, 10),
        open: Number.parseFloat(data.ohlc.open),
        high: Number.parseFloat(data.ohlc.high),
        low: Number.parseFloat(data.ohlc.low),
        close: Number.parseFloat(data.ohlc.close),
      };

      for (const bot of this.bots.values()) {
        if (bot.isActive && bot.config.symbol === symbol) {
          this.runner.processBar(bot, bar, gran).then(() => {
            this.store.upsertBot(bot);
          }).catch((error) => {
            this.store.addLog(`Bot #${bot.id} processing error: ${error.message}`, 'error');
          });
        }
      }
    }
  }

  onConnectionRestored() {
    this.subscriptionRefs.clear();
    this.api.fetchActiveSymbols();
    for (const bot of this.bots.values()) {
      if (bot.isActive) this.subscribeBot(bot);
    }
  }
}
