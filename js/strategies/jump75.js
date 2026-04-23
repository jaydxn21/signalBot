// js/strategies/jump75.js - IMPROVED VERSION
// Better entries, tighter stops, higher RR

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _tradeCount: 0,
    _consecutiveLosses: 0,
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._tradeCount++;
        
        // Rate limit - trade every 3 minutes minimum
        const now = Date.now();
        if (now - this._lastTradeTime < 180000) { // 3 minutes
            return null;
        }
        
        // Stop after 2 consecutive losses
        if (this._consecutiveLosses >= 2) {
            if (this._tradeCount % 20 === 0) {
                console.log(`[Jump75] Paused after ${this._consecutiveLosses} losses`);
            }
            // Reset after 10 minutes
            if (now - this._lastTradeTime > 600000) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] Auto-reset after timeout`);
            }
            return null;
        }
        
        // Validate data
        if (!m5Candles || m5Candles.length < 15) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const prevM5_5 = m5Candles[m5Candles.length - 6];
        const prevM5_10 = m5Candles[m5Candles.length - 11];
        
        // Calculate multiple timeframe trends
        const trend5 = latestM5.close - prevM5_5.close;
        const trend10 = latestM5.close - prevM5_10.close;
        
        // Require both trends to agree
        const isUptrend = trend5 > 0 && trend10 > 0;
        const isDowntrend = trend5 < 0 && trend10 < 0;
        
        if (!isUptrend && !isDowntrend) {
            return null; // Mixed signals - no trade
        }
        
        const direction = isUptrend ? 'LONG' : 'SHORT';
        
        // Calculate momentum with higher threshold
        const momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // Require stronger momentum for entry
        if (momentum < 0.7) {
            return null;
        }
        
        // Check for pullback to value area
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (ema21) {
            const distanceToEMA = Math.abs(latestM5.close - ema21);
            const isNearEMA = distanceToEMA < atr * 0.3;
            
            // For LONG: want price near or above EMA21 in uptrend
            // For SHORT: want price near or below EMA21 in downtrend
            if (isUptrend && latestM5.close < ema21 - atr * 0.2) {
                return null; // Too far below EMA in uptrend
            }
            if (isDowntrend && latestM5.close > ema21 + atr * 0.2) {
                return null; // Too far above EMA in downtrend
            }
        }
        
        // Calculate better SL and TP (2:1 reward)
        const slDist = atr * 0.6;  // Tighter stop
        const tpDist = atr * 1.2;  // 2:1 reward
        const rr = tpDist / slDist;
        
        this._lastTradeTime = now;
        
        console.log(`[Jump75] 🎯 ${direction} SIGNAL - Price: ${latestM5.close.toFixed(4)} | Mom: ${momentum.toFixed(2)} | RR: ${rr.toFixed(2)}:1`);
        
        return {
            type: direction,
            direction: direction,
            score: 75,
            factors: [
                `${direction === 'LONG' ? '📈' : '📉'} ${direction}`,
                `Momentum ${momentum.toFixed(1)}x`,
                `Trend aligned`,
                `RR ${rr.toFixed(1)}:1`
            ],
            tpMultiplier: 1.2,
            slMultiplier: 0.6,
            _slDist: slDist,
            _tpDist: tpDist,
            isJump75: true
        };
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
                this._consecutiveLosses = 0;
                console.log(`[Jump75] ✅ TP HIT! Profit taken`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SL HIT - ${this._consecutiveLosses} consecutive loss(es)`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] ✅ TP HIT! Profit taken`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SL HIT - ${this._consecutiveLosses} consecutive loss(es)`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    recordOutcome(outcome) {
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
        } else if (outcome === 'SL') {
            this._consecutiveLosses++;
        }
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