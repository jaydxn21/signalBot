// js/strategies/jump75.js - WORKING VERSION
// This WILL generate trades

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _tradeCount: 0,
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        // Always log first few calls to verify it's being called
        this._tradeCount++;
        
        if (this._tradeCount <= 10) {
            console.log(`[Jump75Strategy] Called #${this._tradeCount} - M5 candles: ${m5Candles?.length || 0}`);
        }
        
        // Simple rate limiting - trade every 2 minutes
        const now = Date.now();
        if (now - this._lastTradeTime < 120000) { // 2 minutes
            return null;
        }
        
        // Validate we have enough candles
        if (!m5Candles || m5Candles.length < 10) {
            if (this._tradeCount % 50 === 0) {
                console.log(`[Jump75Strategy] Waiting for candles: ${m5Candles?.length || 0}/10`);
            }
            return null;
        }
        
        if (!atr || atr <= 0) {
            return null;
        }
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const prevM5_10 = m5Candles[m5Candles.length - 11];
        
        if (!latestM5 || !prevM5) return null;
        
        // Simple trading logic: follow the 10-candle trend
        const trend10 = latestM5.close - prevM5_10.close;
        const direction = trend10 > 0 ? 'LONG' : 'SHORT';
        
        // Simple momentum filter
        const momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // Take trade if momentum is reasonable (not too low)
        if (momentum > 0.3) {
            this._lastTradeTime = now;
            
            // Calculate SL and TP
            const slDist = atr * 0.8;
            const tpDist = atr * 1.2;
            const rr = tpDist / slDist;
            
            console.log(`[Jump75Strategy] 🎯 GENERATING ${direction} SIGNAL!`);
            console.log(`   Price: ${latestM5.close.toFixed(4)} | Momentum: ${momentum.toFixed(2)} | Trend: ${trend10 > 0 ? 'UP' : 'DOWN'}`);
            console.log(`   SL: ${slDist.toFixed(4)} away | TP: ${tpDist.toFixed(4)} away | RR: ${rr.toFixed(2)}:1`);
            
            return {
                type: direction,
                direction: direction,
                score: 65,
                factors: [
                    `${direction === 'LONG' ? '📈' : '📉'} Trend following`,
                    `Momentum ${momentum.toFixed(1)}x`,
                    `RR ${rr.toFixed(1)}:1`
                ],
                tpMultiplier: 1.2,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // Log occasionally when no signal
        if (this._tradeCount % 30 === 0) {
            console.log(`[Jump75Strategy] No signal - Momentum: ${momentum.toFixed(2)} (need > 0.3)`);
        }
        
        return null;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                console.log(`[Jump75Strategy] TP hit at ${currentCandle.close.toFixed(4)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                console.log(`[Jump75Strategy] SL hit at ${currentCandle.close.toFixed(4)}`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                console.log(`[Jump75Strategy] TP hit at ${currentCandle.close.toFixed(4)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                console.log(`[Jump75Strategy] SL hit at ${currentCandle.close.toFixed(4)}`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    recordOutcome(outcome) {
        console.log(`[Jump75Strategy] Trade outcome recorded: ${outcome}`);
    },
    
    getStats() {
        return {
            tradeCount: this._tradeCount,
            lastTradeTime: this._lastTradeTime ? new Date(this._lastTradeTime).toLocaleTimeString() : 'never'
        };
    }
};

export default Jump75Strategy;