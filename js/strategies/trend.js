// trend.js
import { Indicators } from '../indicators.js';

export const TrendStrategy = {
    // Real EMA calculation
    _ema(candles, period) {
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    checkEntry: (candles) => {
        if (candles.length < 50) return null;

        // Use closed candle
        const closedCandles = candles.slice(0, -1);
        const closed = closedCandles[closedCandles.length - 1];

        const ema50  = TrendStrategy._ema(closedCandles, 50);
        const rsi    = Indicators.calculateRSI(closedCandles, { initialized: false }, 14);

        const aboveEma = closed.close > ema50;
        const belowEma = closed.close < ema50;

        if (aboveEma && rsi < 45) {
            return { type: 'BUY', label: 'Trend Follow Buy' };
        }
        if (belowEma && rsi > 55) {
            return { type: 'SELL', label: 'Trend Follow Sell' };
        }

        return null;
    }
};