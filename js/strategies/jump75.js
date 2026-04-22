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
        maxRetests: 2,
        confirmationCandleFound: false,
        confirmationCandle: null,
        setupStartTime: null,
    },
    
    _config: {
        H4_BREAKOUT_THRESHOLD: 0.0005,
        M15_REJECTION_THRESHOLD: 0.002,
        MIN_RR_RATIO: 1.5,              // Increased for better profitability
        BREATHING_ROOM_PTS: 50,
        MAX_RETEST_AGE_HOURS: 1,
        CONFIRMATION_CLOSE_THRESHOLD: 0.001,
        USE_SIMPLE_MODE: true,
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
    // MAIN ENTRY CHECK - Optimized for Jump Indices
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
        const latestH4 = h4Candles[h4Candles.length - 1];
        const prevH4 = h4Candles[h4Candles.length - 2];
        
        if (!latestM5 || !prevM5) return null;
        
        // ──────────────────────────────────────────────────────────────────
        // Calculate Metrics
        // ──────────────────────────────────────────────────────────────────
        
        const m5Body = Math.abs(latestM5.close - latestM5.open);
        const m5Range = latestM5.high - latestM5.low;
        const m5BodyRatio = m5Range > 0 ? m5Body / m5Range : 0;
        const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
        const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        const m5PrevMomentum = Math.abs(prevM5.close - prevM5_2.close) / atr;
        
        // M15 metrics
        const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
        const m15Body = Math.abs(latestM15.close - latestM15.open);
        const m15Range = latestM15.high - latestM15.low;
        const m15Strength = m15Range > 0 ? m15Body / m15Range : 0;
        const m15Momentum = Math.abs(latestM15.close - prevM15.close) / atr;
        
        // H4 trend (higher timeframe filter)
        const h4Direction = latestH4.close > prevH4.close ? 'UP' : 'DOWN';
        const h4Strength = Math.abs(latestH4.close - latestH4.open) / (latestH4.high - latestH4.low || 1);
        
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
        
        // RSI calculation
        const rsi = this._calculateRSI(m5Candles, 14);
        
        // Volume/momentum ratio
        const volumeRatio = this._calculateVolumeRatio(m5Candles);
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 1: Multi-Timeframe Alignment (Highest Quality)
        // Requires all 3 timeframes aligned
        // ──────────────────────────────────────────────────────────────────
        if (m5Momentum > 1.0 && m5BodyRatio > 0.6 && 
            m5Direction === m15Direction && m15Direction === h4Direction) {
            
            const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
            const confidence = Math.min(90, 65 + Math.round(m5Momentum * 12));
            
            // Calculate risk/reward
            const slDist = atr * 0.8;
            const tpDist = atr * 1.6;
            const rr = tpDist / slDist;
            
            if (rr < this._config.MIN_RR_RATIO) {
                console.log(`[Jump75] Skipping MTF signal - poor RR: ${rr.toFixed(2)}:1`);
                return null;
            }
            
            console.log(`[Jump75] ⭐ MTF Alignment signal: ${direction} | Mom:${m5Momentum.toFixed(2)} | H4:${h4Direction} | RR:${rr.toFixed(2)}:1`);
            
            await _sendStatusUpdate({
                status: 'ENTRY_SIGNAL_FIRED',
                direction: direction,
                entryPrice: latestM5.close,
                m5Momentum: m5Momentum,
                timeframeAlignment: 'ALL',
                rr: rr,
                timestamp: Date.now()
            });
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: confidence,
                factors: [
                    `⭐ MTF Alignment`,
                    `${direction === 'LONG' ? '📈' : '📉'} Momentum ${m5Momentum.toFixed(1)}x`,
                    `H4 ${h4Direction === 'UP' ? '↑' : '↓'} / M15 ${m15Direction === 'UP' ? '↑' : '↓'}`,
                    `RR ${rr.toFixed(1)}:1`
                ],
                tpMultiplier: 1.6,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 2: Strong Momentum with M15 Confirmation
        // ──────────────────────────────────────────────────────────────────
        if (m5Momentum > 1.2 && m5BodyRatio > 0.55 && m5Direction === m15Direction && m15Strength > 0.5) {
            const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
            const confidence = Math.min(85, 60 + Math.round(m5Momentum * 12));
            
            const slDist = atr * 0.7;
            const tpDist = atr * 1.4;
            const rr = tpDist / slDist;
            
            if (rr < this._config.MIN_RR_RATIO) {
                return null;
            }
            
            console.log(`[Jump75] 📊 Momentum signal: ${direction} | Mom:${m5Momentum.toFixed(2)} | RR:${rr.toFixed(2)}:1`);
            
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
                    `M15 ${m15Direction === 'UP' ? '↑' : '↓'} confirmation`,
                    `RR ${rr.toFixed(1)}:1`
                ],
                tpMultiplier: 1.4,
                slMultiplier: 0.7,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 3: Breakout with Volume Confirmation
        // ──────────────────────────────────────────────────────────────────
        if ((isBreakoutUp || isBreakoutDown) && m5Momentum > 0.9 && !isFalseBreakout && volumeRatio > 1.1) {
            const direction = isBreakoutUp ? 'LONG' : 'SHORT';
            
            const slDist = atr * 0.9;
            const tpDist = atr * 1.8;
            const rr = tpDist / slDist;
            
            if (rr < this._config.MIN_RR_RATIO) {
                return null;
            }
            
            console.log(`[Jump75] 🚀 Breakout signal: ${direction} | Range:${(rangeWidth/atr).toFixed(1)}x ATR | Vol:${volumeRatio.toFixed(1)}x`);
            
            await _sendStatusUpdate({
                status: 'ENTRY_SIGNAL_FIRED',
                direction: direction,
                entryPrice: latestM5.close,
                breakout: true,
                volumeRatio: volumeRatio,
                timestamp: Date.now()
            });
            
            this._diagnostics.entriesFired++;
            
            return {
                type: direction,
                direction: direction,
                score: 74,
                factors: [
                    `🚀 Breakout ${direction === 'LONG' ? '↑' : '↓'}`,
                    `Range ${(rangeWidth / atr).toFixed(1)}x ATR`,
                    `Volume ${volumeRatio.toFixed(1)}x`,
                    `RR ${rr.toFixed(1)}:1`
                ],
                tpMultiplier: 1.8,
                slMultiplier: 0.9,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 4: EMA Pullback with Momentum Increase
        // ──────────────────────────────────────────────────────────────────
        if (ema9 && ema21 && ema50) {
            const distanceToEMA21 = Math.abs(latestM5.close - ema21);
            const isNearEMA21 = distanceToEMA21 < atr * 0.35;
            const emaDirection = ema9 > ema21 ? 'UP' : 'DOWN';
            const momentumIncreasing = m5Momentum > m5PrevMomentum * 1.15;
            const isAboveEMA50 = latestM5.close > ema50;
            const isBelowEMA50 = latestM5.close < ema50;
            
            // Long setup: above EMA50, near EMA21, momentum increasing
            if (emaDirection === 'UP' && isNearEMA21 && momentumIncreasing && isAboveEMA50 && m5Direction === 'UP') {
                const direction = 'LONG';
                
                const slDist = atr * 0.6;
                const tpDist = atr * 1.3;
                const rr = tpDist / slDist;
                
                if (rr < this._config.MIN_RR_RATIO) return null;
                
                console.log(`[Jump75] 🎯 Pullback LONG | EMA dist:${(distanceToEMA21/atr).toFixed(1)}x ATR`);
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 68,
                    factors: [
                        `🎯 Pullback to EMA21`,
                        `Support bounce`,
                        `Momentum increasing`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.6,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
            
            // Short setup: below EMA50, near EMA21, momentum increasing
            if (emaDirection === 'DOWN' && isNearEMA21 && momentumIncreasing && isBelowEMA50 && m5Direction === 'DOWN') {
                const direction = 'SHORT';
                
                const slDist = atr * 0.6;
                const tpDist = atr * 1.3;
                const rr = tpDist / slDist;
                
                if (rr < this._config.MIN_RR_RATIO) return null;
                
                console.log(`[Jump75] 🎯 Pullback SHORT | EMA dist:${(distanceToEMA21/atr).toFixed(1)}x ATR`);
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 68,
                    factors: [
                        `🎯 Pullback to EMA21`,
                        `Resistance rejection`,
                        `Momentum increasing`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.6,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 5: RSI Reversal with Candle Confirmation
        // ──────────────────────────────────────────────────────────────────
        if (rsi && (rsi < 25 || rsi > 75)) {
            const isOversold = rsi < 25;
            const isOverbought = rsi > 75;
            
            // Oversold: look for bullish reversal candle
            if (isOversold && latestM5.close > latestM5.open && m5BodyRatio > 0.55 && m5Momentum > 0.7) {
                const direction = 'LONG';
                
                const slDist = atr * 0.65;
                const tpDist = atr * 1.3;
                const rr = tpDist / slDist;
                
                if (rr < this._config.MIN_RR_RATIO) return null;
                
                console.log(`[Jump75] 🔄 RSI Reversal LONG | RSI:${rsi.toFixed(0)} | Mom:${m5Momentum.toFixed(2)}`);
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 66,
                    factors: [
                        `🔄 RSI ${rsi.toFixed(0)} Oversold`,
                        `Bullish reversal candle`,
                        `Momentum ${m5Momentum.toFixed(1)}x`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.65,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
            
            // Overbought: look for bearish reversal candle
            if (isOverbought && latestM5.close < latestM5.open && m5BodyRatio > 0.55 && m5Momentum > 0.7) {
                const direction = 'SHORT';
                
                const slDist = atr * 0.65;
                const tpDist = atr * 1.3;
                const rr = tpDist / slDist;
                
                if (rr < this._config.MIN_RR_RATIO) return null;
                
                console.log(`[Jump75] 🔄 RSI Reversal SHORT | RSI:${rsi.toFixed(0)} | Mom:${m5Momentum.toFixed(2)}`);
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 66,
                    factors: [
                        `🔄 RSI ${rsi.toFixed(0)} Overbought`,
                        `Bearish reversal candle`,
                        `Momentum ${m5Momentum.toFixed(1)}x`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.3,
                    slMultiplier: 0.65,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // ──────────────────────────────────────────────────────────────────
        // SIGNAL 6: M15 Momentum with M5 Value Area Entry
        // ──────────────────────────────────────────────────────────────────
        if (m15Momentum > 0.8 && m15Strength > 0.55 && m5Direction === m15Direction && h4Direction === m15Direction) {
            const direction = m15Direction === 'UP' ? 'LONG' : 'SHORT';
            
            // Check if M5 is at value area (near EMA21)
            const valueArea = ema21 ? Math.abs(latestM5.close - ema21) < atr * 0.5 : true;
            
            if (valueArea) {
                const slDist = atr * 0.7;
                const tpDist = atr * 1.5;
                const rr = tpDist / slDist;
                
                if (rr < this._config.MIN_RR_RATIO) return null;
                
                console.log(`[Jump75] 📈 M15 Momentum entry: ${direction} | M15 Mom:${m15Momentum.toFixed(2)} | H4:${h4Direction}`);
                
                this._diagnostics.entriesFired++;
                
                return {
                    type: direction,
                    direction: direction,
                    score: 71,
                    factors: [
                        `📊 M15 ${direction === 'LONG' ? 'Momentum ↑' : 'Momentum ↓'}`,
                        `M5 value area entry`,
                        `H4 ${h4Direction === 'UP' ? '↑' : '↓'} alignment`,
                        `RR ${rr.toFixed(1)}:1`
                    ],
                    tpMultiplier: 1.5,
                    slMultiplier: 0.7,
                    _slDist: slDist,
                    _tpDist: tpDist,
                    isJump75: true
                };
            }
        }
        
        // Log why no signal (for debugging)
        if (this._diagnostics.callCount % 50 === 0) {
            console.log(`[Jump75] No signal - M5 Mom:${m5Momentum.toFixed(2)}, Dir:${m5Direction}, Body:${Math.round(m5BodyRatio * 100)}%, RSI:${rsi?.toFixed(0) || 'N/A'}, H4:${h4Direction}, M15:${m15Direction}`);
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // UTILITY: Calculate EMA
    // ─────────────────────────────────────────────────────────────────────
    _calculateEMA(candles, period) {
        if (!candles || candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // UTILITY: Calculate RSI
    // ─────────────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────────────
    // UTILITY: Calculate Volume Ratio
    // ─────────────────────────────────────────────────────────────────────
    _calculateVolumeRatio(candles) {
        if (!candles || candles.length < 20) return 1;
        
        // Note: Deriv API doesn't provide volume, using range as proxy
        const avgRange = candles.slice(-20, -1).reduce((sum, c) => sum + (c.high - c.low), 0) / 19;
        const currentRange = candles[candles.length - 1].high - candles[candles.length - 1].low;
        
        return currentRange / avgRange;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // CHECK CLOSE - Exit management with trailing stop
    // ─────────────────────────────────────────────────────────────────────
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        const price = currentCandle.close;
        const entry = trade.entry;
        const sl = trade.sl;
        const tp = trade.tp;
        const type = trade.type;
        
        // Check TP/SL hits
        if (type === 'LONG' || type === 'BUY') {
            if (currentCandle.high >= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
            
            // Trailing stop: move SL to breakeven after 50% profit
            const profit = price - entry;
            const targetDist = tp - entry;
            if (profit > targetDist * 0.5 && trade.sl === sl && sl < entry) {
                console.log(`[Jump75] 📍 Moving SL to breakeven at ${entry.toFixed(4)}`);
                return { action: 'UPDATE_SL', newSL: entry };
            }
        } 
        else if (type === 'SHORT' || type === 'SELL') {
            if (currentCandle.low <= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
            
            // Trailing stop for shorts
            const profit = entry - price;
            const targetDist = entry - tp;
            if (profit > targetDist * 0.5 && trade.sl === sl && sl > entry) {
                console.log(`[Jump75] 📍 Moving SL to breakeven at ${entry.toFixed(4)}`);
                return { action: 'UPDATE_SL', newSL: entry };
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // RESET STATE
    // ─────────────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────────────
    // GET DIAGNOSTICS
    // ─────────────────────────────────────────────────────────────────────
    getDiagnostics() {
        return {
            ...this._diagnostics,
            currentState: this._state.lastBreakLevel ? 'ACTIVE_SETUP' : 'IDLE',
            retestCount: this._state.retestCount,
            config: this._config
        };
    }
};

export default Jump75Strategy;