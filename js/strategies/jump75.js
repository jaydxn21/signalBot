// js/strategies/jump75.js - v16: High Quality Trades Only

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _h4SwingHigh: null,
    _h4SwingLow: null,
    _dailyTrend: null,      // Track daily trend
    _hourlyTrend: null,     // Track hourly trend

    async checkEntry(m5Candles, m15Candles, h4Candles, dailyCandles, hourlyCandles, atr) {
        // More data required for better decisions
        if (!m5Candles || m5Candles.length < 60 || !m15Candles || m15Candles.length < 30 || 
            !h4Candles || h4Candles.length < 12 || !dailyCandles || dailyCandles.length < 5) {
            return null;
        }

        const now = Date.now();
        // Longer cooldown after losses
        if (now - this._lastTradeTime < 180000) return null; // 3 min cooldown

        // After 3 losses, wait 15 minutes
        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < 900000) return null;

        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // Calculate trends
        this._updateTrends(dailyCandles, hourlyCandles);
        
        // Update H4 structure
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        // ONLY trade with the trend (BIG improvement)
        const dailyTrend = this._getDailyTrend(dailyCandles);
        const hourlyTrend = this._getHourlyTrend(hourlyCandles);
        
        const range = this._h4SwingHigh - this._h4SwingLow;
        // Require stronger range for entry
        if (range < atr * 5.0) return null;

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);

        // Use 61.8% ONLY (more reliable than 50%)
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * 0.6;
        
        // Strong momentum requirement
        const m5Momentum = this._getM5Momentum(m5Candles);
        const m15Momentum = this._getM15Momentum(m15Candles);
        
        // Confluence check
        const emaAlignment = this._checkEMAAlignment(m5Candles);
        
        // Volume confirmation (using range as proxy)
        const volumeConfirmed = (latestM15.high - latestM15.low) > atr * 0.4;
        
        let signal = null;

        // LONG conditions - ONLY if trends align
        if (dailyTrend === 'BULLISH' && hourlyTrend !== 'BEARISH' && near618 && m5Momentum > 0.4 && m15Momentum > 0.2 && emaAlignment && volumeConfirmed) {
            signal = this._createSignal('LONG', 85, ['Daily uptrend', 'Fib 61.8%', 'Strong momentum', 'EMA alignment']);
        }
        // SHORT conditions - ONLY if trends align
        else if (dailyTrend === 'BEARISH' && hourlyTrend !== 'BULLISH' && near618 && m5Momentum < -0.4 && m15Momentum < -0.2 && emaAlignment && volumeConfirmed) {
            signal = this._createSignal('SHORT', 85, ['Daily downtrend', 'Fib 61.8%', 'Strong momentum', 'EMA alignment']);
        }
        // Lower quality signals - higher score required
        else if (dailyTrend !== 'CONTRARY' && near618 && Math.abs(m5Momentum) > 0.5 && Math.abs(m15Momentum) > 0.3) {
            if (m5Momentum > 0) {
                signal = this._createSignal('LONG', 70, ['Fib 61.8%', 'Strong momentum']);
            } else if (m5Momentum < 0) {
                signal = this._createSignal('SHORT', 70, ['Fib 61.8%', 'Strong momentum']);
            }
        }

        if (signal) {
            this._lastTradeTime = now;
            console.log(`[Jump75] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | Price ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _createSignal(type, score, factors) {
        return {
            type,
            score,
            factors,
            tpMultiplier: 2.5,          // Wider TP (was 2.1)
            slMultiplier: 1.2,           // Wider SL (was 0.85)
            isJump75: true
        };
    },

    _getDailyTrend(dailyCandles) {
        if (dailyCandles.length < 10) return 'NEUTRAL';
        const ema20 = this._calculateEMA(dailyCandles, 20);
        const ema50 = this._calculateEMA(dailyCandles, 50);
        if (!ema20 || !ema50) return 'NEUTRAL';
        
        const latest = dailyCandles[dailyCandles.length - 1];
        if (latest.close > ema20 && ema20 > ema50) return 'BULLISH';
        if (latest.close < ema20 && ema20 < ema50) return 'BEARISH';
        return 'NEUTRAL';
    },

    _getHourlyTrend(hourlyCandles) {
        if (hourlyCandles.length < 20) return 'NEUTRAL';
        const ema8 = this._calculateEMA(hourlyCandles, 8);
        const ema21 = this._calculateEMA(hourlyCandles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        
        const latest = hourlyCandles[hourlyCandles.length - 1];
        if (latest.close > ema8 && ema8 > ema21) return 'BULLISH';
        if (latest.close < ema8 && ema8 < ema21) return 'BEARISH';
        return 'NEUTRAL';
    },

    _checkEMAAlignment(m5Candles) {
        if (m5Candles.length < 30) return false;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        const ema50 = this._calculateEMA(m5Candles, 50);
        if (!ema8 || !ema21 || !ema50) return false;
        
        const latest = m5Candles[m5Candles.length - 1];
        // Check if price is above EMAs and EMAs are aligned
        return (latest.close > ema8 && ema8 > ema21 && ema21 > ema50) ||
               (latest.close < ema8 && ema8 < ema21 && ema21 < ema50);
    },

    _updateTrends(dailyCandles, hourlyCandles) {
        // Trends are calculated on the fly in checkEntry
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 12) return;
        const recent = h4Candles.slice(-20);
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
        // Normalize momentum
        const atr = this._calculateATR(m5Candles, 14);
        if (atr === 0) return ema8 - ema21;
        return (ema8 - ema21) / atr;
    },

    _getM15Momentum(m15Candles) {
        if (m15Candles.length < 20) return 0;
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 0;
        const atr = this._calculateATR(m15Candles, 14);
        if (atr === 0) return ema8 - ema21;
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
            } else if (currentCandle.low <= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                closeAction = { action: 'CLOSE', reason: 'TP' };
            } else if (currentCandle.high >= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
            }
        }
        
        // Track consecutive losses on SL
        if (closeAction && closeAction.reason === 'SL') {
            this._consecutiveLosses++;
        } else if (closeAction && closeAction.reason === 'TP') {
            this._consecutiveLosses = Math.max(0, this._consecutiveLosses - 1);
        }
        
        return closeAction;
    }
};

export default Jump75Strategy;