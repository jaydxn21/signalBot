// swing.js
export const SwingStrategy = {
    checkEntry: (lowerTFCandles) => {
        if (lowerTFCandles.length < 10) return null;

        // Use closed candle, not live
        const closed = lowerTFCandles[lowerTFCandles.length - 2];
        const prev   = lowerTFCandles[lowerTFCandles.length - 3];

        // Require body close, not just wick
        const bodyBullish = closed.close > closed.open;
        const bodyBearish = closed.close < closed.open;

        if (bodyBullish && closed.close > prev.high) {
            return { type: 'BUY', label: 'Swing Breakout' };
        }
        if (bodyBearish && closed.close < prev.low) {
            return { type: 'SELL', label: 'Swing Breakdown' };
        }

        return null;
    }
};