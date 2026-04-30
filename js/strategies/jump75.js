// js/strategies/jump75.js - v14: Loss Reduction Focus (Fewer Bad Trades)

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        if (!m5Candles || m5Candles.length < 50 || !m15Candles || m15Candles.length < 30 || !h4Candles || h4Candles.length < 10) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < 180000) return null; // 3 min cooldown

        // Stronger loss protection
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < 900000) return null;

        const latestM5 = m5Candles[m5Candles.length - 1];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];

        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * 5.5) return null; // Require decent swing

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * 0.6;
        const near50  = Math.abs(latestM15.close - fib.fib50)  < atr * 0.75;

        const bullishBias = latestM15.close > this._h4SwingLow;
        const bearishBias = latestM15.close < this._h4SwingHigh;

        const m5Momentum = this._getM5Momentum(m5Candles);

        // Stronger candle filter to avoid weak entries
        const bullishCandle = latestM5.close > prevM5.close && (latestM5.close - latestM5.open) > atr * 0.5;
        const bearishCandle = latestM5.close < prevM5.close && (latestM5.open - latestM5.close) > atr * 0.5;

        let signal = null;

        // Only take high-conviction setups
        if (bullishBias && near618 && m5Momentum > 0.5 && bullishCandle) {
            signal = this._createSignal('LONG', 81, ['Strong Fib 61.8% bounce', 'Strong candle', 'H4 structure']);
        } 
        else if (bearishBias && near618 && m5Momentum < -0.5 && bearishCandle) {
            signal = this._createSignal('SHORT', 81, ['Strong Fib 61.8% rejection', 'Strong candle', 'H4 structure']);
        }

        if (signal) {
            this._lastTradeTime = now;
            this._consecutiveLosses = 0;
            console.log(`[Jump75] HIGH QUALITY ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | @ ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _createSignal(type, score, factors) {
        return {
            type,
            score,
            factors,
            tpMultiplier: 2.3,     // Wider TP
            slMultiplier: 0.85,    // Slightly wider SL
            isJump75: true
        };
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 10) return;
        const recent = h4Candles.slice(-16);
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