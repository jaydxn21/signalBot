// js/strategies/jump75.js - v3: More Selective Fib + Strong Confluence

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        if (!m5Candles || m5Candles.length < 50 || !m15Candles || m15Candles.length < 25 || !h4Candles || h4Candles.length < 10) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < 180000) return null; // 3 minute cooldown (more selective)

        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < 900000) return null; // 15 min reset after 3 losses

        const latestM5 = m5Candles[m5Candles.length - 1];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];

        // Update H4 structure
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * 6) return null; // Require decent H4 range

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        // Proximity to key Fib levels on M15
        const dist618 = Math.abs(latestM15.close - fib.fib618);
        const dist50 = Math.abs(latestM15.close - fib.fib50);
        const near618 = dist618 < atr * 0.55;
        const near50 = dist50 < atr * 0.55;

        const bullishBias = latestM15.close > this._h4SwingLow + range * 0.2;
        const bearishBias = latestM15.close < this._h4SwingHigh - range * 0.2;

        // M5 momentum + candle confirmation
        const m5Momentum = this._getM5Momentum(m5Candles);
        const isBullishCandle = latestM5.close > prevM5.close && (latestM5.close - latestM5.open) > (atr * 0.3);
        const isBearishCandle = latestM5.close < prevM5.close && (latestM5.open - latestM5.close) > (atr * 0.3);

        let signal = null;
        let score = 0;
        let factors = [];

        // Bullish Setup
        if (bullishBias && (near618 || near50) && m5Momentum > 0.3 && isBullishCandle) {
            score = 82;
            factors = [`Fib ${near618 ? '61.8%' : '50%'} support`, `Strong M5 momentum`, `Bullish candle`];
            
            signal = {
                type: 'LONG',
                score: score,
                factors: factors,
                tpMultiplier: 1.8,
                slMultiplier: 0.7,
                isJump75: true
            };
        }

        // Bearish Setup
        if (bearishBias && (near618 || near50) && m5Momentum < -0.3 && isBearishCandle) {
            score = 82;
            factors = [`Fib ${near618 ? '61.8%' : '50%'} resistance`, `Strong M5 momentum`, `Bearish candle`];
            
            signal = {
                type: 'SHORT',
                score: score,
                factors: factors,
                tpMultiplier: 1.8,
                slMultiplier: 0.7,
                isJump75: true
            };
        }

        if (signal) {
            this._lastTradeTime = now;
            this._consecutiveLosses = 0;

            console.log(`[Jump75] HIGH CONFIDENCE ${signal.type} | Score ${score} | ${factors.join(' · ')} | Price ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        // Occasional status log
        if (Math.random() < 0.05) {
            console.log(`[Jump75] Scanning... Price ${latestM15.close.toFixed(2)} | Fib618 dist ${(dist618/atr).toFixed(1)}xATR | Momentum ${m5Momentum.toFixed(2)}`);
        }

        return null;
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 10) return;
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
        if (m5Candles.length < 20) return 0;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return 0;
        return (ema8 - ema21) / ema21 * 100; // percentage momentum
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