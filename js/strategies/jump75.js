// js/strategies/jump75.js
// JUMP 75 STRATEGY - Optimized for Jump Indices (JD10, JD25, JD50, JD75, JD100)

async function _sendStatusUpdate(status) {
    try {
        await fetch('https://nexus-api-khvt.onrender.com/api/strategy-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                strategy: 'Jump75',
                timestamp: Date.now(),
                ...status
            })
        }).catch(() => {});
    } catch(e) {}
}

export const Jump75Strategy = {
    
    _state: {
        lastBreakLevel: null,
        lastBreakDirection: null,
        retestCount: 0,
        maxRetests: 2,  // Reduced for Jump indices
        confirmationCandleFound: false,
        confirmationCandle: null,
        setupStartTime: null,
    },
    
    _config: {
        // OPTIMIZED FOR JUMP INDICES
        H4_BREAKOUT_THRESHOLD: 0.0005,      // 0.05% - more sensitive for Jump
        M15_REJECTION_THRESHOLD: 0.002,     // 0.2% 
        MIN_RR_RATIO: 1.2,                  // Lower for more trades
        BREATHING_ROOM_PTS: 50,             // Tighter SL for Jump
        MAX_RETEST_AGE_HOURS: 1,            // Shorter setup window
        CONFIRMATION_CLOSE_THRESHOLD: 0.001, // 0.1% - easier confirmation
        USE_SIMPLE_MODE: true,              // Bypass complex H4 detection
    },

    _diagnostics: {
        callCount: 0,
        lastCheckTime: null,
        h4BreaksDetected: 0,
        retestsDetected: 0,
        confirmationsDetected: 0,
        entriesFired: 0,
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // SIMPLIFIED ENTRY FOR JUMP INDICES (NO H4 DEPENDENCY)
    // ─────────────────────────────────────────────────────────────────────
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._diagnostics.callCount++;
        
        // Send heartbeat every 20 checks for debugging
        if (this._diagnostics.callCount % 20 === 0) {
            console.log(`[Jump75] Heartbeat #${this._diagnostics.callCount}:`, {
                m5Count: m5Candles?.length || 0,
                m15Count: m15Candles?.length || 0,
                h4Count: h4Candles?.length || 0,
                atr: atr?.toFixed(4)
            });
        }
        
        if (!m5Candles || m5Candles.length < 10) return null;
        if (!m15Candles || m15Candles.length < 5) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM15 = m15Candles[m15Candles.length - 2];
        
        if (!latestM5 || !prevM5) return null;
        
        // ──────────────────────────────────────────────────────────────────
        // SIMPLE MOMENTUM SCALPING FOR JUMP INDICES
        // ──────────────────────────────────────────────────────────────────
        
        // Calculate simple metrics
        const m5Body = Math.abs(latestM5.close - latestM5.open);
        const m5Range = latestM5.high - latestM5.low;
        const m5BodyRatio = m5Body / m5Range;
        const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
        const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // M15 trend
        const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
        const m15Strength = Math.abs(latestM15.close - latestM15.open) / (latestM15.high - latestM15.low);
        
        // Check for breakout signals
        const recentHighs = m5Candles.slice(-10).map(c => c.high);
        const recentLows = m5Candles.slice(-10).map(c => c.low);
        const rangeHigh = Math.max(...recentHighs);
        const rangeLow = Math.min(...recentLows);
        
        const isBreakoutUp = latestM5.close > rangeHigh && m5Direction === 'UP';
        const isBreakoutDown = latestM5.close < rangeLow && m5Direction === 'DOWN';
        
        // SIGNAL CONDITIONS
        
        // Signal 1: Strong momentum with M15 confirmation
        if (m5Momentum > 1.2 && m5BodyRatio > 0.6 && m5Direction === m15Direction) {
            const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
            
            await _sendStatusUpdate({
                status: 'ENTRY_SIGNAL_FIRED',
                direction: direction,
                entryPrice: latestM5.close,
                m5Momentum: m5Momentum,
                m5BodyRatio: m5BodyRatio,
                timestamp: Date.now()
            });
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: Math.min(85, 60 + Math.round(m5Momentum * 10)),
                factors: [
                    `${direction === 'LONG' ? '📈' : '📉'} Momentum ${m5Momentum.toFixed(1)}x`,
                    `Body ratio ${Math.round(m5BodyRatio * 100)}%`,
                    `M15 ${m15Direction === 'UP' ? '↑' : '↓'} confirmation`
                ],
                tpMultiplier: 1.5,
                slMultiplier: 0.8,
                isJump75: true
            };
        }
        
        // Signal 2: Breakout with volume (simulated)
        if ((isBreakoutUp || isBreakoutDown) && m5Momentum > 1.0) {
            const direction = isBreakoutUp ? 'LONG' : 'SHORT';
            
            await _sendStatusUpdate({
                status: 'ENTRY_SIGNAL_FIRED',
                direction: direction,
                entryPrice: latestM5.close,
                breakout: true,
                timestamp: Date.now()
            });
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: 70,
                factors: [
                    `🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`,
                    `Range: ${(rangeHigh - rangeLow).toFixed(4)}`,
                    `ATR: ${atr.toFixed(4)}`
                ],
                tpMultiplier: 1.8,
                slMultiplier: 1.0,
                isJump75: true
            };
        }
        
        // Signal 3: Pullback to M15 support/resistance
        const ema9 = this._calculateEMA(m5Candles, 9);
        const ema21 = this._calculateEMA(m5Candles, 21);
        
        if (ema9 && ema21) {
            const distanceToEMA21 = Math.abs(latestM5.close - ema21);
            const isNearEMA21 = distanceToEMA21 < atr * 0.5;
            const emaDirection = ema9 > ema21 ? 'UP' : 'DOWN';
            
            if (isNearEMA21 && m5Momentum > 0.5 && m5Direction === emaDirection) {
                const direction = emaDirection === 'UP' ? 'LONG' : 'SHORT';
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 65,
                    factors: [
                        `🎯 Pullback to EMA21`,
                        `${direction === 'LONG' ? 'Support' : 'Resistance'} bounce`,
                        `Dist ${(distanceToEMA21 / atr).toFixed(1)}x ATR`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.7,
                    isJump75: true
                };
            }
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
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    resetState() {
        this._state = {
            lastBreakLevel: null,
            lastBreakDirection: null,
            retestCount: 0,
            maxRetests: 2,
            confirmationCandleFound: false,
            confirmationCandle: null,
            setupStartTime: null,
        };
    },
    
    getDiagnostics() {
        return this._diagnostics;
    }
};

export default Jump75Strategy;