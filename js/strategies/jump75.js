// js/strategies/jump75.js - TREND-FOLLOWING WITH CONFIRMATION

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _tradeCount: 0,
    _consecutiveLosses: 0,
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._tradeCount++;
        
        // Rate limit - trade every 2 minutes minimum
        const now = Date.now();
        if (now - this._lastTradeTime < 120000) {
            return null;
        }
        
        // Stop after 2 consecutive losses
        if (this._consecutiveLosses >= 2) {
            if (now - this._lastTradeTime > 600000) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] Reset after cooldown`);
            }
            return null;
        }
        
        // Validate data
        if (!m5Candles || m5Candles.length < 30) return null;
        if (!m15Candles || m15Candles.length < 10) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const prevM5_2 = m5Candles[m5Candles.length - 3];
        
        // ============================================================
        // DETERMINE TREND USING MULTIPLE TIMEFRAMES
        // ============================================================
        
        // M5 trend (20 candles)
        const m5Closes = m5Candles.slice(-20).map(c => c.close);
        const m5Trend = this._getTrendDirection(m5Closes);
        
        // M15 trend (10 candles)
        const m15Closes = m15Candles.slice(-10).map(c => c.close);
        const m15Trend = this._getTrendDirection(m15Closes);
        
        // H4 trend (5 candles)
        const h4Closes = h4Candles.slice(-5).map(c => c.close);
        const h4Trend = this._getTrendDirection(h4Closes);
        
        // Require trend alignment for entry
        const isBullish = m5Trend === 'up' && m15Trend === 'up' && h4Trend !== 'down';
        const isBearish = m5Trend === 'down' && m15Trend === 'down' && h4Trend !== 'up';
        
        if (!isBullish && !isBearish) {
            // Log trend status occasionally
            if (this._tradeCount % 30 === 0) {
                console.log(`[Jump75] Trends - M5:${m5Trend} M15:${m15Trend} H4:${h4Trend} | No alignment`);
            }
            return null;
        }
        
        // ============================================================
        // WAIT FOR PULLBACK TO EMA (Better Entry)
        // ============================================================
        
        const ema21 = this._calculateEMA(m5Candles, 21);
        const ema50 = this._calculateEMA(m5Candles, 50);
        
        if (!ema21 || !ema50) return null;
        
        // Calculate distance to EMA21
        const distanceToEMA21 = Math.abs(latestM5.close - ema21);
        const isNearEMA21 = distanceToEMA21 < atr * 0.4;
        
        // Bullish: price near EMA21 and above EMA50
        if (isBullish && isNearEMA21 && latestM5.close > ema50) {
            // Check for bounce confirmation
            const isBouncing = latestM5.close > prevM5.close && prevM5.close < prevM5_2.close;
            
            if (isBouncing) {
                const slDist = atr * 0.5;
                const tpDist = atr * 0.9;
                const rr = tpDist / slDist;
                
                this._lastTradeTime = now;
                this._consecutiveLosses = 0;
                
                console.log(`[Jump75] 🎯 LONG entry at EMA21 bounce! Price: ${latestM5.close.toFixed(2)}`);
                
                return {
                    type: 'LONG',
                    direction: 'LONG',
                    score: 75,
                    factors: [`📈 EMA21 bounce`, `Trend aligned`, `RR ${rr.toFixed(1)}:1`],
                    tpMultiplier: 0.9,
                    slMultiplier: 0.5,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // Bearish: price near EMA21 and below EMA50
        if (isBearish && isNearEMA21 && latestM5.close < ema50) {
            // Check for rejection confirmation
            const isRejecting = latestM5.close < prevM5.close && prevM5.close > prevM5_2.close;
            
            if (isRejecting) {
                const slDist = atr * 0.5;
                const tpDist = atr * 0.9;
                const rr = tpDist / slDist;
                
                this._lastTradeTime = now;
                this._consecutiveLosses = 0;
                
                console.log(`[Jump75] 🎯 SHORT entry at EMA21 rejection! Price: ${latestM5.close.toFixed(2)}`);
                
                return {
                    type: 'SHORT',
                    direction: 'SHORT',
                    score: 75,
                    factors: [`📉 EMA21 rejection`, `Trend aligned`, `RR ${rr.toFixed(1)}:1`],
                    tpMultiplier: 0.9,
                    slMultiplier: 0.5,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // Log occasionally
        if (this._tradeCount % 30 === 0) {
            console.log(`[Jump75] Waiting for pullback - Price: ${latestM5.close.toFixed(2)} | EMA21: ${ema21.toFixed(2)} | Dist: ${(distanceToEMA21/atr).toFixed(1)}x ATR`);
        }
        
        return null;
    },
    
    _getTrendDirection(closes) {
        if (!closes || closes.length < 10) return 'neutral';
        
        const start = closes[0];
        const end = closes[closes.length - 1];
        const percentChange = ((end - start) / start) * 100;
        
        // Calculate slope using linear regression
        const n = closes.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += closes[i];
            sumXY += i * closes[i];
            sumX2 += i * i;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        
        if (percentChange > 0.05 || slope > 0.5) return 'up';
        if (percentChange < -0.05 || slope < -0.5) return 'down';
        return 'neutral';
    },
    
    _calculateEMA(candles, period) {
        if (!candles || candles.length < period) return null;
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
            if (currentCandle.high >= trade.tp) {
                console.log(`[Jump75] ✅ LONG TP! Profit: ${(currentCandle.close - trade.entry).toFixed(2)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ LONG SL - ${this._consecutiveLosses} consecutive`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                console.log(`[Jump75] ✅ SHORT TP! Profit: ${(trade.entry - currentCandle.close).toFixed(2)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SHORT SL - ${this._consecutiveLosses} consecutive`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    getStats() {
        return {
            tradeCount: this._tradeCount,
            consecutiveLosses: this._consecutiveLosses,
            lastTradeTime: this._lastTradeTime ? new Date(this._lastTradeTime).toLocaleTimeString() : 'never'
        };
    }
};

export default Jump75Strategy;