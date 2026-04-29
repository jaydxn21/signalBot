// js/strategies/jump75.js - v7: High-Quality Fib Hunter + Trailing Stop

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        if (!m5Candles || m5Candles.length < 60 || !m15Candles || m15Candles.length < 30 || !h4Candles || h4Candles.length < 10) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < 240000) return null; // 4 minute cooldown

        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < 1800000) return null; // 30 min after 3 losses

        const latestM5 = m5Candles[m5Candles.length - 1];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];

        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * 5) return null;

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * 0.55;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atr * 0.55;

        const bullishBias = latestM15.close > this._h4SwingLow + range * 0.15;
        const bearishBias = latestM15.close < this._h4SwingHigh - range * 0.15;

        const m5Momentum = this._getM5Momentum(m5Candles);
        const bullishCandle = latestM5.close > prevM5.close && (latestM5.close - latestM5.open) > atr * 0.45;
        const bearishCandle = latestM5.close < prevM5.close && (latestM5.open - latestM5.close) > atr * 0.45;

        let signal = null;

        if (bullishBias && near618 && m5Momentum > 0.6 && bullishCandle) {
            signal = this._createSignal('LONG', 83, ['Strong Fib 61.8% bounce', 'Strong M5 momentum', 'H4 structure']);
        } 
        else if (bearishBias && near618 && m5Momentum < -0.6 && bearishCandle) {
            signal = this._createSignal('SHORT', 83, ['Strong Fib 61.8% rejection', 'Strong M5 momentum', 'H4 structure']);
        }

        if (signal) {
            this._lastTradeTime = now;
            this._consecutiveLosses = 0;
            console.log(`[Jump75] HIGH QUALITY ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | Price ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _createSignal(type, score, factors) {
        return {
            type,
            score,
            factors,
            tpMultiplier: 2.2,
            slMultiplier: 0.8,
            isJump75: true
        };
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 10) return;
        const recent = h4Candles.slice(-15);
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

    // TRAILING STOP (already included from previous version)
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade || !trade.tp || !trade.sl) return null;

        const typeIsLong = trade.type === 'LONG' || trade.type === 'BUY';
        const price = currentCandle.close;

        // TP / SL check
        if (typeIsLong) {
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

        // Trailing Stop
        if (!trade.trailActivated) {
            const tpDist = Math.abs(trade.tp - trade.entry);
            const inProfit = typeIsLong ? (price - trade.entry) : (trade.entry - price);

            if (inProfit > tpDist * 0.5) {
                trade.trailActivated = true;
                trade.trailSL = trade.entry; // Breakeven
                console.log(`[Jump75] Trailing activated — SL to breakeven`);
                return { action: 'UPDATE_SL', newSL: trade.trailSL };
            }
        } else {
            const trailCandidate = typeIsLong ? price - atr : price + atr;

            if (typeIsLong && trailCandidate > trade.trailSL) {
                trade.trailSL = trailCandidate;
                return { action: 'UPDATE_SL', newSL: trade.trailSL };
            } else if (!typeIsLong && trailCandidate < trade.trailSL) {
                trade.trailSL = trailCandidate;
                return { action: 'UPDATE_SL', newSL: trade.trailSL };
            }
        }

        return null;
    }
};

export default Jump75Strategy;