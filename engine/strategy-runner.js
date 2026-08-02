// engine/strategy-runner.js — Headless trade logic extracted from signal-bot.js
//
// processBar, _runStrategy, fireSignal, and checkOutcome live here.
// All UI/chart side-effects have been replaced with events on botManager.
//
// Events emitted via botManager:
//   'signal'        ({ botId, symbol, type, price, label, confidence })
//   'candle_update' ({ botId, symbol, tf, bar })
//   'trade_event'   (via botManager.recordTrade)
//   'log'           (via botManager.log)

import { botManager } from './bot-manager.js';
import { Indicators }  from '../js/indicators.js';
import { PositionSizing } from '../js/position-sizing.js';

// ─── SYMBOL / TF HELPERS ─────────────────────────────────────────────────

const TF_LABEL = {
    60:'M1', 120:'M2', 300:'M5', 600:'M10',
    900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1',
};

const POINT_VALUE = {
    'CRASH1000':0.41,'CRASH_1000':0.41,'BOOM1000':0.41,'BOOM_1000':0.41,
    'CRASH500':0.41,'BOOM500':0.41,'CRASH_500':0.41,'BOOM_500':0.41,
    'cryBTCUSD':0.01,'BTCUSD':0.01,
    'JD10':0.41,'JD25':0.41,'JD50':0.41,'JD75':0.41,'JD100':0.41,
    'frxEURUSD':10.0,'frxGBPUSD':10.0,'frxUSDJPY':9.35,
    'frxAUDUSD':10.0,'frxUSDCAD':10.0,'frxUSDCHF':10.0,
    'frxEURGBP':12.50,'frxGBPJPY':12.50,
    'OTC_NDX':1.0,'OTC_SPC':1.0,'OTC_DJI':1.0,
};

function _pointValue(symbol) { return POINT_VALUE[symbol] ?? 0.41; }

// ─── DYNAMIC STRATEGY CACHE ──────────────────────────────────────────────

const _strategyCache = {};

async function _loadStrategy(name) {
    if (_strategyCache[name]) return _strategyCache[name];

    try {
        const mod = await import(`../js/strategies/${name}.js`);
        const Cls = mod.default ?? Object.values(mod).find(v => typeof v === 'function');
        if (Cls) { _strategyCache[name] = Cls; }
        return Cls ?? null;
    } catch {
        return null;
    }
}

// ─── PROCESS BAR ─────────────────────────────────────────────────────────

/**
 * Main entry-point called for every incoming OHLC bar from the Deriv feed.
 *
 * @param {object} bot  - BotState from botManager
 * @param {object} bar  - { time, open, high, low, close }
 * @param {number} gran - granularity in seconds
 */
export async function processBar(bot, bar, gran) {
    // ── jump75 multi-tf candle storage ────────────────────────────────
    if (bot.config.strategy === 'jump75') {
        if (gran === 300) {
            bot.m5Candles.push(bar);
            if (bot.m5Candles.length > 150) bot.m5Candles.shift();
            bot.lastM5CloseTime = bar.time;
        }
        if (gran === 900) {
            bot.m15Candles.push(bar);
            if (bot.m15Candles.length > 80) bot.m15Candles.shift();
            bot.lastM15CloseTime = bar.time;
        }
        if (gran === 14400) {
            bot.h4Candles.push(bar);
            if (bot.h4Candles.length > 50) bot.h4Candles.shift();
            bot.lastH4CloseTime = bar.time;
        }
    }

    // ── H4 candle storage (shared) ────────────────────────────────────
    if (gran === 14400) {
        const last = bot.h4Candles[bot.h4Candles.length - 1];
        if (last && last.time === bar.time) bot.h4Candles[bot.h4Candles.length - 1] = bar;
        else bot.h4Candles.push(bar);
        if (bot.h4Candles.length > 500) bot.h4Candles.shift();
    }

    // ── HTF candle storage ────────────────────────────────────────────
    if (gran === bot.htfGran) {
        const lastH = bot.htfCandles[bot.htfCandles.length - 1];
        if (lastH && lastH.time === bar.time) bot.htfCandles[bot.htfCandles.length - 1] = bar;
        else bot.htfCandles.push(bar);
        if (bot.htfCandles.length > 500) bot.htfCandles.shift();
    }

    // ── jump75 path exits here ────────────────────────────────────────
    if (bot.config.strategy === 'jump75' && gran === 300) {
        const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
        const atr = Indicators.calculateATR(bot.candles);
        await _runStrategy(bot, bar, atr, rsi);
        return;
    }

    if (gran !== bot.config.tf) return;

    // ── LTF candle upsert ─────────────────────────────────────────────
    const last = bot.candles[bot.candles.length - 1];
    const isNewCandle = !(last && last.time === bar.time);
    if (!isNewCandle) {
        bot.candles[bot.candles.length - 1] = bar;
    } else {
        bot.candles.push(bar);
        if (bot.candles.length > 1000) bot.candles.shift();
    }

    // Notify dashboard of the updated candle
    botManager.emit('candle_update', {
        botId:  bot.id,
        symbol: bot.config.symbol,
        tf:     bot.config.tf,
        bar,
        isNew: isNewCandle,
    });

    if (bot.candles.length < 20) return;

    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const atr = Indicators.calculateATR(bot.candles);

    // HUD metrics
    let marketCond = '—';
    if (bot.candles.length >= 20) {
        const closes  = bot.candles.map(c => c.close);
        const lastPx  = closes[closes.length - 1];
        const sma20   = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        marketCond    = lastPx > sma20 ? 'TRENDING' : 'RANGING';
    }

    botManager.emit('hud_update', { botId: bot.id, rsi, atr, marketCond });

    checkOutcome(bot);
    await _runStrategy(bot, bar, atr, rsi);
}

