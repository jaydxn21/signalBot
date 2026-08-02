import { Indicators } from '../js/indicators.js';
import { PositionSizing } from '../js/position-sizing.js';
import BreakoutTrendStrategy from '../js/strategies/breakout_trend.js';

const TF_LABEL = {
  60: 'M1', 120: 'M2', 300: 'M5', 600: 'M10',
  900: 'M15', 1800: 'M30', 3600: 'H1', 14400: 'H4', 86400: 'D1',
};

const MT5_SYMBOL_MAP = {
  stpRNG: 'Step Index', STEP: 'Step Index',
  'Step Index 100': 'Step Index 100',
  'Crash 1000 Index': 'Crash 1000 Index',
  'Boom 1000 Index': 'Boom 1000 Index',
  'Crash 500 Index': 'Crash 500 Index',
  'Boom 500 Index': 'Boom 500 Index',
  'Volatility 10 Index': 'Volatility 10 Index',
  'Volatility 25 Index': 'Volatility 25 Index',
  'Volatility 50 Index': 'Volatility 50 Index',
  'Volatility 75 Index': 'Volatility 75 Index',
  'Volatility 100 Index': 'Volatility 100 Index',
  'Jump 10 Index': 'Jump 10 Index',
  'Jump 25 Index': 'Jump 25 Index',
  'Jump 50 Index': 'Jump 50 Index',
  'Jump 75 Index': 'Jump 75 Index',
  'Jump 100 Index': 'Jump 100 Index',
  OTC_NDX: 'US Tech 100', OTC_SPC: 'US 500', OTC_DJI: 'Wall Street 30',
};

const SYMBOL_MAP = {
  R_100: 'Volatility 100 Index', R_75: 'Volatility 75 Index', R_50: 'Volatility 50 Index', R_25: 'Volatility 25 Index', R_10: 'Volatility 10 Index',
  '1HZ100V': 'Volatility 100 (1s) Index', '1HZ75V': 'Volatility 75 (1s) Index', '1HZ50V': 'Volatility 50 (1s) Index', '1HZ25V': 'Volatility 25 (1s) Index', '1HZ10V': 'Volatility 10 (1s) Index',
  cryBTCUSD: 'BTCUSD', cryETHUSD: 'ETHUSD', cryLTCUSD: 'LTCUSD', cryXRPUSD: 'XRPUSD',
  frxXAUUSD: 'XAUUSD', frxXAGUSD: 'XAGUSD', frxEURUSD: 'EURUSD', frxGBPUSD: 'GBPUSD', frxUSDJPY: 'USDJPY', frxAUDUSD: 'AUDUSD', frxUSDCAD: 'USDCAD', frxUSDCHF: 'USDCHF', frxEURGBP: 'EURGBP', frxGBPJPY: 'GBPJPY',
  JD10: 'Jump 10 Index', JD25: 'Jump 25 Index', JD50: 'Jump 50 Index', JD75: 'Jump 75 Index', JD100: 'Jump 100 Index',
  CRASH1000: 'Crash 1000 Index', BOOM1000: 'Boom 1000 Index', CRASH_1000: 'Crash 1000 Index', BOOM_1000: 'Boom 1000 Index',
  CRASH500: 'Crash 500 Index', BOOM500: 'Boom 500 Index', CRASH_500: 'Crash 500 Index', BOOM_500: 'Boom 500 Index',
  stpRNG: 'Step Index', STEP: 'Step Index',
};

const STRATEGIES = {
  breakout_trend: BreakoutTrendStrategy,
};

function pointValue(symbol) {
  if (/frxEURUSD|frxGBPUSD|frxAUDUSD|frxUSDCAD|frxUSDCHF/.test(symbol)) return 100000;
  if (/frxUSDJPY|frxGBPJPY/.test(symbol)) return 1000;
  if (/cryBTC|cryETH|cryLTC|cryXRP/.test(symbol)) return 1;
  if (/XAU|XAG/.test(symbol)) return 100;
  return 1;
}

export class StrategyRunner {
  constructor({ store, mt5Bridge }) {
    this.store = store;
    this.mt5Bridge = mt5Bridge;
    PositionSizing.init(10000);
    PositionSizing.resetSession(10000);
  }

  async processBar(bot, bar, gran) {
    if (gran === 14400) {
      const lastH4 = bot.h4Candles[bot.h4Candles.length - 1];
      if (lastH4 && lastH4.time === bar.time) bot.h4Candles[bot.h4Candles.length - 1] = bar;
      else bot.h4Candles.push(bar);
      if (bot.h4Candles.length > 500) bot.h4Candles.shift();
    }

    if (gran === bot.htfGran) {
      const lastHtf = bot.htfCandles[bot.htfCandles.length - 1];
      if (lastHtf && lastHtf.time === bar.time) bot.htfCandles[bot.htfCandles.length - 1] = bar;
      else bot.htfCandles.push(bar);
      if (bot.htfCandles.length > 500) bot.htfCandles.shift();
    }

    if (gran !== bot.config.tf) return;

    const last = bot.candles[bot.candles.length - 1];
    const isNewCandle = !(last && last.time === bar.time);
    if (isNewCandle) {
      bot.candles.push(bar);
      if (bot.candles.length > 1000) bot.candles.shift();
    } else {
      bot.candles[bot.candles.length - 1] = bar;
    }

    this.store.emit('candle_update', { botId: bot.id, candle: bar, granularity: gran });

    if (bot.candles.length < 20) return;

    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const atr = Indicators.calculateATR(bot.candles);

    this.checkOutcome(bot);
    await this.runStrategy(bot, bar, atr, rsi);
  }

