import { Indicators } from '../js/indicators.js';
import { PositionSizing } from '../js/position-sizing.js';

const STRATEGY_CACHE = new Map();

function pointValue(symbol) {
    const map = {
        CRASH1000: 0.41,
        CRASH_1000: 0.41,
        BOOM1000: 0.41,
        BOOM_1000: 0.41,
        CRASH500: 0.41,
        BOOM500: 0.41,
        CRASH_500: 0.41,
        BOOM_500: 0.41,
        cryBTCUSD: 0.01,
        BTCUSD: 0.01,
        JD10: 0.41,
        JD25: 0.41,
        JD50: 0.41,
        JD75: 0.41,
        JD100: 0.41,
        frxEURUSD: 10.0,
        frxGBPUSD: 10.0,
        frxUSDJPY: 9.35,
        frxAUDUSD: 10.0,
        frxUSDCAD: 10.0,
        frxUSDCHF: 10.0,
        frxEURGBP: 12.5,
        frxGBPJPY: 12.5,
    };
    return map[symbol] || 0.41;
}

async function loadStrategy(strategyName) {
    if (STRATEGY_CACHE.has(strategyName)) return STRATEGY_CACHE.get(strategyName);
    const module = await import(`../js/strategies/${strategyName}.js`);
    const Strategy = module.default || Object.values(module).find((v) => typeof v?.checkEntry === 'function' || typeof v === 'function');
    if (!Strategy) {
        throw new Error(`Strategy "${strategyName}" could not be loaded`);
    }
    STRATEGY_CACHE.set(strategyName, Strategy);
    return Strategy;
}

export class StrategyRunner {
    constructor({ store, mt5Bridge }) {
        this.store = store;
        this.mt5Bridge = mt5Bridge;
        PositionSizing.init(10000);
        PositionSizing.resetSession(10000);
    }

    async processBar(bot, bar, granularity) {
        if (granularity === bot.htfGran) {
            this._upsertCandle(bot.htfCandles, bar, 500);
            return;
        }
        if (granularity !== bot.config.tf) {
            return;
        }

        this._upsertCandle(bot.candles, bar, 1000);
        this.store.emit('candle_update', { botId: bot.id, candle: bar });
        this._checkOutcome(bot);

        if (bot.openSignal) return;
        if (bot.candles.length < 21) return;

        const atr = Indicators.calculateATR(bot.candles);
        const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
        await this._runStrategy(bot, bar, atr, rsi);
    }

    _upsertCandle(candles, bar, max = 500) {
        const last = candles[candles.length - 1];
        if (last && last.time === bar.time) {
            candles[candles.length - 1] = bar;
        } else {
            candles.push(bar);
            if (candles.length > max) candles.shift();
        }
    }

    async _runStrategy(bot, bar, atr, rsi) {
        const cooldownMs = (bot.config.tf || 300) * 2000;
        const now = Date.now();
        if (bot.lastFiredMs && now - bot.lastFiredMs < cooldownMs) return;

        let signal = null;
        try {
            const Strategy = await loadStrategy(bot.config.strategy);
            if (typeof Strategy.checkEntry !== 'function') return;
            signal = await Strategy.checkEntry(bot.candles, atr, bot.config.symbol);
        } catch (error) {
            this.store.pushLog(`Strategy error (${bot.config.strategy}): ${error.message}`, 'warn');
            return;
        }

        if (!signal) return;
        bot.lastFiredMs = now;
        this._fireSignal(bot, signal, bar, atr, rsi);
    }

    _fireSignal(bot, signal, bar, atr) {
        let type = signal?.type || signal?.direction;
        if (type === 'LONG') type = 'BUY';
        if (type === 'SHORT') type = 'SELL';
        if (!type) return;

        if (!atr) return;
        const slMult = signal.slMultiplier || 1;
        const tpMult = signal.tpMultiplier || 1.5;
        const slDist = signal._slDist || atr * slMult;
        const tpDist = signal._tpDist || atr * tpMult;
        const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
        const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

        let lotSize = Number(bot.config.lotSize || 0.01);
        try {
            const sizing = PositionSizing.calculateLotSize({
                symbol: bot.config.symbol,
                accountEquity: bot.accountEquity || 10000,
                atr,
                slMultiplier: slMult,
                riskPercent: 0.75,
                useStreakScaling: false,
            });
            if (sizing.allowed && sizing.lotSize > 0) {
                lotSize = sizing.lotSize;
            }
        } catch (error) {
            this.store.pushLog(`Position sizing fallback for ${bot.config.symbol}: ${error.message}`, 'warn');
        }

        bot.openSignal = {
            type,
            entry: bar.close,
            sl,
            tp,
            lotSize: Math.max(0.01, Math.min(0.05, Number(lotSize))),
            strategy: bot.config.strategy,
            openedAt: Date.now(),
        };

        this.store.pushLog(
            `Signal ${type} ${bot.config.symbol} @ ${bar.close.toFixed(4)} (SL ${sl.toFixed(4)} / TP ${tp.toFixed(4)})`,
            type === 'BUY' ? 'buy' : 'sell',
        );
        this.store.pushTrade({
            botId: bot.id,
            type: 'signal',
            signalType: type,
            symbol: bot.config.symbol,
            entry: bar.close,
            sl,
            tp,
            lotSize: bot.openSignal.lotSize,
            at: Date.now(),
        });
        this.mt5Bridge.sendSignal({
            action: type,
            symbol: bot.config.symbol,
            lotSize: bot.openSignal.lotSize,
        });
    }

    _checkOutcome(bot) {
        if (!bot.openSignal || bot.candles.length < 2) return;
        const closed = bot.candles[bot.candles.length - 2];
        if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
        bot.openSignal.lastCheckedTime = closed.time;

        const { type, entry, sl, tp, lotSize } = bot.openSignal;
        let hit = null;
        if (type === 'BUY') {
            if (closed.low <= sl) hit = 'SL';
            else if (closed.high >= tp) hit = 'TP';
        } else {
            if (closed.high >= sl) hit = 'SL';
            else if (closed.low <= tp) hit = 'TP';
        }
        if (!hit) return;

        const pv = pointValue(bot.config.symbol);
        const slDist = Math.abs(entry - sl);
        const tpDist = Math.abs(tp - entry);
        const pnlAmount = (hit === 'TP' ? tpDist : -slDist) * pv * (lotSize || 0.01);

        bot.pnl = Number((bot.pnl + pnlAmount).toFixed(2));
        bot.accountEquity = (bot.accountEquity || 10000) + pnlAmount;
        if (hit === 'TP') bot.wins += 1;
        if (hit === 'SL') bot.losses += 1;

        PositionSizing.updateAfterTrade(hit, pnlAmount, bot.accountEquity);
        this.store.pushTrade({
            botId: bot.id,
            type: hit === 'TP' ? 'tp' : 'sl',
            signalType: type,
            symbol: bot.config.symbol,
            pnl: pnlAmount,
            entry,
            sl,
            tp,
            at: Date.now(),
        });
        this.store.pushLog(
            `${hit} ${bot.config.symbol} ${pnlAmount >= 0 ? '+' : ''}${pnlAmount.toFixed(2)}`,
            hit === 'TP' ? 'buy' : 'sell',
        );
        bot.openSignal = null;
    }
}