// ─── RUN STRATEGY ────────────────────────────────────────────────────────

async function _runStrategy(bot, bar, atr, rsi) {
    const strategyName = bot.config.strategy;
    const now          = Date.now();

    let StrategyClass = _strategyCache[strategyName];
    if (!StrategyClass) {
        StrategyClass = await _loadStrategy(strategyName);
    }

    if (!StrategyClass) {
        botManager.log('error', `Strategy "${strategyName}" not found`);
        return;
    }

    if (typeof StrategyClass.checkEntry !== 'function') {
        botManager.log('error', `Strategy "${strategyName}" missing checkEntry`);
        return;
    }

    const cooldownMs    = (bot.config.tf || 300) * 2 * 1000;
    const timeSinceLast = now - bot.lastFiredMs;
    if (timeSinceLast < cooldownMs && bot.lastFiredMs > 0) return;

    let signal = null;
    try {
        signal = await StrategyClass.checkEntry(bot.candles, atr, bot.config.symbol);
    } catch (err) {
        botManager.log('error', `Strategy ${strategyName} error: ${err.message}`);
        return;
    }

    if (!signal) return;

    bot.lastFiredMs = now;
    botManager.log('info',
        `🎯 ${signal.type} signal on ${bot.config.symbol} @ ${bar.close.toFixed(4)}`
    );

    await fireSignal(bot, signal, bar, atr, rsi);
}

// ─── FIRE SIGNAL ─────────────────────────────────────────────────────────

export async function fireSignal(bot, signal, bar, atr, rsi) {
    let type = signal?.type || signal?.direction;
    if (type === 'LONG')  type = 'BUY';
    if (type === 'SHORT') type = 'SELL';
    if (!type || type === 'BUY/SELL') type = 'BUY';

    signal.type = type;
    const label = signal.label || type;

    const confidence = {
        score:   signal.score || 50,
        grade:   signal.score >= 70 ? 'A' : signal.score >= 55 ? 'B' : 'C',
        color:   signal.score >= 70 ? '#34d399' : signal.score >= 55 ? '#fbbf24' : '#a78bfa',
        factors: signal.factors || [],
    };

    // Emit signal event — ws-server forwards this to dashboard
    botManager.emit('signal', {
        botId:      bot.id,
        symbol:     bot.config.symbol,
        strategy:   bot.config.strategy,
        type,
        price:      bar.close,
        label,
        confidence,
        ts:         Date.now(),
    });

    if (!atr) return;

    let slDist, tpDist, slMult, tpMult;

    if (signal._slDist && signal._tpDist) {
        slDist = signal._slDist;
        tpDist = signal._tpDist;
        slMult = slDist / atr;
        tpMult = tpDist / atr;
    } else {
        tpMult = signal.tpMultiplier || 1.5;
        slMult = signal.slMultiplier || 1.0;
        slDist = atr * slMult;
        tpDist = atr * tpMult;
    }

    const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
    const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

    // Position sizing
    let lotSize = 0.01;
    try {
        const sizing = PositionSizing.calculateLotSize({
            symbol:          bot.config.symbol,
            accountEquity:   bot.accountEquity || botManager.session.accountEquity,
            atr,
            slMultiplier:    slMult,
            riskPercent:     0.75,
            useStreakScaling: false,
        });
        if (sizing.allowed && sizing.lotSize > 0) {
            lotSize = Math.max(0.01, sizing.lotSize);
        }
    } catch (_) { /* keep default */ }

    lotSize = Math.min(0.05, Math.max(0.01, lotSize));

    bot.openSignal = { type, sl, tp, entry: bar.close, lotSize, strategy: bot.config.strategy };
    bot.lastConfidence = confidence;

    botManager.log('info',
        `Signal stored: ${type} ${bot.config.symbol} SL=${sl.toFixed(4)} TP=${tp.toFixed(4)} lot=${lotSize}`
    );
}

// ─── CHECK OUTCOME ───────────────────────────────────────────────────────

export function checkOutcome(bot) {
    if (!bot.openSignal) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
    bot.openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry, lotSize: sigLot } = bot.openSignal;
    let hit = null;

    if (type === 'BUY') {
        if (closed.low <= sl)  hit = 'SL';
        else if (closed.high >= tp) hit = 'TP';
    } else {
        if (closed.high >= sl) hit = 'SL';
        else if (closed.low <= tp)  hit = 'TP';
    }

    if (!hit) return;

    const lotSizeUsed = sigLot || bot.config.lotSize || 0.01;
    const pv          = _pointValue(bot.config.symbol);
    const slDist      = Math.abs(entry - sl);
    const tpDist      = Math.abs(tp - entry);
    const pnlAmt      = hit === 'TP'
        ? lotSizeUsed * pv * tpDist
        : lotSizeUsed * pv * slDist;

    PositionSizing.updateAfterTrade(
        hit,
        hit === 'TP' ? pnlAmt : -pnlAmt,
        botManager.session.accountEquity + (hit === 'TP' ? pnlAmt : -pnlAmt)
    );

    botManager.recordTrade({
        botId:    bot.id,
        symbol:   bot.config.symbol,
        strategy: bot.config.strategy,
        type,
        entry,
        sl,
        tp,
        outcome:  hit,
        pnl:      pnlAmt,
    });

    botManager.log(
        hit === 'TP' ? 'info' : 'warn',
        `${hit === 'TP' ? '✓ TP' : '✗ SL'} hit ${hit === 'TP' ? '+' : '-'}$${pnlAmt.toFixed(2)} on ${bot.config.symbol}`
    );

    bot.openSignal = null;
}
