// News Fade Scalper — Forex / Gold
// News events cause ATR spikes of 3x+ normal. Price moves violently in one
// direction then retraces 30-50% within 15 minutes as initial panic fades.
// This strategy detects the spike and fades it — trading the retracement.
// Most effective on Gold, EUR/USD and GBP/USD during major news events
// (NFP, CPI, FOMC, BOE announcements).

export const NewsFadeScalper = {
    _cooldownCandles: 0,
    SPIKE_MULTIPLIER: 3.0, // ATR must be 3x average to qualify as news spike
    ATR_BASELINE:     30,  // Baseline ATR lookback

    _getBaselineATR(candles, period) {
        if (candles.length < period + 1) return null;
        // Use candles from 5+ back to avoid including the spike itself
        const baseline = candles.slice(-(period + 5), -5);
        if (baseline.length < 10) return null;
        let sum = 0;
        for (let i = 1; i < baseline.length; i++) {
            const c = baseline[i], p = baseline[i - 1];
            sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        }
        return sum / (baseline.length - 1);
    },

    _getSpikeDirection(candle) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const body      = Math.abs(candle.close - candle.open);
        // Directional body spike — body > 50% of candle range
        if (body / (candle.high - candle.low) > 0.5) {
            return candle.close > candle.open ? 'UP' : 'DOWN';
        }
        return null;
    },

    registerLoss() { this._cooldownCandles = 4; },

    checkEntry(candles, atr) {
        if (!atr || candles.length < this.ATR_BASELINE + 8) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const baselineATR = this._getBaselineATR(candles, this.ATR_BASELINE);
        if (!baselineATR) return null;

        // The spike candle is c3 (2 candles back) — we enter on the next candle
        const spikeCandle  = candles[candles.length - 3];
        const entryCandle  = candles[candles.length - 2];
        const spikeRange   = spikeCandle.high - spikeCandle.low;
        const spikeRatio   = spikeRange / baselineATR;

        console.log(`[NewsFade] SpikeRatio: ${spikeRatio.toFixed(2)}x | Baseline ATR: ${baselineATR.toFixed(4)}`);

        if (spikeRatio < this.SPIKE_MULTIPLIER) return null;

        const spikeDir = this._getSpikeDirection(spikeCandle);
        if (!spikeDir) return null;

        // Entry candle must be starting to retrace
        const retracing = spikeDir === 'UP'
            ? entryCandle.close < spikeCandle.close  // Starting to pull back
            : entryCandle.close > spikeCandle.close;

        if (!retracing) return null;

        // Fade the spike — trade opposite direction
        if (spikeDir === 'UP') {
            console.log(`[NewsFade] SELL fade of upward spike (${spikeRatio.toFixed(1)}x ATR)`);
            return { type: 'SELL', label: `News Fade Sell (${spikeRatio.toFixed(1)}x)` };
        }

        if (spikeDir === 'DOWN') {
            console.log(`[NewsFade] BUY fade of downward spike (${spikeRatio.toFixed(1)}x ATR)`);
            return { type: 'BUY', label: `News Fade Buy (${spikeRatio.toFixed(1)}x)` };
        }

        return null;
    }
};