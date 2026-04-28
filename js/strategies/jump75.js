// js/strategies/jump75.js - v4: Balanced for Jump 75 (More Setups + Quality Filter)

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        if (!m5Candles || m5Candles.length < 40 || !m15Candles || m15Candles.length < 20 || !h4Candles || h4Candles.length < 8) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < 120000) return null; // 2 minute cooldown

        // Reset loss counter after 15 minutes of no trades
        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime > 900000) {
            this._consecutiveLosses = 0;
        }

        const latestM5 = m5Candles[m5Candles.length - 1];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];

        // Update H4 structure
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * 3.5) return null; // Lowered threshold

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        // More forgiving Fib proximity
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * 0.85;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atr * 0.85;

        const bullishBias = latestM15.close > this._h4SwingLow;
        const bearishBias = latestM15.close < this._h4SwingHigh;

        // Softer M5 momentum + candle filter
        const m5Momentum = this._getM5Momentum(m5Candles);
        const isBullishCandle = latestM5.close > prevM5.close;
        const isBearishCandle = latestM5.close < prevM5.close;

        let signal = null;

        // Bullish Setup
        if (bullishBias && (near618 || near50) && m5Momentum > -0.2 && isBullishCandle) {
            const slDist = atr * 0.8;
            const tpDist = atr * 1.7;

            signal = {
                type: 'LONG',
                score: 74,
                factors: [`Fib ${near618 ? '61.8%' : '50%'} reaction`, `M5 bias`, `H4 structure`],
                tpMultiplier: 1.7,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }

        // Bearish Setup
        if (bearishBias && (near618 || near50) && m5Momentum < 0.2 && isBearishCandle) {
            const slDist = atr * 0.8;
            const tpDist = atr * 1.7;

            signal = {
                type: 'SHORT',
                score: 74,
                factors: [`Fib ${near618 ? '61.8%' : '50%'} reaction`, `M5 bias`, `H4 structure`],
                tpMultiplier: 1.7,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }

        if (signal) {
            this._lastTradeTime = now;
            console.log(`[Jump75] ${signal.type} Setup | Score ${signal.score} | ${signal.factors.join(' · ')} | @ ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 8) return;
        const recent = h4Candles.slice(-12);
        this._h4SwingHigh = Math.max(...recent.map(c => c.high));
        this._h4SwingLow = Math.min(...recent.map(c => c.low));
    },

    _calculateFibLevels(low, high) {
        const diff = high - low;
        return {
            fib50: high - diff * 0.5,
            fib618: high - diff * 0.618,
        };
    },

    _getM5Momentum(m5Candles) {
        if (m5Candles.length < 15) return 0;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return 0;
        return ema8 - ema21;
    },

    _calculateEMA(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;

        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) return { action: 'CLOSE', reason: 'TP' };
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) return { action: 'CLOSE', reason: 'TP' };
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    }
};

export default Jump75Strategy;