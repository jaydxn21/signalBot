// Synthetic Scalper — Mean Reversion Strategy
// Built specifically for Volatility indices (V10, V25, V50, V75, V100)
// and Jump indices which are algorithmically generated with controlled volatility.
//
// WHY MEAN REVERSION WORKS ON SYNTHETICS:
// Synthetic indices are designed to maintain a specific volatility parameter.
// Unlike real markets, price ALWAYS reverts to the mean because there is no
// fundamental reason for sustained directional moves. The random number generator
// that powers synthetics has a built-in tendency to revert.
//
// STRATEGY LOGIC:
// 1. Bollinger Band extreme — price > 2 SD above/below 20-period mean
// 2. RSI extreme confirmation — RSI < 25 (oversold BUY) or RSI > 75 (overbought SELL)
// 3. Candle rejection wick — current candle shows rejection at extreme
// 4. Entry on reversion — trade BACK toward the mean, not with the spike

export const SyntheticScalper = {
    _cooldownCandles: 0,

    // Bollinger Bands — 20 period, 2 standard deviations
    _getBollingerBands(candles, period = 20, multiplier = 2) {
        if (candles.length < period) return null;
        const recent = candles.slice(-period);
        const mean   = recent.reduce((s, c) => s + c.close, 0) / period;
        const variance = recent.reduce((s, c) => s + Math.pow(c.close - mean, 2), 0) / period;
        const sd     = Math.sqrt(variance);
        return {
            upper: mean + multiplier * sd,
            lower: mean - multiplier * sd,
            mean,
            sd
        };
    },

    // RSI — standard 14 period
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
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    },

    // Rejection wick — candle touched extreme but closed away from it
    // BUY rejection: candle low penetrated lower band but close is above lower band
    // SELL rejection: candle high penetrated upper band but close is below upper band
    _hasRejectionWick(candle, bands, type) {
        if (type === 'BUY') {
            return candle.low  <= bands.lower && candle.close > bands.lower;
        }
        if (type === 'SELL') {
            return candle.high >= bands.upper && candle.close < bands.upper;
        }
        return false;
    },

    // Wick ratio — rejection must be meaningful, not just a tiny pip
    // Wick must be at least 40% of the candle's total range
    _hasSignificantWick(candle, type) {
        const range = candle.high - candle.low;
        if (range === 0) return false;
        if (type === 'BUY') {
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            return lowerWick / range >= 0.4;
        }
        if (type === 'SELL') {
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            return upperWick / range >= 0.4;
        }
        return false;
    },

    registerLoss() {
        this._cooldownCandles = 3; // Shorter cooldown for scalper — 3 candles
    },

    checkEntry(candles, atr) {
        if (!atr || candles.length < 22) return null;

        if (this._cooldownCandles > 0) {
            this._cooldownCandles--;
            return null;
        }

        const bands = this._getBollingerBands(candles.slice(0, -1)); // exclude live candle
        if (!bands) return null;

        const rsi = this._getRSI(candles.slice(0, -1));
        if (rsi === null) return null;

        const c = candles[candles.length - 2]; // last closed candle

        // ── BUY Setup ────────────────────────────────────────────────────────
        // Price spiked below lower band (oversold extreme)
        // RSI confirms oversold
        // Candle shows rejection wick back above the band
        const buySetup  = c.close <= bands.lower * 1.001 || // at/below lower band
                          this._hasRejectionWick(c, bands, 'BUY');
        const buyRSI    = rsi < 30;
        const buyWick   = this._hasRejectionWick(c, bands, 'BUY') ||
                          this._hasSignificantWick(c, 'BUY');

        if (buySetup && buyRSI && buyWick) {
            console.log(`[SyntheticScalper] BUY setup | BB lower: ${bands.lower.toFixed(4)} | RSI: ${rsi.toFixed(1)} | Close: ${c.close}`);
            return {
                type:  'BUY',
                label: `Synth Buy (RSI:${rsi.toFixed(0)} BB)`
            };
        }

        // ── SELL Setup ───────────────────────────────────────────────────────
        // Price spiked above upper band (overbought extreme)
        // RSI confirms overbought
        // Candle shows rejection wick back below the band
        const sellSetup = c.close >= bands.upper * 0.999 ||
                          this._hasRejectionWick(c, bands, 'SELL');
        const sellRSI   = rsi > 70;
        const sellWick  = this._hasRejectionWick(c, bands, 'SELL') ||
                          this._hasSignificantWick(c, 'SELL');

        if (sellSetup && sellRSI && sellWick) {
            console.log(`[SyntheticScalper] SELL setup | BB upper: ${bands.upper.toFixed(4)} | RSI: ${rsi.toFixed(1)} | Close: ${c.close}`);
            return {
                type:  'SELL',
                label: `Synth Sell (RSI:${rsi.toFixed(0)} BB)`
            };
        }

        return null;
    }
};