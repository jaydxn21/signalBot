const TF_LABEL = {
    60: 'M1',
    120: 'M2',
    300: 'M5',
    600: 'M10',
    900: 'M15',
    1800: 'M30',
    3600: 'H1',
    14400: 'H4',
    86400: 'D1',
};

const HTF_GRAN_MAP = {
    60: 1800,
    120: 3600,
    180: 3600,
    300: 3600,
    600: 7200,
    900: 14400,
    1800: 14400,
    3600: 86400,
    14400: 604800,
};

function normalizeSymbol(raw) {
    const map = {
        'Jump 10 Index': 'JD10',
        'Jump 25 Index': 'JD25',
        'Jump 50 Index': 'JD50',
        'Jump 75 Index': 'JD75',
        'Jump 100 Index': 'JD100',
    };
    return map[raw] || raw;
}

export class BotManager {
    constructor({ store, derivClient, strategyRunner }) {
        this.store = store;
        this.derivClient = derivClient;
        this.strategyRunner = strategyRunner;
        this._nextId = this._initNextId();

        this.derivClient.on('candles', (data) => this._onCandles(data));
        this.derivClient.on('ohlc', (data) => this._onOhlc(data));
    }

    _initNextId() {
        const ids = this.store.getBots().map((bot) => Number(bot.id)).filter(Number.isFinite);
        const max = ids.length ? Math.max(...ids) : 0;
        return max + 1;
    }

    createBot(config) {
        const id = String(this._nextId++);
        const bot = {
            id,
            config: {
                strategy: config.strategy || 'breakout_trend',
                symbol: normalizeSymbol(config.symbol || 'R_100'),
                tf: Number(config.tf || 300),
                lotSize: Number(config.lotSize || 0.01),
            },
            candles: [],
            htfCandles: [],
            h4Candles: [],
            htfGran: 14400,
            rsiState: { prevAvgGain: 0, prevAvgLoss: 0, initialized: false },
            openSignal: null,
            isActive: false,
            wins: 0,
            losses: 0,
            pnl: 0,
            accountEquity: 10000,
            lastFiredMs: 0,
        };
        this.store.setBot(bot);
        this.store.pushLog(`Created bot #${id} (${bot.config.strategy} ${bot.config.symbol})`, 'info');
        return bot;
    }

    startBot(id) {
        const bot = this.store.getBot(id);
        if (!bot) throw new Error(`Bot #${id} not found`);
        if (bot.isActive) {
            this._subscribeBot(bot);
            return bot;
        }

        bot.isActive = true;
        bot.htfGran = HTF_GRAN_MAP[bot.config.tf] || 14400;
        this.store.setBot(bot);
        this._subscribeBot(bot);
        this.store.pushLog(`Bot #${id} started (${bot.config.symbol} ${TF_LABEL[bot.config.tf] || bot.config.tf})`, 'info');
        return bot;
    }

    stopBot(id) {
        const bot = this.store.getBot(id);
        if (!bot) throw new Error(`Bot #${id} not found`);
        if (!bot.isActive) return bot;
        bot.isActive = false;
        this.store.setBot(bot);
        this.derivClient.forgetSymbol(bot.config.symbol, bot.config.tf);
        this.derivClient.forgetSymbol(bot.config.symbol, bot.htfGran || 14400);
        this.store.pushLog(`Bot #${id} stopped`, 'neutral');
        return bot;
    }

    removeBot(id) {
        const bot = this.store.getBot(id);
        if (!bot) throw new Error(`Bot #${id} not found`);
        if (bot.isActive) this.stopBot(id);
        this.store.removeBot(id);
        this.store.pushLog(`Bot #${id} removed`, 'warn');
    }

    getBotCandles(id) {
        const bot = this.store.getBot(id);
        if (!bot) throw new Error(`Bot #${id} not found`);
        return bot.candles || [];
    }

    listBots() {
        return this.store.botsListPayload();
    }

    resubscribeActiveBots() {
        for (const bot of this.store.getBots()) {
            if (bot.isActive) {
                this._subscribeBot(bot);
            }
        }
    }

    _subscribeBot(bot) {
        this.derivClient.subscribe(bot.config.symbol, bot.config.tf);
        this.derivClient.subscribe(bot.config.symbol, bot.htfGran || 14400);
    }

    _onCandles(data) {
        const gran = Number(data.echo_req?.granularity || 0);
        const symbol = normalizeSymbol(data.echo_req?.ticks_history);
        const history = (data.candles || []).map((candle) => ({
            time: Number(candle.epoch),
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
        }));
        for (const bot of this.store.getBots()) {
            if (!bot.isActive || bot.config.symbol !== symbol) continue;
            if (gran === bot.config.tf) bot.candles = history.slice(-1000);
            if (gran === (bot.htfGran || 14400)) bot.htfCandles = history.slice(-500);
            this.store.setBot(bot);
        }
    }

    async _onOhlc(data) {
        const gran = Number(data.echo_req?.granularity || 0);
        const symbol = normalizeSymbol(data.ohlc?.symbol || data.echo_req?.ticks_history);
        const bar = {
            time: Number(data.ohlc.open_time),
            open: Number(data.ohlc.open),
            high: Number(data.ohlc.high),
            low: Number(data.ohlc.low),
            close: Number(data.ohlc.close),
        };

        for (const bot of this.store.getBots()) {
            if (!bot.isActive || bot.config.symbol !== symbol) continue;
            await this.strategyRunner.processBar(bot, bar, gran);
            this.store.setBot(bot);
        }
    }
}
