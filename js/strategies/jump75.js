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
    const prevM5_2 = m5Candles[m5Candles.length - 3];
    const latestM15 = m15Candles[m15Candles.length - 1];
    const prevM15 = m15Candles[m15Candles.length - 2];
    
    if (!latestM5 || !prevM5) return null;
    
    // ──────────────────────────────────────────────────────────────────
    // OPTIMIZED FOR JUMP INDICES - Lower thresholds, more signals
    // ──────────────────────────────────────────────────────────────────
    
    // Calculate metrics
    const m5Body = Math.abs(latestM5.close - latestM5.open);
    const m5Range = latestM5.high - latestM5.low;
    const m5BodyRatio = m5Body / m5Range;
    const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
    const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
    const m5PrevMomentum = Math.abs(prevM5.close - prevM5_2.close) / atr;
    
    // M15 trend and momentum
    const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
    const m15Body = Math.abs(latestM15.close - latestM15.open);
    const m15Range = latestM15.high - latestM15.low;
    const m15Strength = m15Body / m15Range;
    const m15Momentum = Math.abs(latestM15.close - prevM15.close) / atr;
    
    // Calculate EMAs
    const ema9 = this._calculateEMA(m5Candles, 9);
    const ema21 = this._calculateEMA(m5Candles, 21);
    const ema50 = this._calculateEMA(m5Candles, 50);
    
    // Breakout detection (20-period range)
    const recentHighs = m5Candles.slice(-20).map(c => c.high);
    const recentLows = m5Candles.slice(-20).map(c => c.low);
    const rangeHigh = Math.max(...recentHighs);
    const rangeLow = Math.min(...recentLows);
    const rangeWidth = rangeHigh - rangeLow;
    
    const isBreakoutUp = latestM5.close > rangeHigh && m5Direction === 'UP';
    const isBreakoutDown = latestM5.close < rangeLow && m5Direction === 'DOWN';
    const isFalseBreakout = (latestM5.high > rangeHigh && latestM5.close < rangeHigh) ||
                            (latestM5.low < rangeLow && latestM5.close > rangeLow);
    
    // RSI approximation (simplified)
    const rsi = this._calculateRSI(m5Candles, 14);
    
    // ──────────────────────────────────────────────────────────────────
    // SIGNAL 1: Strong Momentum (LOWERED THRESHOLDS)
    // ──────────────────────────────────────────────────────────────────
    if (m5Momentum > 0.8 && m5BodyRatio > 0.5 && m5Direction === m15Direction) {
        const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
        const confidence = Math.min(85, 55 + Math.round(m5Momentum * 15));
        
        console.log(`[Jump75] 📊 Momentum signal: ${direction} | Mom:${m5Momentum.toFixed(2)} | Body:${(m5BodyRatio*100).toFixed(0)}%`);
        
        await _sendStatusUpdate({
            status: 'ENTRY_SIGNAL_FIRED',
            direction: direction,
            entryPrice: latestM5.close,
            m5Momentum: m5Momentum,
            timestamp: Date.now()
        });
        
        this._diagnostics.entriesFired++;
        
        return {
            type: direction,
            direction: direction,
            score: confidence,
            factors: [
                `${direction === 'LONG' ? '📈' : '📉'} Momentum ${m5Momentum.toFixed(1)}x`,
                `Body ${Math.round(m5BodyRatio * 100)}%`,
                `M15 ${m15Direction === 'UP' ? '↑' : '↓'}`
            ],
            tpMultiplier: 1.5,
            slMultiplier: 0.8,
            isJump75: true
        };
    }
    
    // ──────────────────────────────────────────────────────────────────
    // SIGNAL 2: Breakout with momentum confirmation
    // ──────────────────────────────────────────────────────────────────
    if ((isBreakoutUp || isBreakoutDown) && m5Momentum > 0.7 && !isFalseBreakout) {
        const direction = isBreakoutUp ? 'LONG' : 'SHORT';
        
        console.log(`[Jump75] 🚀 Breakout signal: ${direction} | Range:${rangeWidth.toFixed(4)} | Mom:${m5Momentum.toFixed(2)}`);
        
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
            score: 72,
            factors: [
                `🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`,
                `Range ${(rangeWidth / atr).toFixed(1)}x ATR`,
                `Momentum ${m5Momentum.toFixed(1)}x`
            ],
            tpMultiplier: 1.8,
            slMultiplier: 0.9,
            isJump75: true
        };
    }
    
    // ──────────────────────────────────────────────────────────────────
    // SIGNAL 3: EMA Pullback with momentum increase
    // ──────────────────────────────────────────────────────────────────
    if (ema9 && ema21) {
        const distanceToEMA21 = Math.abs(latestM5.close - ema21);
        const isNearEMA21 = distanceToEMA21 < atr * 0.4;
        const emaDirection = ema9 > ema21 ? 'UP' : 'DOWN';
        const momentumIncreasing = m5Momentum > m5PrevMomentum * 1.1;
        
        if (isNearEMA21 && m5Momentum > 0.5 && m5Direction === emaDirection && momentumIncreasing) {
            const direction = emaDirection === 'UP' ? 'LONG' : 'SHORT';
            
            console.log(`[Jump75] 🎯 Pullback signal: ${direction} | EMA dist:${(distanceToEMA21/atr).toFixed(1)}x ATR`);
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: 68,
                factors: [
                    `🎯 Pullback to EMA21`,
                    `${direction === 'LONG' ? 'Support' : 'Resistance'} bounce`,
                    `Momentum increasing`
                ],
                tpMultiplier: 1.4,
                slMultiplier: 0.7,
                isJump75: true
            };
        }
    }
    
    // ──────────────────────────────────────────────────────────────────
    // SIGNAL 4: RSI Reversal (NEW)
    // ──────────────────────────────────────────────────────────────────
    if (rsi && (rsi < 30 || rsi > 70)) {
        const isOversold = rsi < 30;
        const hasReversalCandle = isOversold ? 
            (latestM5.close > latestM5.open && m5BodyRatio > 0.5) :
            (latestM5.close < latestM5.open && m5BodyRatio > 0.5);
        
        if (hasReversalCandle && m5Momentum > 0.6) {
            const direction = isOversold ? 'LONG' : 'SHORT';
            
            console.log(`[Jump75] 🔄 RSI Reversal: ${direction} | RSI:${rsi.toFixed(0)} | Mom:${m5Momentum.toFixed(2)}`);
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: 65,
                factors: [
                    `🔄 RSI ${rsi.toFixed(0)} ${isOversold ? 'Oversold' : 'Overbought'}`,
                    `Reversal candle`,
                    `Momentum ${m5Momentum.toFixed(1)}x`
                ],
                tpMultiplier: 1.3,
                slMultiplier: 0.8,
                isJump75: true
            };
        }
    }
    
    // ──────────────────────────────────────────────────────────────────
    // SIGNAL 5: M15 Breakout with M5 entry (NEW)
    // ──────────────────────────────────────────────────────────────────
    if (m15Momentum > 0.6 && m15Strength > 0.5 && m5Direction === m15Direction) {
        const direction = m15Direction === 'UP' ? 'LONG' : 'SHORT';
        
        // Check if M5 is pulling back to value area
        const valueArea = ema21 ? Math.abs(latestM5.close - ema21) < atr * 0.6 : true;
        
        if (valueArea) {
            console.log(`[Jump75] 📈 M15 Breakout entry: ${direction} | M15 Mom:${m15Momentum.toFixed(2)}`);
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: 70,
                factors: [
                    `📊 M15 ${direction === 'LONG' ? 'Breakout ↑' : 'Breakdown ↓'}`,
                    `M5 pullback entry`,
                    `M15 strength ${Math.round(m15Strength * 100)}%`
                ],
                tpMultiplier: 1.6,
                slMultiplier: 0.8,
                isJump75: true
            };
        }
    }
    
    // Log why no signal (for debugging)
    if (this._diagnostics.callCount % 50 === 0) {
        console.log(`[Jump75] No signal - M5 Mom:${m5Momentum.toFixed(2)}, Dir:${m5Direction}, Body:${(m5BodyRatio*100).toFixed(0)}%, RSI:${rsi?.toFixed(0) || 'N/A'}`);
    }
    
    return null;
},

// Add RSI calculation helper
_calculateRSI(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = candles.length - period; i < candles.length; i++) {
        const change = candles[i].close - candles[i - 1].close;
        if (change >= 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
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