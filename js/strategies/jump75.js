// ═══════════════════════════════════════════════════════════════════════════
// JUMP 75 STRUCTURE BREAK STRATEGY
// ═══════════════════════════════════════════════════════════════════════════
// 
// Your proven manual system automated:
// 1. H4 structure break detection (high/low breakdown)
// 2. Track retests at broken level (multiple touches allowed)
// 3. M15 confirmation (strong rejection candle)
// 4. Entry after confirmation closes decisively
// 5. SL beyond rejection candle (60-120 pts)
// 6. Target at next H4 level (min 1:2 R:R)
//
// Symbol: JUMP75 (Volatility Index)
// Timeframes: H4 (structure) + M15 (confirmation) + M5 (real-time monitoring)
// ═══════════════════════════════════════════════════════════════════════════

export const Jump75Strategy = {
    
    _state: {
        lastBreakLevel: null,
        lastBreakDirection: null,  // 'SHORT' (break below) or 'LONG' (break above)
        retestCount: 0,
        maxRetests: 3,
        confirmationCandleFound: false,
        confirmationCandle: null,
        setupStartTime: null,
    },
    
    _config: {
        symbol: 'JUMP75',
        H4_BREAKOUT_THRESHOLD: 0.001,  // 0.1% move to confirm break
        M15_REJECTION_THRESHOLD: 0.002, // 0.2% move away to confirm rejection
        MIN_RR_RATIO: 2.0,             // Minimum 1:2 risk-reward
        BREATHING_ROOM_PTS: 100,       // 60-120 pts SL buffer
        MAX_RETEST_AGE_HOURS: 2,       // Retests must occur within 2 hours
        CONFIRMATION_CLOSE_THRESHOLD: 0.003, // 0.3% decisive close away
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // UTILITY: Calculate ATR
    // ─────────────────────────────────────────────────────────────────────
    _atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const trs = [];
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i], p = candles[i - 1];
            trs.push(Math.max(
                c.high - c.low,
                Math.abs(c.high - p.close),
                Math.abs(c.low - p.close)
            ));
        }
        return trs.reduce((a, b) => a + b, 0) / period;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // UTILITY: Calculate structure levels (H4)
    // ─────────────────────────────────────────────────────────────────────
    _getH4Structure(h4Candles) {
        if (!h4Candles || h4Candles.length < 5) return null;
        
        const recent = h4Candles.slice(-20); // Last 5 days (20 H4 candles)
        const high = Math.max(...recent.map(c => c.high));
        const low = Math.min(...recent.map(c => c.low));
        const mid = (high + low) / 2;
        
        // Identify structure pivot (last swing point)
        let structurePivot = null;
        let pivotType = null;
        
        for (let i = recent.length - 1; i >= 1; i--) {
            const prev = recent[i - 1];
            const curr = recent[i];
            
            // Higher low (support pivot)
            if (i >= 2 && recent[i - 2].low > curr.low && curr.low < prev.low) {
                structurePivot = curr.low;
                pivotType = 'SUPPORT_PIVOT';
                break;
            }
            
            // Lower high (resistance pivot)
            if (i >= 2 && recent[i - 2].high < curr.high && curr.high > prev.high) {
                structurePivot = curr.high;
                pivotType = 'RESISTANCE_PIVOT';
                break;
            }
        }
        
        return {
            high,
            low,
            mid,
            structurePivot,
            pivotType,
            range: high - low
        };
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Detect H4 Structure Break
    // ─────────────────────────────────────────────────────────────────────
    _detectH4Break(h4Candles, m5Candles) {
        if (!h4Candles || h4Candles.length < 5) return null;
        
        const structure = this._getH4Structure(h4Candles);
        if (!structure) return null;
        
        const latestH4 = h4Candles[h4Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const currentPrice = latestM5.close;
        
        // Check if price broke below support (SHORT setup)
        if (latestH4.low < structure.low && currentPrice < structure.low) {
            const breakDist = structure.low - currentPrice;
            const breakPercent = breakDist / structure.low;
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                return {
                    direction: 'SHORT',
                    breakLevel: structure.low,
                    nextTarget: structure.mid, // First target = midpoint
                    distance: breakDist,
                    timeDetected: new Date()
                };
            }
        }
        
        // Check if price broke above resistance (LONG setup)
        if (latestH4.high > structure.high && currentPrice > structure.high) {
            const breakDist = currentPrice - structure.high;
            const breakPercent = breakDist / structure.high;
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                return {
                    direction: 'LONG',
                    breakLevel: structure.high,
                    nextTarget: structure.mid,
                    distance: breakDist,
                    timeDetected: new Date()
                };
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Track Retests
    // ─────────────────────────────────────────────────────────────────────
    _isRetesting(m5Candle, breakLevel, breakDirection) {
        if (!m5Candle || !breakLevel) return false;
        
        const tolerance = breakLevel * 0.001; // 0.1% tolerance
        
        if (breakDirection === 'SHORT') {
            // Retest = price comes back UP to broken level
            return m5Candle.high >= (breakLevel - tolerance) && 
                   m5Candle.close < breakLevel;
        } else {
            // Retest = price comes back DOWN to broken level
            return m5Candle.low <= (breakLevel + tolerance) && 
                   m5Candle.close > breakLevel;
        }
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: M15 Rejection Candle Detection
    // ─────────────────────────────────────────────────────────────────────
    _detectRejectionCandle(m15Candles, m5Candles, breakLevel, breakDirection) {
        if (m15Candles.length < 2 || m5Candles.length < 2) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const prevM15 = m15Candles[m15Candles.length - 2];
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        
        // Rejection candle must close decisively AWAY from broken level
        const tolerance = breakLevel * 0.001;
        
        if (breakDirection === 'SHORT') {
            // SHORT rejection: candle closes well BELOW the level (away from it)
            const rejectsLevel = latestM15.close < (breakLevel - tolerance);
            const closesAwayThreshold = (breakLevel - latestM15.close) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            
            // Candle must touch near level but close away
            const candleTouchesLevel = latestM15.high >= breakLevel;
            const hasBody = Math.abs(latestM15.close - latestM15.open) > 
                           (latestM15.high - latestM15.low) * 0.4; // At least 40% body
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                return {
                    direction: 'SHORT',
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    strength: closesAwayThreshold,
                    timeDetected: new Date()
                };
            }
        } else {
            // LONG rejection: candle closes well ABOVE the level (away from it)
            const rejectsLevel = latestM15.close > (breakLevel + tolerance);
            const closesAwayThreshold = (latestM15.close - breakLevel) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            
            // Candle must touch near level but close away
            const candleTouchesLevel = latestM15.low <= breakLevel;
            const hasBody = Math.abs(latestM15.close - latestM15.open) > 
                           (latestM15.high - latestM15.low) * 0.4;
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                return {
                    direction: 'LONG',
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    strength: closesAwayThreshold,
                    timeDetected: new Date()
                };
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ─────────────────────────────────────────────────────────────────────
    checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        if (!m5Candles || !m15Candles || !h4Candles || !atr) return null;
        if (m5Candles.length < 10 || m15Candles.length < 10 || h4Candles.length < 5) return null;
        
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 1: New Break Detected?
        // ──────────────────────────────────────────────────────────────────
        if (!this._state.lastBreakLevel) {
            const breakSignal = this._detectH4Break(h4Candles, m5Candles);
            
            if (breakSignal) {
                this._state.lastBreakLevel = breakSignal.breakLevel;
                this._state.lastBreakDirection = breakSignal.direction;
                this._state.retestCount = 0;
                this._state.confirmationCandleFound = false;
                this._state.setupStartTime = new Date();
                
                console.log(`[Jump75] 🔨 STRUCTURE BREAK DETECTED: ${breakSignal.direction}`);
                console.log(`[Jump75]   Level: ${breakSignal.breakLevel.toFixed(4)}`);
                console.log(`[Jump75]   Distance: ${breakSignal.distance.toFixed(4)}`);
                
                return null; // Wait for retest + confirmation
            }
            
            return null; // No setup yet
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 2: Are we in a Setup? Track Retests
        // ──────────────────────────────────────────────────────────────────
        
        // Check if setup is too old (abandoned)
        const setupAge = (new Date() - this._state.setupStartTime) / (1000 * 60 * 60);
        if (setupAge > this._config.MAX_RETEST_AGE_HOURS) {
            console.log(`[Jump75] ⏰ Setup abandoned (${setupAge.toFixed(1)}h old, no confirmation)`);
            this._state.lastBreakLevel = null;
            this._state.confirmationCandleFound = false;
            return null;
        }
        
        // Is price retesting the broken level?
        const isRetesting = this._isRetesting(
            m5Candles[m5Candles.length - 1],
            this._state.lastBreakLevel,
            this._state.lastBreakDirection
        );
        
        if (isRetesting && !this._state.confirmationCandleFound) {
            this._state.retestCount++;
            console.log(`[Jump75] 🔄 Retest #${this._state.retestCount} at level ${this._state.lastBreakLevel.toFixed(4)}`);
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 3: Look for Confirmation Candle (M15)
        // ──────────────────────────────────────────────────────────────────
        if (this._state.retestCount > 0 && !this._state.confirmationCandleFound) {
            const rejectionSignal = this._detectRejectionCandle(
                m15Candles,
                m5Candles,
                this._state.lastBreakLevel,
                this._state.lastBreakDirection
            );
            
            if (rejectionSignal) {
                console.log(`[Jump75] ✅ CONFIRMATION CANDLE FOUND (Retest #${this._state.retestCount})`);
                console.log(`[Jump75]   Close: ${rejectionSignal.rejectionClose.toFixed(4)}`);
                console.log(`[Jump75]   Strength: ${(rejectionSignal.strength * 100).toFixed(2)}%`);
                
                this._state.confirmationCandle = rejectionSignal;
                this._state.confirmationCandleFound = true;
                
                // Don't enter YET - wait for this candle to CLOSE
                return null;
            }
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 4: Enter AFTER Confirmation Candle Closes
        // ──────────────────────────────────────────────────────────────────
        if (this._state.confirmationCandleFound) {
            const confirmCandle = this._state.confirmationCandle;
            
            // Has the confirmation candle closed?
            // (Check if current M15 candle is DIFFERENT from confirmation)
            const prevM15 = m15Candles[m15Candles.length - 2];
            const isNewM15Candle = latestM15.open !== confirmCandle.rejectionClose;
            
            if (isNewM15Candle) {
                // Confirmation candle has closed. Enter!
                
                const direction = confirmCandle.direction;
                const breakLevel = this._state.lastBreakLevel;
                const currentPrice = m5Candles[m5Candles.length - 1].close;
                
                // ───────────────────────────────────────────────────────────
                // CALCULATE STOP LOSS & TARGET
                // ───────────────────────────────────────────────────────────
                let sl, tp, risk, reward;
                
                if (direction === 'SHORT') {
                    // SL: Just above rejection high + breathing room
                    const rejectionRange = confirmCandle.rejectionHigh - confirmCandle.rejectionLow;
                    sl = confirmCandle.rejectionHigh + (this._config.BREATHING_ROOM_PTS / 10000);
                    
                    // TP: Next H4 level down (or use structure.mid as first target)
                    tp = this._state.lastBreakLevel - (atr * 2); // Conservative first target
                    
                    risk = sl - currentPrice;
                    reward = currentPrice - tp;
                } else {
                    // SL: Just below rejection low + breathing room
                    const rejectionRange = confirmCandle.rejectionHigh - confirmCandle.rejectionLow;
                    sl = confirmCandle.rejectionLow - (this._config.BREATHING_ROOM_PTS / 10000);
                    
                    // TP: Next H4 level up
                    tp = this._state.lastBreakLevel + (atr * 2);
                    
                    risk = currentPrice - sl;
                    reward = tp - currentPrice;
                }
                
                const rr = reward / risk;
                
                // Minimum R:R check
                if (rr < this._config.MIN_RR_RATIO) {
                    console.log(`[Jump75] ⚠️  Poor R:R (${rr.toFixed(2)}:1), skipping entry`);
                    this._state.confirmationCandleFound = false;
                    return null;
                }
                
                // Reset state for next setup
                this._state.lastBreakLevel = null;
                this._state.confirmationCandleFound = false;
                this._state.retestCount = 0;
                
                console.log(`[Jump75] 📊 ENTRY SIGNAL: ${direction}`);
                console.log(`[Jump75]   SL: ${sl.toFixed(4)} (Risk: ${(risk * 10000).toFixed(0)} pts)`);
                console.log(`[Jump75]   TP: ${tp.toFixed(4)} (Reward: ${(reward * 10000).toFixed(0)} pts)`);
                console.log(`[Jump75]   R:R: ${rr.toFixed(2)}:1`);
                
                return {
                    direction: direction === 'SHORT' ? 'SELL' : 'BUY',
                    type: direction,
                    label: `JUMP75 ${direction} [Structure Break + M15 Confirmation]`,
                    score: 78, // High confidence
                    factors: [
                        `Structure Break (${direction})`,
                        `${this._state.retestCount} Retest(s)`,
                        `M15 Rejection Confirmed`,
                        `R:R ${rr.toFixed(2)}:1`
                    ],
                    slMultiplier: risk / atr,
                    tpMultiplier: reward / atr,
                    _meta: {
                        breakLevel: this._state.lastBreakLevel,
                        sl,
                        tp,
                        rr,
                        retrests: this._state.retestCount
                    }
                };
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // MANAGE EXISTING TRADES
    // ─────────────────────────────────────────────────────────────────────
    checkClose(m5Candle, trade) {
        if (!m5Candle || !trade) return null;
        
        const price = m5Candle.close;
        
        // Hit TP?
        if (trade.type === 'BUY' && price >= trade.tp) {
            return { action: 'CLOSE', reason: 'take_profit' };
        }
        if (trade.type === 'SELL' && price <= trade.tp) {
            return { action: 'CLOSE', reason: 'take_profit' };
        }
        
        // Hit SL?
        if (trade.type === 'BUY' && price <= trade.sl) {
            return { action: 'CLOSE', reason: 'stop_loss' };
        }
        if (trade.type === 'SELL' && price >= trade.sl) {
            return { action: 'CLOSE', reason: 'stop_loss' };
        }
        
        // Trailing stop: Move SL to breakeven + 50pts after 1x ATR profit
        if (trade.profit && trade.profit > trade.atr) {
            if (trade.type === 'BUY' && price > (trade.entry + trade.atr * 0.5)) {
                return { action: 'UPDATE_SL', newSL: trade.entry + 50 / 10000 };
            }
            if (trade.type === 'SELL' && price < (trade.entry - trade.atr * 0.5)) {
                return { action: 'UPDATE_SL', newSL: trade.entry - 50 / 10000 };
            }
        }
        
        return null;
    },
    
    resetState() {
        this._state = {
            lastBreakLevel: null,
            lastBreakDirection: null,
            retestCount: 0,
            maxRetests: 3,
            confirmationCandleFound: false,
            confirmationCandle: null,
            setupStartTime: null,
        };
    }
};