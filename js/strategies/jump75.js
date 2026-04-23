// js/strategies/jump75.js - BALANCED VERSION (Generates trades but maintains quality)

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _minTradeInterval: 120000, // 2 minutes minimum between trades (reduced from 5 min)
    _consecutiveLosses: 0,
    _maxConsecutiveLosses: 3,   // Allow 3 losses before pause
    
    _config: {
        MIN_MOMENTUM: 0.9,          // Lowered from 1.5 to get more trades
        MIN_BODY_RATIO: 0.5,        // Lowered from 0.65
        MIN_RR_RATIO: 1.5,          // Lowered from 2.0 to 1.5
        REQUIRE_H4_ALIGNMENT: false, // Changed to false - don't require H4 alignment
        COOLDOWN_AFTER_LOSS: 60000,  // 1 min cooldown after loss
    },

    _diagnostics: {
        callCount: 0,
        entriesFired: 0,
        lastLogTime: 0,
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._diagnostics.callCount++;
        
        // Log diagnostics every 100 calls (about every 5-10 minutes)
        if (this._diagnostics.callCount % 100 === 0) {
            console.log(`[Jump75] Diagnostic #${this._diagnostics.callCount}:`, {
                entriesFired: this._diagnostics.entriesFired,
                consecutiveLosses: this._consecutiveLosses,
                lastTradeTime: this._lastTradeTime ? new Date(this._lastTradeTime).toLocaleTimeString() : 'never'
            });
        }
        
        // Rate limiting
        const now = Date.now();
        if (now - this._lastTradeTime < this._minTradeInterval) {
            return null;
        }
        
        // Stop trading after consecutive losses
        if (this._consecutiveLosses >= this._maxConsecutiveLosses) {
            if (this._diagnostics.callCount % 50 === 0) {
                console.log(`[Jump75] Paused - ${this._consecutiveLosses} consecutive losses. Reset after 5 min or TP.`);
            }
            // Auto-reset after 5 minutes
            if (this._lastTradeTime && now - this._lastTradeTime > 300000) {
                this._consecutiveLosses = 0;
                console.log(`[Jump75] Auto-reset after timeout`);
            }
            return null;
        }
        
        // Validate data - more lenient requirements
        if (!m5Candles || m5Candles.length < 10) {
            if (this._diagnostics.callCount % 100 === 0) {
                console.log(`[Jump75] Waiting for M5 candles: ${m5Candles?.length || 0}/10`);
            }
            return null;
        }
        if (!m15Candles || m15Candles.length < 5) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const prevM5_2 = m5Candles[m5Candles.length - 3];
        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // Calculate metrics
        const m5Body = Math.abs(latestM5.close - latestM5.open);
        const m5Range = latestM5.high - latestM5.low;
        const m5BodyRatio = m5Range > 0 ? m5Body / m5Range : 0;
        const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
        const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // M15 trend
        const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
        const m15Body = Math.abs(latestM15.close - latestM15.open);
        const m15Range = latestM15.high - latestM15.low;
        const m15Strength = m15Range > 0 ? m15Body / m15Range : 0;
        
        // Calculate EMAs
        const ema9 = this._calculateEMA(m5Candles, 9);
        const ema21 = this._calculateEMA(m5Candles, 21);
        
        // Breakout detection
        const recentHighs = m5Candles.slice(-20).map(c => c.high);
        const recentLows = m5Candles.slice(-20).map(c => c.low);
        const rangeHigh = Math.max(...recentHighs);
        const rangeLow = Math.min(...recentLows);
        const isBreakoutUp = latestM5.close > rangeHigh;
        const isBreakoutDown = latestM5.close < rangeLow;
        
        // Try multiple signal types (more chances to trade)
        let signal = null;
        
        // SIGNAL 1: Momentum with M15 confirmation (most reliable)
        if (m5Momentum > this._config.MIN_MOMENTUM && 
            m5BodyRatio > this._config.MIN_BODY_RATIO &&
            m5Direction === m15Direction) {
            
            const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
            const slDist = atr * 0.7;
            const tpDist = atr * 1.2;
            const rr = tpDist / slDist;
            
            if (rr >= this._config.MIN_RR_RATIO) {
                signal = {
                    type: direction,
                    direction: direction,
                    score: 70,
                    factors: [
                        `📈 Momentum ${m5Momentum.toFixed(1)}x`,
                        `M15 ${m15Direction === 'UP' ? '↑' : '↓'} confirmed`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.2,
                    slMultiplier: 0.7,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // SIGNAL 2: Breakout (if no momentum signal yet)
        if (!signal && (isBreakoutUp || isBreakoutDown) && m5Momentum > 0.6) {
            const direction = isBreakoutUp ? 'LONG' : 'SHORT';
            const slDist = atr * 0.8;
            const tpDist = atr * 1.3;
            const rr = tpDist / slDist;
            
            if (rr >= this._config.MIN_RR_RATIO) {
                signal = {
                    type: direction,
                    direction: direction,
                    score: 65,
                    factors: [
                        `🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`,
                        `Range ${((rangeHigh - rangeLow) / atr).toFixed(1)}x ATR`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.8,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // SIGNAL 3: EMA Pullback (if still no signal)
        if (!signal && ema9 && ema21) {
            const distanceToEMA21 = Math.abs(latestM5.close - ema21);
            const isNearEMA21 = distanceToEMA21 < atr * 0.4;
            const emaDirection = ema9 > ema21 ? 'UP' : 'DOWN';
            
            if (isNearEMA21 && m5Momentum > 0.5 && m5Direction === emaDirection) {
                const direction = emaDirection === 'UP' ? 'LONG' : 'SHORT';
                const slDist = atr * 0.6;
                const tpDist = atr * 1.0;
                const rr = tpDist / slDist;
                
                if (rr >= 1.2) { // Lower RR for pullback trades
                    signal = {
                        type: direction,
                        direction: direction,
                        score: 60,
                        factors: [
                            `🎯 Pullback to EMA21`,
                            `${direction === 'LONG' ? 'Support' : 'Resistance'} bounce`,
                            `RR ${rr.toFixed(1)}:1`
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
        
        // Log every 50 checks if no signal (for debugging)
        if (!signal && this._diagnostics.callCount % 50 === 0) {
            console.log(`[Jump75] No signal - M5 Mom:${m5Momentum.toFixed(2)}, Body:${(m5BodyRatio*100).toFixed(0)}%, Dir:${m5Direction}, M15:${m15Direction}`);
        }
        
        if (signal) {
            this._diagnostics.entriesFired++;
            this._lastTradeTime = Date.now();
            console.log(`[Jump75] ✅ SIGNAL: ${signal.type} | Score: ${signal.score} | Factors: ${signal.factors.join(', ')}`);
            return signal;
        }
        
        return null;
    },
    
    // Record trade outcome for loss streak tracking
    recordOutcome(outcome) {
        console.log(`[Jump75] Recording outcome: ${outcome}`);
        if (outcome === 'SL') {
            this._consecutiveLosses++;
            console.log(`[Jump75] Consecutive losses: ${this._consecutiveLosses}`);
        } else if (outcome === 'TP') {
            this._consecutiveLosses = 0;
            console.log(`[Jump75] Loss streak reset after win`);
        }
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
        
        const price = currentCandle.close;
        const entry = trade.entry;
        const sl = trade.sl;
        const tp = trade.tp;
        const type = trade.type;
        
        if (type === 'LONG' || type === 'BUY') {
            if (currentCandle.high >= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    reset() {
        this._consecutiveLosses = 0;
        this._lastTradeTime = 0;
        console.log(`[Jump75] Strategy reset`);
    },
    
    getStats() {
        return {
            callCount: this._diagnostics.callCount,
            entriesFired: this._diagnostics.entriesFired,
            consecutiveLosses: this._consecutiveLosses,
            lastTradeTime: this._lastTradeTime ? new Date(this._lastTradeTime).toLocaleTimeString() : 'never'
        };
    }
};

export default Jump75Strategy;