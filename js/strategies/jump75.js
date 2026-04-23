// js/strategies/jump75.js - WITH TREND BIAS

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _tradeCount: 0,
    _consecutiveLosses: 0,
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._tradeCount++;
        
        // Rate limit - trade every 3 minutes minimum
        const now = Date.now();
        if (now - this._lastTradeTime < 180000) {
            return null;
        }
        
        // Stop after 2 consecutive losses
        if (this._consecutiveLosses >= 2) {
            if (now - this._lastTradeTime > 600000) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] Reset after timeout`);
            }
            return null;
        }
        
        // Validate data
        if (!m5Candles || m5Candles.length < 20) return null;
        if (!m15Candles || m15Candles.length < 10) return null;
        if (!h4Candles || h4Candles.length < 5) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        // ============================================================
        // DETERMINE MARKET TREND using multiple timeframes
        // ============================================================
        
        // M5 trend (20 candles)
        const m5Trend = this._getTrend(m5Candles, 20);
        
        // M15 trend (10 candles)
        const m15Trend = this._getTrend(m15Candles, 10);
        
        // H4 trend (5 candles - about 1 day)
        const h4Trend = this._getTrend(h4Candles, 5);
        
        // Log trend status periodically
        if (this._tradeCount % 20 === 0) {
            console.log(`[Jump75] Trends - M5:${m5Trend} M15:${m15Trend} H4:${h4Trend} | Price: ${latestM5.close.toFixed(2)}`);
        }
        
        // ============================================================
        // ONLY TRADE WITH THE H4 TREND (Higher timeframe bias)
        // ============================================================
        
        // Don't trade if H4 trend is unclear
        if (h4Trend === 'neutral') {
            return null;
        }
        
        // Calculate momentum
        const momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // Require reasonable momentum
        if (momentum < 0.5) {
            return null;
        }
        
        // Check if we should take a trade
        let direction = null;
        let confidence = 0;
        
        // LONG signal: H4 uptrend + M5 uptrend (alignment)
        if (h4Trend === 'bullish' && m5Trend === 'bullish' && momentum > 0.6) {
            direction = 'LONG';
            confidence = 75;
        }
        // SHORT signal: H4 downtrend + M5 downtrend (alignment)
        else if (h4Trend === 'bearish' && m5Trend === 'bearish' && momentum > 0.6) {
            direction = 'SHORT';
            confidence = 75;
        }
        // WEAKER SIGNAL: Only M15 alignment with H4
        else if (h4Trend === 'bullish' && m15Trend === 'bullish' && momentum > 0.8) {
            direction = 'LONG';
            confidence = 65;
        }
        else if (h4Trend === 'bearish' && m15Trend === 'bearish' && momentum > 0.8) {
            direction = 'SHORT';
            confidence = 65;
        }
        
        if (!direction) {
            return null;
        }
        
        // Calculate SL and TP (2:1 reward)
        const slDist = atr * 0.6;
        const tpDist = atr * 1.2;
        const rr = tpDist / slDist;
        
        this._lastTradeTime = now;
        
        console.log(`[Jump75] 🎯 ${direction} SIGNAL!`);
        console.log(`   Price: ${latestM5.close.toFixed(4)} | Momentum: ${momentum.toFixed(2)}`);
        console.log(`   Trends: H4=${h4Trend} M15=${m15Trend} M5=${m5Trend}`);
        console.log(`   RR: ${rr.toFixed(2)}:1 | Confidence: ${confidence}`);
        
        return {
            type: direction,
            direction: direction,
            score: confidence,
            factors: [
                `${direction === 'LONG' ? '📈' : '📉'} ${direction}`,
                `H4 ${h4Trend === 'bullish' ? '↑' : '↓'} trend`,
                `Momentum ${momentum.toFixed(1)}x`,
                `RR ${rr.toFixed(1)}:1`
            ],
            tpMultiplier: 1.2,
            slMultiplier: 0.6,
            _slDist: slDist,
            _tpDist: tpDist,
            isJump75: true
        };
    },
    
    // Helper to determine trend direction
    _getTrend(candles, lookback) {
        if (!candles || candles.length < lookback + 1) return 'neutral';
        
        const recent = candles.slice(-lookback);
        const closes = recent.map(c => c.close);
        const highs = recent.map(c => c.high);
        const lows = recent.map(c => c.low);
        
        const startClose = closes[0];
        const endClose = closes[closes.length - 1];
        const highestHigh = Math.max(...highs);
        const lowestLow = Math.min(...lows);
        const range = highestHigh - lowestLow;
        
        // Calculate price change percentage relative to range
        const change = endClose - startClose;
        const changePercent = Math.abs(change) / range;
        
        // Bullish: price up and near highs
        if (change > 0 && changePercent > 0.3) {
            return 'bullish';
        }
        // Bearish: price down and near lows
        if (change < 0 && changePercent > 0.3) {
            return 'bearish';
        }
        
        return 'neutral';
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] ✅ LONG TP HIT! Profit: ${(currentCandle.close - trade.entry).toFixed(4)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ LONG SL HIT - ${this._consecutiveLosses} consecutive loss(es)`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] ✅ SHORT TP HIT! Profit: ${(trade.entry - currentCandle.close).toFixed(4)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SHORT SL HIT - ${this._consecutiveLosses} consecutive loss(es)`);
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