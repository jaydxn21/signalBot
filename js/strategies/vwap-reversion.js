// VWAP Reversion Scalper — Crypto
// VWAP (Volume Weighted Average Price) is the most important intraday level
// for institutional crypto trading. Price consistently gravitates back to VWAP.
// We approximate VWAP using a cumulative price-volume calculation.
// When price deviates >1.5x ATR from VWAP, the reversion trade is high probability.

export const VWAPReversionScalper = {
    _cooldownCandles: 0,
    DEVIATION_MULTIPLIER: 1.5, // Price must be 1.5x ATR away from VWAP

    // Approximate VWAP — typical price weighted by (high-low range as volume proxy)
    // Deriv doesn't provide real volume but range is a reliable proxy
    _getVWAP(candles) {
        if (candles.length < 10) return null;
        const recent = candles.slice(-50); // Daily VWAP window
        let sumPV = 0, sumV = 0;
        for (const c of recent) {
            const typical = (c.high + c.low + c.close) / 3;
            const volume  = c.high - c.low; // Range as volume proxy
            sumPV += typical * volume;
            sumV  += volume;
        }
        return sumV > 0 ? sumPV / sumV : null;
    },

    _getRSI(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const recent = candles.slice(-(period + 1));
        let gains = 0, losses = 0;
        for (let i = 1; i < recent.length; i++) {
            const diff = recent[i].close - recent[i - 1].close;
            if (diff > 0) gains  += diff;
            else          losses -= diff;
        }
        const avgGain = gains  / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    },

    // Live candle moving toward VWAP (confirming reversion)
    _isRevertingToVWAP(candles, vwap, type) {
        const live = candles[candles.length - 1];
        if (type === 'BUY')  return live.close > candles[candles.length - 2].close;
        if (type === 'SELL') return live.close < candles[candles.length - 2].close;
        return false;
    },

    registerLoss() { this._cooldownCandles = 4; },

    checkEntry(candles, atr) {
        if (!atr || candles.length < 55) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const vwap = this._getVWAP(candles.slice(0, -1));
        if (!vwap) return null;

        const rsi = this._getRSI(candles.slice(0, -1));
        const c   = candles[candles.length - 2];
        const deviation = Math.abs(c.close - vwap);
        const threshold = atr * this.DEVIATION_MULTIPLIER;

        console.log(`[VWAP] Price: ${c.close} | VWAP: ${vwap.toFixed(2)} | Dev: ${deviation.toFixed(2)} | Threshold: ${threshold.toFixed(2)} | RSI: ${rsi?.toFixed(1)}`);

        // Price too far above VWAP — sell back toward it
        if (c.close > vwap + threshold && (!rsi || rsi > 60)) {
            if (this._isRevertingToVWAP(candles, vwap, 'SELL')) {
                return { type: 'SELL', label: `VWAP Fade Sell` };
            }
        }

        // Price too far below VWAP — buy back toward it
        if (c.close < vwap - threshold && (!rsi || rsi < 40)) {
            if (this._isRevertingToVWAP(candles, vwap, 'BUY')) {
                return { type: 'BUY', label: `VWAP Fade Buy` };
            }
        }

        return null;
    }
};