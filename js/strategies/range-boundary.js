// Range Boundary Scalper — Synthetics
// Synthetics trade in a statistical range determined by their volatility parameter.
// Over 50 candles the high/low boundary acts as a rubber band — price that
// reaches the boundary snaps back. This strategy marks those boundaries and
// scalps the bounce. More reliable than Bollinger because it uses actual
// price extremes rather than statistical deviation.

export const RangeBoundaryScalper = {
    _cooldownCandles: 0,
    LOOKBACK:   50,   // Range detection window
    PROXIMITY:  0.15, // Must be within 15% of ATR from boundary to fire

    _getRange(candles) {
        if (candles.length < this.LOOKBACK) return null;
        const recent  = candles.slice(-this.LOOKBACK);
        const highest = Math.max(...recent.map(c => c.high));
        const lowest  = Math.min(...recent.map(c => c.low));
        return { highest, lowest, mid: (highest + lowest) / 2 };
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

    registerLoss() { this._cooldownCandles = 3; },

    checkEntry(candles, atr) {
        if (!atr || candles.length < this.LOOKBACK + 2) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const range = this._getRange(candles.slice(0, -1));
        if (!range) return null;

        const rsi = this._getRSI(candles.slice(0, -1));
        const c   = candles[candles.length - 2];
        const proximity = atr * this.PROXIMITY;

        const nearTop    = c.high >= range.highest - proximity;
        const nearBottom = c.low  <= range.lowest  + proximity;

        // Rejection candle at boundary — closed back toward the middle
        const rejectedTop    = nearTop    && c.close < c.high - (c.high - c.low) * 0.3;
        const rejectedBottom = nearBottom && c.close > c.low  + (c.high - c.low) * 0.3;

        console.log(`[RangeBoundary] High: ${range.highest.toFixed(4)} Low: ${range.lowest.toFixed(4)} | nearTop: ${nearTop} nearBot: ${nearBottom} | RSI: ${rsi?.toFixed(1)}`);

        if (rejectedBottom && (!rsi || rsi < 45)) {
            return { type: 'BUY',  label: `Range Bounce Buy` };
        }

        if (rejectedTop && (!rsi || rsi > 55)) {
            return { type: 'SELL', label: `Range Bounce Sell` };
        }

        return null;
    }
};