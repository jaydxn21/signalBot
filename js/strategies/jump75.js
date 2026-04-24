// js/strategies/jump75.js - BREAKOUT OPTIMIZED VERSION

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _tradeCount: 0,
    _consecutiveLosses: 0,
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._tradeCount++;
        
        // Rate limit - max 1 trade per minute
        const now = Date.now();
        if (now - this._lastTradeTime < 60000) {
            return null;
        }
        
        // Validate data
        if (!m5Candles || m5Candles.length < 20) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        // ============================================================
        // DYNAMIC RESISTANCE/SUPPORT LEVELS
        // ============================================================
        
        // Calculate recent highs and lows (20 period)
        const recentHighs = m5Candles.slice(-20).map(c => c.high);
        const recentLows = m5Candles.slice(-20).map(c => c.low);
        const resistance = Math.max(...recentHighs);
        const support = Math.min(...recentLows);
        
        // Calculate breakout levels (previous 5 candles)
        const prevHighs = m5Candles.slice(-6, -1).map(c => c.high);
        const prevResistance = Math.max(...prevHighs);
        
        // ============================================================
        // BREAKOUT DETECTION
        // ============================================================
        
        const isBreakoutUp = latestM5.close > resistance && latestM5.close > prevResistance;
        const isBreakoutDown = latestM5.close < support;
        
        // Calculate breakout strength
        const breakoutStrength = isBreakoutUp ? 
            (latestM5.close - resistance) / atr : 
            (support - latestM5.close) / atr;
        
        // Calculate momentum
        const momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // Log breakout detection
        if (isBreakoutUp || isBreakoutDown) {
            console.log(`[Jump75] Breakout detected! Direction: ${isBreakoutUp ? 'UP' : 'DOWN'}`);
            console.log(`   Price: ${latestM5.close.toFixed(2)} | Resistance: ${resistance.toFixed(2)}`);
            console.log(`   Strength: ${breakoutStrength.toFixed(2)}x ATR | Momentum: ${momentum.toFixed(2)}`);
        }
        
        // ============================================================
        // SIGNAL CONDITIONS - LOWERED THRESHOLDS FOR BREAKOUTS
        // ============================================================
        
        let signal = null;
        
        // SIGNAL: Breakout with confirmation
        if ((isBreakoutUp || isBreakoutDown) && breakoutStrength > 0.3 && momentum > 0.4) {
            const direction = isBreakoutUp ? 'LONG' : 'SHORT';
            
            // Use tighter SL for breakouts
            const slDist = atr * 0.5;
            const tpDist = atr * 1.0;
            const rr = tpDist / slDist;
            
            signal = {
                type: direction,
                direction: direction,
                score: 75,
                factors: [
                    `🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`,
                    `Strength ${breakoutStrength.toFixed(1)}x`,
                    `Momentum ${momentum.toFixed(1)}x`,
                    `RR ${rr.toFixed(1)}:1`
                ],
                tpMultiplier: 1.0,
                slMultiplier: 0.5,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // SIGNAL 2: Momentum with EMA confirmation (for non-breakout moves)
        if (!signal) {
            const ema9 = this._calculateEMA(m5Candles, 9);
            const ema21 = this._calculateEMA(m5Candles, 21);
            
            if (ema9 && ema21) {
                const isBullishTrend = ema9 > ema21 && latestM5.close > ema9;
                const isBearishTrend = ema9 < ema21 && latestM5.close < ema9;
                
                if ((isBullishTrend || isBearishTrend) && momentum > 0.6) {
                    const direction = isBullishTrend ? 'LONG' : 'SHORT';
                    const slDist = atr * 0.6;
                    const tpDist = atr * 1.0;
                    
                    signal = {
                        type: direction,
                        direction: direction,
                        score: 65,
                        factors: [
                            `${direction === 'LONG' ? '📈' : '📉'} Momentum`,
                            `EMA ${direction === 'LONG' ? '↑' : '↓'}`,
                            `RR ${(tpDist/slDist).toFixed(1)}:1`
                        ],
                        tpMultiplier: 1.0,
                        slMultiplier: 0.6,
                        _slDist: slDist,
                        _tpDist: tpDist,
                        isJump75: true
                    };
                }
            }
        }
        
        if (signal) {
            this._lastTradeTime = now;
            this._diagnostics = this._diagnostics || {};
            this._diagnostics.entriesFired = (this._diagnostics.entriesFired || 0) + 1;
            
            console.log(`[Jump75] ✅✅✅ ${signal.type} SIGNAL TAKEN!`);
            console.log(`   Price: ${latestM5.close.toFixed(2)} | Time: ${new Date().toLocaleTimeString()}`);
            
            return signal;
        }
        
        // Log every 50 checks
        if (this._tradeCount % 50 === 0) {
            console.log(`[Jump75] Monitoring - Price: ${latestM5.close.toFixed(2)} | Res: ${resistance.toFixed(2)} | Sup: ${support.toFixed(2)}`);
        }
        
        return null;
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
                console.log(`[Jump75] ✅ TP HIT! Profit: ${(currentCandle.close - trade.entry).toFixed(2)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SL HIT - Loss streak: ${this._consecutiveLosses}`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] ✅ TP HIT! Profit: ${(trade.entry - currentCandle.close).toFixed(2)}`);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                console.log(`[Jump75] ❌ SL HIT - Loss streak: ${this._consecutiveLosses}`);
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    getStats() {
        return {
            tradeCount: this._tradeCount,
            consecutiveLosses: this._consecutiveLosses,
            entriesFired: this._diagnostics?.entriesFired || 0
        };
    }
};

export default Jump75Strategy;