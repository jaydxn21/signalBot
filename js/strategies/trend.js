// trend.js — Trend Follow strategy
// FIXED: accepts bot's actual rsiState instead of creating a fresh one each call
import { Indicators } from '../indicators.js';

export const TrendStrategy = {

    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    // rsiState is the bot's persistent state object — passed in from signal-bot.js
    checkEntry(candles, rsiState) {
        if (candles.length < 50) return null;

        const closedCandles = candles.slice(0, -1);
        const closed = closedCandles[closedCandles.length - 1];
        if (!closed) return null;

        const ema20  = TrendStrategy._ema(closedCandles, 20);
        const ema50  = TrendStrategy._ema(closedCandles, 50);
        if (!ema20 || !ema50) return null;

        // Use bot's persistent rsiState so RSI is accurate, not reset each bar
        const rsi = Indicators.calculateRSI(closedCandles, rsiState, 14);
        if (!rsi) return null;

        const aboveEma = closed.close > ema50 && ema20 > ema50; // both aligned up
        const belowEma = closed.close < ema50 && ema20 < ema50; // both aligned down

        // Pullback entries — wait for RSI to dip/rise before entering with trend
        if (aboveEma && rsi < 48 && rsi > 30) {
            return { type: 'BUY',  label: 'Trend Pullback Buy',  tpMultiplier: 2.0, slMultiplier: 1.0 };
        }
        if (belowEma && rsi > 52 && rsi < 70) {
            return { type: 'SELL', label: 'Trend Pullback Sell', tpMultiplier: 2.0, slMultiplier: 1.0 };
        }

        return null;
    }
};