// js/strategies/jump75.js - BALANCED VERSION (Generates trades but maintains quality)

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _minTradeInterval: 60000, // 1 minute minimum between trades (reduced from 2 min)
    _consecutiveLosses: 0,
    _maxConsecutiveLosses: 3,   // Allow 3 losses before pause
    
    _config: {
    MIN_MOMENTUM: 0.5,          // Lowered from 0.9
    MIN_BODY_RATIO: 0.4,        // Lowered from 0.5  
    MIN_RR_RATIO: 1.2,          // Lowered from 1.5
    REQUIRE_H4_ALIGNMENT: false,
    COOLDOWN_AFTER_LOSS: 60000,
},

    _diagnostics: {
        callCount: 0,
        entriesFired: 0,
        lastLogTime: 0,
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
    this._diagnostics.callCount++;
    
    // ============================================================
    // FORCED SIGNAL MODE - Remove after getting first few trades
    // This will generate a signal every 50th call (about every 5 min)
    // ============================================================
    const FORCE_SIGNALS = true;  // Set to false after you get trades
    const FORCE_INTERVAL = 50;    // Signal every 50 calls
    
    if (FORCE_SIGNALS && this._diagnostics.callCount % FORCE_INTERVAL === 0) {
        // Determine direction based on recent price action
        const lastFew = m5Candles.slice(-10);
        const firstClose = lastFew[0]?.close || m5Candles[m5Candles.length - 1].close;
        const lastClose = lastFew[lastFew.length - 1]?.close || m5Candles[m5Candles.length - 1].close;
        const isUptrend = lastClose > firstClose;
        
        const direction = isUptrend ? 'LONG' : 'SHORT';
        const slDist = atr * 0.8;
        const tpDist = atr * 1.2;
        
        console.log(`[Jump75] 🔔 FORCED SIGNAL #${this._diagnostics.callCount}: ${direction} at ${m5Candles[m5Candles.length - 1].close.toFixed(4)}`);
        
        this._diagnostics.entriesFired++;
        this._lastTradeTime = Date.now();
        
        return {
            type: direction,
            direction: direction,
            score: 65,
            factors: [`🔔 FORCED SIGNAL (${this._diagnostics.callCount} calls)`, isUptrend ? 'Uptrend' : 'Downtrend'],
            tpMultiplier: 1.2,
            slMultiplier: 0.8,
            _slDist: slDist,
            _tpDist: tpDist,
            isJump75: true
        };
    }
    // ============================================================
    
    // Log diagnostics every 100 calls
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
            console.log(`[Jump75] Paused - ${this._consecutiveLosses} consecutive losses.`);
        }
        if (this._lastTradeTime && now - this._lastTradeTime > 300000) {
            this._consecutiveLosses = 0;
            console.log(`[Jump75] Auto-reset after timeout`);
        }
        return null;
    }
    
    // Validate data
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
    const latestM15 = m15Candles[m15Candles.length - 1];
    
    // Calculate metrics
    const m5Body = Math.abs(latestM5.close - latestM5.open);
    const m5Range = latestM5.high - latestM5.low;
    const m5BodyRatio = m5Range > 0 ? m5Body / m5Range : 0;
    const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
    const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
    
    // M15 trend
    const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
    
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
    
    // Try multiple signal types
    let signal = null;
    
    // SIGNAL 1: Momentum with M15 confirmation
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
                factors: [`📈 Momentum ${m5Momentum.toFixed(1)}x`, `M15 ${m15Direction === 'UP' ? '↑' : '↓'}`, `RR ${rr.toFixed(1)}:1`],
                tpMultiplier: 1.2,
                slMultiplier: 0.7,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
    }
    
    // SIGNAL 2: Breakout
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
                factors: [`🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`, `RR ${rr.toFixed(1)}:1`],
                tpMultiplier: 1.3,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
    }
    
    // SIGNAL 3: EMA Pullback
    if (!signal && ema9 && ema21) {
        const distanceToEMA21 = Math.abs(latestM5.close - ema21);
        const isNearEMA21 = distanceToEMA21 < atr * 0.4;
        const emaDirection = ema9 > ema21 ? 'UP' : 'DOWN';
        
        if (isNearEMA21 && m5Momentum > 0.5 && m5Direction === emaDirection) {
            const direction = emaDirection === 'UP' ? 'LONG' : 'SHORT';
            const slDist = atr * 0.6;
            const tpDist = atr * 1.0;
            const rr = tpDist / slDist;
            
            if (rr >= 1.2) {
                signal = {
                    type: direction,
                    direction: direction,
                    score: 60,
                    factors: [`🎯 Pullback to EMA21`, `RR ${rr.toFixed(1)}:1`],
                    tpMultiplier: 1.0,
                    slMultiplier: 0.6,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
    }
    
    // Log every 50 checks if no signal
    if (!signal && this._diagnostics.callCount % 50 === 0) {
        console.log(`[Jump75] No signal - Mom:${m5Momentum.toFixed(2)}, Body:${(m5BodyRatio*100).toFixed(0)}%, Dir:${m5Direction}, M15:${m15Direction}`);
        console.log(`[Jump75] Current values needed: Momentum > ${this._config.MIN_MOMENTUM}, Body > ${this._config.MIN_BODY_RATIO * 100}%`);
    }
    
    if (signal) {
        this._diagnostics.entriesFired++;
        this._lastTradeTime = Date.now();
        console.log(`[Jump75] ✅ REAL SIGNAL: ${signal.type} | ${signal.factors.join(', ')}`);
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