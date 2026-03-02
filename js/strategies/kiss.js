// kiss.js
export const KissStrategy = {
    checkEntry: (lowerTFCandles, higherTFCandles) => {
        if (lowerTFCandles.length < 3 || higherTFCandles.length < 2) return null;

        // Use the PREVIOUS closed candle, not the live one
        const closedCandle = lowerTFCandles[lowerTFCandles.length - 2];
        const prevH4 = higherTFCandles[higherTFCandles.length - 2];

        if (closedCandle.close > prevH4.high) {
            return { type: 'BUY', label: 'H4 Breakout' };
        }
        if (closedCandle.close < prevH4.low) {
            return { type: 'SELL', label: 'H4 Breakdown' };
        }

        return null;
    }
};