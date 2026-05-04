// js/strategies/jump75.js - v17: Balanced Signal Generation

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        // Reduced data requirements for more signals
        if (!m5Candles || m5Candles.length < 30 || !m15Candles || m15Candles.length < 20 || !h4Candles || h4Candles.length < 6) {
            return null;
        }

        const now = Date.now();
        // Shorter cooldown
        if (now - this._lastTradeTime < 60000) return null; // 1 min cooldown

        // After 3 losses, wait 5 minutes (not 15)
        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < 300000) return null;

        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * 3.5) return null;  // Reduced requirement

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        // Wider zones for entry
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * 0.9;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atr * 1.0;

        // Simpler momentum
        const m5Momentum = this._getM5Momentum(m5Candles);
        const m15Trend = this._getM15Trend(m15Candles);
        
        const bullishCandle = latestM5.close > prevM5.close;
        const bearishCandle = latestM5.close < prevM5.close;
        
        // Price position relative to H4 structure
        const aboveLow = latestM15.close > this._h4SwingLow;
        const belowHigh = latestM15.close < this._h4SwingHigh;

        let signal = null;
        let signalScore = 0;

        // HIGH QUALITY SIGNALS (85+)
        // Fib 61.8% + strong momentum + trend
        if (near618 && m5Momentum > 0.5 && bullishCandle && aboveLow && m15Trend === 'UP') {
            signal = this._createSignal('LONG', 88, ['Fib 61.8% bounce', 'Strong momentum', 'M15 uptrend']);
            signalScore = 88;
        }
        else if (near618 && m5Momentum < -0.5 && bearishCandle && belowHigh && m15Trend === 'DOWN') {
            signal = this._createSignal('SHORT', 88, ['Fib 61.8% rejection', 'Strong momentum', 'M15 downtrend']);
            signalScore = 88;
        }
        
        // MEDIUM QUALITY SIGNALS (75-84)
        else if (near618 && Math.abs(m5Momentum) > 0.3 && (bullishCandle || bearishCandle)) {
            if (m5Momentum > 0 && aboveLow) {
                signal = this._createSignal('LONG', 78, ['Fib 61.8%', 'Momentum']);
                signalScore = 78;
            } else if (m5Momentum < 0 && belowHigh) {
                signal = this._createSignal('SHORT', 78, ['Fib 61.8%', 'Momentum']);
                signalScore = 78;
            }
        }
        
        // LOWER QUALITY BUT VALID SIGNALS (65-74)
        else if ((near618 || near50) && Math.abs(m5Momentum) > 0.2) {
            const zone = near618 ? '61.8%' : '50%';
            if (m5Momentum > 0 && aboveLow) {
                signal = this._createSignal('LONG', 68, [`Fib ${zone}`, 'M5 momentum']);
                signalScore = 68;
            } else if (m5Momentum < 0 && belowHigh) {
                signal = this._createSignal('SHORT', 68, [`Fib ${zone}`, 'M5 momentum']);
                signalScore = 68;
            }
        }
        
        // CONFIRMATION SIGNALS (60-64) - When price respects level with volume
        else if ((near618 || near50) && this._hasVolumeConfirmation(m5Candles)) {
            const zone = near618 ? '61.8%' : '50%';
            if (latestM15.close > latestM15.open && aboveLow) {
                signal = this._createSignal('LONG', 62, [`Fib ${zone}`, 'Volume confirmation']);
                signalScore = 62;
            } else if (latestM15.close < latestM15.open && belowHigh) {
                signal = this._createSignal('SHORT', 62, [`Fib ${zone}`, 'Volume confirmation']);
                signalScore = 62;
            }
        }

        if (signal) {
            this._lastTradeTime = now;
            // Reset consecutive losses on signal (not on trade result)
            // Loss tracking happens in checkClose
            console.log(`[Jump75] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | Price ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _createSignal(type, score, factors) {
        // Adjust TP/SL multipliers based on signal quality
        let tpMultiplier = 2.0;
        let slMultiplier = 1.0;
        
        if (score >= 85) {
            tpMultiplier = 2.5;  // Higher TP for better signals
            slMultiplier = 1.0;
        } else if (score >= 75) {
            tpMultiplier = 2.2;
            slMultiplier = 1.0;
        } else if (score >= 65) {
            tpMultiplier = 1.8;
            slMultiplier = 0.9;
        } else {
            tpMultiplier = 1.5;
            slMultiplier = 0.8;
        }
        
        return {
            type,
            score,
            factors,
            tpMultiplier,
            slMultiplier,
            isJump75: true
        };
    },

    _getM15Trend(m15Candles) {
        if (m15Candles.length < 20) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        
        const latest = m15Candles[m15Candles.length - 1];
        const prev = m15Candles[m15Candles.length - 2];
        
        if (latest.close > ema8 && ema8 > ema21 && latest.close > prev.close) return 'UP';
        if (latest.close < ema8 && ema8 < ema21 && latest.close < prev.close) return 'DOWN';
        return 'NEUTRAL';
    },

    _hasVolumeConfirmation(m5Candles) {
        if (m5Candles.length < 10) return false;
        const latest = m5Candles[m5Candles.length - 1];
        const avgVolume = m5Candles.slice(-10).reduce((s, c) => s + (c.volume || 0), 0) / 10;
        return (latest.volume || 0) > avgVolume * 1.2;
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 8) return;
        const recent = h4Candles.slice(-14);
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
        
        // Normalize by ATR for better comparison
        const atr = this._calculateATR(m5Candles, 14);
        if (atr === 0) return (ema8 - ema21) / 10;
        return (ema8 - ema21) / atr;
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

    _calculateATR(candles, period) {
        if (candles.length < period + 1) return 0;
        let atr = 0;
        for (let i = 1; i <= period; i++) {
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i-1].close),
                Math.abs(candles[i].low - candles[i-1].close)
            );
            atr += tr;
        }
        return atr / period;
    },

    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;

        let closeAction = null;
        
        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                closeAction = { action: 'CLOSE', reason: 'TP' };
                this._consecutiveLosses = 0; // Reset on win
            } else if (currentCandle.low <= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
                this._consecutiveLosses++;
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                closeAction = { action: 'CLOSE', reason: 'TP' };
                this._consecutiveLosses = 0;
            } else if (currentCandle.high >= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
                this._consecutiveLosses++;
            }
        }
        
        return closeAction;
    }
};

export default Jump75Strategy;