  async runStrategy(bot, bar, atr, rsi) {
    const strategyName = bot.config.strategy;
    const StrategyClass = STRATEGIES[strategyName];
    const now = Date.now();

    if (!StrategyClass || typeof StrategyClass.checkEntry !== 'function') {
      this.store.addLog(`Strategy "${strategyName}" is unavailable`, 'error');
      return;
    }

    const cooldownMs = (bot.config.tf || 300) * 2 * 1000;
    if (now - bot.lastFiredMs < cooldownMs && bot.lastFiredMs > 0) return;

    let signal = null;
    try {
      signal = await StrategyClass.checkEntry(bot.candles, atr, bot.config.symbol);
    } catch (error) {
      this.store.addLog(`Strategy error on bot #${bot.id}: ${error.message}`, 'error');
      return;
    }

    if (!signal) return;

    bot.lastFiredMs = now;
    this.store.addLog(`Signal ${signal.type} on ${bot.config.symbol} ${TF_LABEL[bot.config.tf] || bot.config.tf}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.reason) this.store.addLog(`Reason: ${signal.reason}`, 'info');
    await this.fireSignal(bot, signal, bar, atr, rsi);
  }

  async fireSignal(bot, signal, bar, atr, rsi) {
    let type = signal?.type || signal?.direction;
    if (type === 'LONG') type = 'BUY';
    if (type === 'SHORT') type = 'SELL';
    if (!type || type === 'BUY/SELL') type = 'BUY';
    if (!atr) return;

    let slDist;
    let tpDist;
    let slMult = signal.slMultiplier || 1.0;
    let tpMult = signal.tpMultiplier || 1.5;

    if (signal._slDist && signal._tpDist) {
      slDist = signal._slDist;
      tpDist = signal._tpDist;
      slMult = slDist / atr;
      tpMult = tpDist / atr;
    } else {
      slDist = atr * slMult;
      tpDist = atr * tpMult;
    }

    const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
    const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;
    const accountEquity = bot.accountEquity || 10000;

    let lotSize = bot.config.lotSize || 0.01;
    try {
      const sizing = PositionSizing.calculateLotSize({
        symbol: bot.config.symbol,
        accountEquity,
        atr,
        slMultiplier: slMult,
        riskPercent: 0.75,
        useStreakScaling: false,
      });
      if (sizing.allowed && sizing.lotSize > 0) {
        lotSize = Math.max(0.01, sizing.lotSize);
      }
    } catch {}
    lotSize = Math.min(Math.max(lotSize, 0.01), Math.max(bot.config.lotSize || 0.01, 0.01));

    const confidence = {
      score: signal.score || 50,
      grade: signal.score >= 70 ? 'A' : signal.score >= 55 ? 'B' : 'C',
      color: signal.score >= 70 ? '#34d399' : signal.score >= 55 ? '#fbbf24' : '#a78bfa',
      factors: signal.factors || [],
    };

    bot.openSignal = {
      type,
      sl,
      tp,
      entry: bar.close,
      lotSize,
      strategy: bot.config.strategy,
      label: signal.label || type,
      confidence,
      atr,
      rsi,
    };

    this.store.upsertBot(bot);
    this.store.emit('trade_event', {
      botId: bot.id,
      type: 'signal',
      signal: {
        type,
        entry: bar.close,
        sl,
        tp,
        lotSize,
        label: signal.label || type,
        confidence,
      },
      time: Date.now(),
    });

    if (this.store.getAutoMt5()) {
      const derivDisplay = SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
      const mt5Symbol = MT5_SYMBOL_MAP[bot.config.symbol] || MT5_SYMBOL_MAP[derivDisplay] || derivDisplay;
      this.mt5Bridge.send({
        action: type.toLowerCase(),
        symbol: mt5Symbol,
        price: bar.close,
        sl,
        tp,
        lotSize,
        volume: lotSize,
        qualityScore: confidence.score,
        aiScore: confidence.score,
        timestamp: Date.now(),
        source: `signalbot-engine:${bot.id}`,
      });
    }
  }

  checkOutcome(bot) {
    if (!bot.openSignal || bot.candles.length < 2) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
    bot.openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry, lotSize } = bot.openSignal;
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
    const slPriceDist = Math.abs(entry - sl);
    const tpPriceDist = Math.abs(tp - entry);
    const pnlAmt = hit === 'TP' ? lotSize * pv * tpPriceDist : lotSize * pv * slPriceDist;
    const signedPnL = hit === 'TP' ? pnlAmt : -pnlAmt;

    bot.accountEquity = (bot.accountEquity || 10000) + signedPnL;
    PositionSizing.updateAfterTrade(hit, signedPnL, bot.accountEquity);

    if (hit === 'TP') bot.wins += 1;
    else bot.losses += 1;
    bot.pnl += signedPnL;

    const openSignal = bot.openSignal;
    bot.openSignal = null;
    this.store.upsertBot(bot);

    const trade = this.store.recordTrade({
      botId: bot.id,
      symbol: bot.config.symbol,
      strategy: bot.config.strategy,
      type,
      entry,
      sl,
      tp,
      outcome: hit,
      pnl: signedPnL,
      lotSize,
      confidence: openSignal.confidence,
      time: Date.now(),
    });

    this.store.addLog(`${hit} hit on bot #${bot.id} ${signedPnL >= 0 ? '+' : ''}${signedPnL.toFixed(2)}`, hit === 'TP' ? 'buy' : 'sell');
    this.store.emit('trade_event', {
      botId: bot.id,
      type: hit === 'TP' ? 'tp' : 'sl',
      pnl: signedPnL,
      trade,
      time: Date.now(),
    });
  }
}
