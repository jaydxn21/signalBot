// Candle Speed Scalper — Crypto
// Measures momentum velocity by comparing current ATR to 50-period average ATR.
// When ATR spikes to 2x+ normal, a liquidation cascade or news event is driving
// price. These bursts have directional follow-through for 2-4 candles before
// exhausting. Enter immediately in the burst direction and exit fast.
// Works exceptionally well on BTC and ETH during high-volume periods.

export const CandleSpeedScalper = {
    _cooldownCandles: 0,
    SPEED_MULTIPLIER: 2.0, // ATR must be 2x average to qualify as a burst
    ATR_LOOKBACK:     50,  // Baseline ATR period

    _getAverageATR(candles, period) {
        if (candles.length < period + 1) return null;
        const recent = candles.slice(-period);
        let sum = 0;
        for (let i = 1; i < recent.length; i++) {
            const c = recent[i], p = recent[i - 1];
            sum += Math.max(
                c.high - c.low,
                Math.abs(c.high - p.close),
                Math.abs(c.low  - p.close)
            );
        }
        return sum / (period - 1);
    },

    // Direction of the speed burst
    _getBurstDirection(candle) {
        const body = candle.close - candle.open;
        if (body > 0) return 'BUY';
        if (body < 0) return 'SELL';
        return null;
    },

    // Burst must not be at RSI extreme — avoid entering exhaustion
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
        if (!atr || candles.length < this.ATR_LOOKBACK + 2) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const avgATR  = this._getAverageATR(candles.slice(0, -2), this.ATR_LOOKBACK);
        if (!avgATR) return null;

        const c         = candles[candles.length - 2];
        const candleATR = Math.max(
            c.high - c.low,
            Math.abs(c.high - (candles[candles.length - 3]?.close || c.open)),
            Math.abs(c.low  - (candles[candles.length - 3]?.close || c.open))
        );

        const speedRatio = candleATR / avgATR;
        const direction  = this._getBurstDirection(c);
        const rsi        = this._getRSI(candles.slice(0, -1));

        console.log(`[CandleSpeed] SpeedRatio: ${speedRatio.toFixed(2)}x | Dir: ${direction} | RSI: ${rsi?.toFixed(1)}`);

        if (speedRatio < this.SPEED_MULTIPLIER || !direction) return null;

        // Block exhaustion entries
        if (direction === 'BUY'  && rsi && rsi > 82) return null;
        if (direction === 'SELL' && rsi && rsi < 18) return null;

        // Live candle must confirm burst direction
        const live = candles[candles.length - 1];
        const confirming = direction === 'BUY'
            ? live.close > c.close
            : live.close < c.close;

        if (!confirming) {
            console.log('[CandleSpeed] Waiting for burst confirmation');
            return null;
        }

        return {
            type:  direction,
            label: `Speed ${direction === 'BUY' ? 'Buy' : 'Sell'} (${speedRatio.toFixed(1)}x ATR)`
        };
    }
};