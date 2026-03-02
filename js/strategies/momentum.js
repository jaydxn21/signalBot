export const MomentumStrategy = {
    _cooldownCandles: 0,

    _isBigBody(candle, atr) {
        const body = Math.abs(candle.close - candle.open);
        return body > atr * 0.5;
    },

    _isEngulfing(prev, curr) {
        const bullEngulf = curr.close > curr.open &&
                           curr.open < prev.close &&
                           curr.close > prev.open &&
                           prev.close < prev.open;

        const bearEngulf = curr.close < curr.open &&
                           curr.open > prev.close &&
                           curr.close < prev.open &&
                           prev.close > prev.open;

        return { bullEngulf, bearEngulf };
    },

    _isThreeConsecutive(c1, c2, c3) {
        const allBull = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
        const allBear = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;
        return { allBull, allBear };
    },

    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    _isVolatileEnough(candles, atr) {
        if (candles.length < 20) return true;
        const recent = candles.slice(-20);
        let sumATR = 0;
        for (let i = 1; i < recent.length; i++) {
            const c = recent[i], p = recent[i - 1];
            sumATR += Math.max(
                c.high - c.low,
                Math.abs(c.high - p.close),
                Math.abs(c.low - p.close)
            );
        }
        const avgATR = sumATR / 19;
        return atr >= avgATR * 0.7;
    },

    _isTrending(candles, atr) {
        if (candles.length < 20) return false;
        const recent  = candles.slice(-20);
        const highest = Math.max(...recent.map(c => c.high));
        const lowest  = Math.min(...recent.map(c => c.low));
        const range   = highest - lowest;
        return range > atr * 1.0;
    },

    _getTrendDirection(candles) {
        const fast = this._ema(candles, 8);
        const slow = this._ema(candles, 21);
        if (!fast || !slow) return null;
        if (fast > slow) return 'BULL';
        if (fast < slow) return 'BEAR';
        return null;
    },

    _getH4Trend(h4Candles) {
        if (!h4Candles || h4Candles.length < 21) return null;
        const fast = this._ema(h4Candles, 8);
        const slow = this._ema(h4Candles, 21);
        if (!fast || !slow) return null;
        if (fast > slow) return 'BULL';
        if (fast < slow) return 'BEAR';
        return null;
    },

    _isActiveSession(symbol, candle) {
        if (!symbol.startsWith('frx')) return true;
        const hour      = new Date(candle.time * 1000).getUTCHours();
        const inLondon  = hour >= 8  && hour < 12;
        const inOverlap = hour >= 12 && hour < 13;
        const inNewYork = hour >= 13 && hour < 17;
        return inLondon || inOverlap || inNewYork;
    },

    // Confirmation filter — live candle must be moving in signal direction
    // Prevents entering on patterns that immediately reverse (false breakouts)
    // c3 = last closed candle (signal candle)
    // c4 = current live candle (must confirm direction)
    _isConfirmed(candles, type) {
        const c3 = candles[candles.length - 2]; // signal candle (closed)
        const c4 = candles[candles.length - 1]; // live candle (forming)
        if (!c3 || !c4) return false;
        if (type === 'BUY')  return c4.close > c3.close;
        if (type === 'SELL') return c4.close < c3.close;
        return false;
    },

    registerLoss() {
        this._cooldownCandles = 5;
    },

    checkEntry(candles, atr, symbol = '', h4Candles = []) {
        if (!atr || candles.length < 25) return null;

        const c3 = candles[candles.length - 2];

        // Filter 1 — session (frx only)
        if (!this._isActiveSession(symbol, c3)) {
            console.log(`[Momentum] Blocked: outside session hours (${new Date(c3.time * 1000).toUTCString()})`);
            return null;
        }

        // Filter 2 — volatility
        if (!this._isVolatileEnough(candles, atr)) {
            console.log('[Momentum] Blocked: not volatile enough');
            return null;
        }

        // Filter 3 — ranging market
        if (!this._isTrending(candles, atr)) {
            console.log('[Momentum] Blocked: market ranging');
            return null;
        }

        // Filter 4 — cooldown after loss
        if (this._cooldownCandles > 0) {
            console.log(`[Momentum] Blocked: cooldown (${this._cooldownCandles} candles left)`);
            this._cooldownCandles--;
            return null;
        }

        // Filter 5 — M5 trend direction
        const trend = this._getTrendDirection(candles.slice(0, -1));
        if (!trend) {
            console.log('[Momentum] Blocked: no trend direction');
            return null;
        }

        // Filter 6 — H4 confirmation
        const h4Trend = this._getH4Trend(h4Candles);
        if (h4Trend && h4Trend !== trend) {
            console.log(`[Momentum] Blocked: M5 (${trend}) conflicts with H4 (${h4Trend})`);
            return null;
        }

        const c1 = candles[candles.length - 4];
        const c2 = candles[candles.length - 3];

        const { bullEngulf, bearEngulf } = this._isEngulfing(c2, c3);
        const { allBull, allBear }       = this._isThreeConsecutive(c1, c2, c3);
        const bigBullBody = c3.close > c3.open && this._isBigBody(c3, atr);
        const bigBearBody = c3.close < c3.open && this._isBigBody(c3, atr);

        const bullScore = (bullEngulf ? 1 : 0) + (allBull ? 1 : 0) + (bigBullBody ? 1 : 0);
        const bearScore = (bearEngulf ? 1 : 0) + (allBear ? 1 : 0) + (bigBearBody ? 1 : 0);

        console.log(`[Momentum] Trend: ${trend} | H4: ${h4Trend || 'N/A'} | Bull: ${bullScore}/3 | Bear: ${bearScore}/3 | Engulf: ${bullEngulf||bearEngulf} | Consec: ${allBull||allBear} | BigBody: ${bigBullBody||bigBearBody}`);

        // Filter 7 — live candle confirmation (anti false-breakout)
        if (trend === 'BULL') {
            if (bullScore >= 2) {
                if (!this._isConfirmed(candles, 'BUY')) {
                    console.log('[Momentum] Waiting: BUY needs live candle confirmation');
                    return null;
                }
                return { type: 'BUY', label: `Momentum Buy (${bullScore}/3)` };
            }
            if (bullEngulf && bigBullBody) {
                if (!this._isConfirmed(candles, 'BUY')) {
                    console.log('[Momentum] Waiting: BUY needs live candle confirmation');
                    return null;
                }
                return { type: 'BUY', label: 'Momentum Buy (Engulf+Body)' };
            }
            if (allBull && bigBullBody) {
                if (!this._isConfirmed(candles, 'BUY')) {
                    console.log('[Momentum] Waiting: BUY needs live candle confirmation');
                    return null;
                }
                return { type: 'BUY', label: 'Momentum Buy (Consec+Body)' };
            }
        }

        if (trend === 'BEAR') {
            if (bearScore >= 2) {
                if (!this._isConfirmed(candles, 'SELL')) {
                    console.log('[Momentum] Waiting: SELL needs live candle confirmation');
                    return null;
                }
                return { type: 'SELL', label: `Momentum Sell (${bearScore}/3)` };
            }
            if (bearEngulf && bigBearBody) {
                if (!this._isConfirmed(candles, 'SELL')) {
                    console.log('[Momentum] Waiting: SELL needs live candle confirmation');
                    return null;
                }
                return { type: 'SELL', label: 'Momentum Sell (Engulf+Body)' };
            }
            if (allBear && bigBearBody) {
                if (!this._isConfirmed(candles, 'SELL')) {
                    console.log('[Momentum] Waiting: SELL needs live candle confirmation');
                    return null;
                }
                return { type: 'SELL', label: 'Momentum Sell (Consec+Body)' };
            }
        }

        console.log('[Momentum] Blocked: conditions not met');
        return null;
    }
};