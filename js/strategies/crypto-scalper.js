// Crypto Scalper — Breakout + Volume Confirmation Strategy
// Built specifically for BTC, ETH and other crypto pairs on Deriv.
//
// WHY CRYPTO NEEDS A DIFFERENT APPROACH:
// Crypto is driven by sentiment, liquidation cascades, and news events.
// Unlike Gold which trends smoothly, crypto moves in sharp violent bursts
// followed by consolidation. The strategy captures BREAKOUTS from consolidation
// rather than mean reversion or slow momentum.
//
// STRATEGY LOGIC:
// 1. Consolidation detection — price has been in a tight range for N candles
// 2. Breakout candle — price closes decisively outside the range
// 3. Volume confirmation — breakout candle body is significantly larger than average
// 4. No immediate reversal — live candle confirms direction
// 5. RSI not at extreme — avoids entering after exhaustion moves

export const CryptoScalper = {
    _cooldownCandles: 0,
    CONSOLIDATION_CANDLES: 6,   // Look back 6 candles for range
    BREAKOUT_MULTIPLIER:   1.5, // Breakout body must be 1.5x avg body size
    MAX_RANGE_ATR:         1.2, // Consolidation range must be < 1.2x ATR (tight)

    // Average body size over last N candles
    _avgBodySize(candles, n = 10) {
        const recent = candles.slice(-n);
        return recent.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / n;
    },

    // Check if last N candles formed a tight consolidation range
    _isConsolidating(candles, atr) {
        const recent  = candles.slice(-this.CONSOLIDATION_CANDLES);
        const highest = Math.max(...recent.map(c => c.high));
        const lowest  = Math.min(...recent.map(c => c.low));
        const range   = highest - lowest;
        // Range must be tight relative to ATR — price has been coiling
        return range < atr * this.MAX_RANGE_ATR;
    },

    // Breakout candle — big body closing outside the consolidation range
    _isBreakout(candle, consolidationHigh, consolidationLow, avgBody) {
        const body      = Math.abs(candle.close - candle.open);
        const bigEnough = body > avgBody * this.BREAKOUT_MULTIPLIER;

        const bullBreak = candle.close > consolidationHigh && candle.close > candle.open && bigEnough;
        const bearBreak = candle.close < consolidationLow  && candle.close < candle.open && bigEnough;

        return { bullBreak, bearBreak };
    },

    // RSI — 14 period
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

    // Live candle confirmation — breakout holding direction
    _isConfirmed(candles, type) {
        const c3 = candles[candles.length - 2]; // signal candle
        const c4 = candles[candles.length - 1]; // live candle
        if (!c3 || !c4) return false;
        if (type === 'BUY')  return c4.close > c3.close;
        if (type === 'SELL') return c4.close < c3.close;
        return false;
    },

    registerLoss() {
        this._cooldownCandles = 4;
    },

    checkEntry(candles, atr) {
        if (!atr || candles.length < this.CONSOLIDATION_CANDLES + 5) return null;

        if (this._cooldownCandles > 0) {
            this._cooldownCandles--;
            return null;
        }

        // Need the consolidation to be the candles BEFORE the signal candle
        // Signal candle = candles[length-2] (last closed)
        // Consolidation = candles[length-2-CONSOLIDATION_CANDLES] to candles[length-3]
        const consolidationCandles = candles.slice(
            -(this.CONSOLIDATION_CANDLES + 2),
            -2
        );
        const signalCandle = candles[candles.length - 2];

        // Must have been consolidating before the breakout
        if (!this._isConsolidating(consolidationCandles, atr)) {
            return null;
        }

        const consolidationHigh = Math.max(...consolidationCandles.map(c => c.high));
        const consolidationLow  = Math.min(...consolidationCandles.map(c => c.low));
        const avgBody           = this._avgBodySize(consolidationCandles);

        const { bullBreak, bearBreak } = this._isBreakout(
            signalCandle,
            consolidationHigh,
            consolidationLow,
            avgBody
        );

        if (!bullBreak && !bearBreak) return null;

        // RSI filter — avoid exhaustion entries
        const rsi = this._getRSI(candles.slice(0, -1));
        if (rsi !== null) {
            if (bullBreak && rsi > 80) {
                console.log(`[CryptoScalper] BUY blocked: RSI overbought (${rsi.toFixed(1)})`);
                return null;
            }
            if (bearBreak && rsi < 20) {
                console.log(`[CryptoScalper] SELL blocked: RSI oversold (${rsi.toFixed(1)})`);
                return null;
            }
        }

        // Live candle must confirm breakout direction
        if (bullBreak && !this._isConfirmed(candles, 'BUY')) {
            console.log('[CryptoScalper] Waiting: BUY breakout needs confirmation');
            return null;
        }
        if (bearBreak && !this._isConfirmed(candles, 'SELL')) {
            console.log('[CryptoScalper] Waiting: SELL breakout needs confirmation');
            return null;
        }

        if (bullBreak) {
            console.log(`[CryptoScalper] BUY breakout | Range: ${consolidationLow.toFixed(2)}-${consolidationHigh.toFixed(2)} | RSI: ${rsi?.toFixed(1)}`);
            return {
                type:  'BUY',
                label: `Crypto Buy (Breakout)`
            };
        }

        if (bearBreak) {
            console.log(`[CryptoScalper] SELL breakout | Range: ${consolidationLow.toFixed(2)}-${consolidationHigh.toFixed(2)} | RSI: ${rsi?.toFixed(1)}`);
            return {
                type:  'SELL',
                label: `Crypto Sell (Breakout)`
            };
        }

        return null;
    }
};