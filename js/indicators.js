export const Indicators = {
    calculateATR: (candles, period = 14) => {
        if (candles.length < period + 1) return null;
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i];
            const p = candles[i - 1];
            if (!p) continue;   // skip if no previous candle
            sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        }
        return sum / period;
    },

    calculateRSI: (candles, state, period = 14) => {
        if (candles.length < period + 1) return null;
        const closes = candles.map(c => c.close);

        let { prevAvgGain, prevAvgLoss, initialized } = state;

        if (!initialized) {
            let sumGain = 0, sumLoss = 0;
            for (let i = closes.length - period; i < closes.length; i++) {
                const diff = closes[i] - (closes[i - 1] || closes[i]);
                sumGain += Math.max(diff, 0);
                sumLoss += Math.max(-diff, 0);
            }
            state.prevAvgGain = sumGain / period;
            state.prevAvgLoss = sumLoss / period;
            state.initialized = true;
        } else {
            const diff = closes[closes.length - 1] - closes[closes.length - 2];
            state.prevAvgGain = (state.prevAvgGain * (period - 1) + Math.max(diff, 0)) / period;
            state.prevAvgLoss = (state.prevAvgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        }

        const rs = state.prevAvgLoss === 0 ? 100 : state.prevAvgGain / state.prevAvgLoss;
        return 100 - (100 / (1 + rs));
    }
};