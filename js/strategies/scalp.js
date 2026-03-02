// scalp.js
import { Indicators } from '../indicators.js';

export const ScalpStrategy = {
    checkEntry: (candles, rsiState) => {
        if (candles.length < 15) return null;

        const rsi = Indicators.calculateRSI(candles, rsiState, 7);

        // Use closed candle to confirm direction
        const closed = candles[candles.length - 2];
        const prev   = candles[candles.length - 3];

        const bullishCandle = closed.close > closed.open;
        const bearishCandle = closed.close < closed.open;

        // Only fire if RSI extreme AND candle confirms direction
        if (rsi < 25 && bullishCandle && prev.close < prev.open) {
            return { type: 'BUY', label: 'Scalp RSI Oversold' };
        }
        if (rsi > 75 && bearishCandle && prev.close > prev.open) {
            return { type: 'SELL', label: 'Scalp RSI Overbought' };
        }

        return null;
    }
};