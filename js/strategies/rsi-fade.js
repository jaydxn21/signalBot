// RSI Fade Scalper — Synthetics
// Purest possible strategy for V10-V100 and Jump indices.
// Synthetics are designed with a volatility parameter meaning RSI extremes
// MUST revert. When RSI hits 90+ or 10- the algorithm is statistically
// obligated to revert toward 50. No trend filter needed — fade every extreme.

export const RSIFadeScalper = {
    _cooldownCandles: 0,
    RSI_OVERSOLD:  12,  // Extreme low — almost guaranteed reversion
    RSI_OVERBOUGHT: 88, // Extreme high — almost guaranteed reversion

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

    // RSI must be moving back toward center — confirmation of reversion starting
    _isRSIReverting(candles, type, period = 14) {
        const rsiNow  = this._getRSI(candles.slice(0, -1), period);
        const rsiPrev = this._getRSI(candles.slice(0, -2), period);
        if (rsiNow === null || rsiPrev === null) return false;
        if (type === 'BUY')  return rsiNow > rsiPrev; // RSI moving up from bottom
        if (type === 'SELL') return rsiNow < rsiPrev; // RSI moving down from top
        return false;
    },

    registerLoss() { this._cooldownCandles = 2; },

    checkEntry(candles, atr) {
        if (candles.length < 20) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const rsi = this._getRSI(candles.slice(0, -1));
        if (rsi === null) return null;

        console.log(`[RSIFade] RSI: ${rsi.toFixed(1)}`);

        if (rsi <= this.RSI_OVERSOLD && this._isRSIReverting(candles, 'BUY')) {
            return { type: 'BUY',  label: `RSI Fade Buy (${rsi.toFixed(0)})` };
        }

        if (rsi >= this.RSI_OVERBOUGHT && this._isRSIReverting(candles, 'SELL')) {
            return { type: 'SELL', label: `RSI Fade Sell (${rsi.toFixed(0)})` };
        }

        return null;
    }
};