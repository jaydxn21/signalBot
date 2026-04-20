// ═══════════════════════════════════════════════════════════════════════════
// JUMP 75 STRUCTURE BREAK STRATEGY - VISUAL DASHBOARD VERSION
// ═══════════════════════════════════════════════════════════════════════════
// 
// Features:
// 1. Real-time status checklist (H4, Retests, Confirmation, Entry)
// 2. Frontend visual updates every candle
// 3. Intra-candle trading (don't wait for H4 breaks, trade M15 setups too)
// 4. Console + DOM updates
//
// ═══════════════════════════════════════════════════════════════════════════

export const Jump75Strategy = {
    
    _state: {
        lastBreakLevel: null,
        lastBreakDirection: null,
        retestCount: 0,
        confirmationCandleFound: false,
        confirmationCandle: null,
        setupStartTime: null,
    },
    
    _config: {
        symbol: 'JD75',
        H4_BREAKOUT_THRESHOLD: 0.0003,
        CONFIRMATION_CLOSE_THRESHOLD: 0.0015,
        MIN_RR_RATIO: 1.5,
        BREATHING_ROOM_PTS: 80,
        MAX_RETEST_AGE_HOURS: 2,
    },
    
    _diagnostics: {
        callCount: 0,
        h4BreaksDetected: 0,
        retestsDetected: 0,
        confirmationsDetected: 0,
        entriesFired: 0,
        lastH4Structure: null,
        lastBreakPrice: null,
        lastRetestTime: null,
        lastConfirmTime: null,
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // STATUS DASHBOARD - Updates UI every candle
    // ═══════════════════════════════════════════════════════════════════════
    _updateDashboard(status) {
        // Send to frontend via custom event
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('jump75-status', {
                detail: {
                    timestamp: new Date().toISOString(),
                    ...status
                }
            }));
        }
        
        // Also log to console
        console.log(`[JD75-STATUS] ${JSON.stringify(status)}`);
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════════
    
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
    
    _getH4Structure(h4Candles) {
        if (!h4Candles || h4Candles.length < 5) return null;
        
        const recent = h4Candles.slice(-20);
        const high = Math.max(...recent.map(c => c.high));
        const low = Math.min(...recent.map(c => c.low));
        const mid = (high + low) / 2;
        const range = high - low;
        
        return { high, low, mid, range };
    },
    
    _getM15Structure(m15Candles) {
        if (!m15Candles || m15Candles.length < 5) return null;
        
        const recent = m15Candles.slice(-10); // Last 2.5 hours
        const high = Math.max(...recent.map(c => c.high));
        const low = Math.min(...recent.map(c => c.low));
        const mid = (high + low) / 2;
        
        return { high, low, mid };
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // DETECT H4 BREAKS
    // ═══════════════════════════════════════════════════════════════════════
    _detectH4Break(h4Candles, m5Candles) {
        if (!h4Candles || h4Candles.length < 5) return null;
        
        const structure = this._getH4Structure(h4Candles);
        if (!structure) return null;
        
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        
        // SHORT break (below support)
        if (currentPrice < structure.low) {
            const breakDist = structure.low - currentPrice;
            const breakPercent = breakDist / structure.low;
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                this._diagnostics.h4BreaksDetected++;
                this._diagnostics.lastH4Structure = structure;
                this._diagnostics.lastBreakPrice = currentPrice;
                
                this._updateDashboard({
                    stage: 'H4_BREAK_DETECTED',
                    direction: 'SHORT',
                    breakLevel: structure.low.toFixed(4),
                    currentPrice: currentPrice.toFixed(4),
                    distance: breakDist.toFixed(4),
                    percent: (breakPercent * 100).toFixed(2),
                    h4High: structure.high.toFixed(4),
                    h4Low: structure.low.toFixed(4),
                    h4Range: structure.range.toFixed(4),
                });
                
                return {
                    direction: 'SHORT',
                    breakLevel: structure.low,
                    nextTarget: structure.mid,
                    distance: breakDist,
                };
            }
        }
        
        // LONG break (above resistance)
        if (currentPrice > structure.high) {
            const breakDist = currentPrice - structure.high;
            const breakPercent = breakDist / structure.high;
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                this._diagnostics.h4BreaksDetected++;
                this._diagnostics.lastH4Structure = structure;
                this._diagnostics.lastBreakPrice = currentPrice;
                
                this._updateDashboard({
                    stage: 'H4_BREAK_DETECTED',
                    direction: 'LONG',
                    breakLevel: structure.high.toFixed(4),
                    currentPrice: currentPrice.toFixed(4),
                    distance: breakDist.toFixed(4),
                    percent: (breakPercent * 100).toFixed(2),
                    h4High: structure.high.toFixed(4),
                    h4Low: structure.low.toFixed(4),
                    h4Range: structure.range.toFixed(4),
                });
                
                return {
                    direction: 'LONG',
                    breakLevel: structure.high,
                    nextTarget: structure.mid,
                    distance: breakDist,
                };
            }
        }
        
        return null;
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // DETECT M15 OPPORTUNITIES (Intra-candle trading)
    // ═══════════════════════════════════════════════════════════════════════
    _detectM15Opportunity(m15Candles, m5Candles, atr) {
        if (!m15Candles || m15Candles.length < 5 || !atr) return null;
        
        const structure = this._getM15Structure(m15Candles);
        if (!structure) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        
        // Check if current candle is testing M15 support/resistance
        
        // SHORT at M15 resistance
        if (latestM15.high > structure.high && currentPrice < structure.mid) {
            const testDist = latestM15.high - currentPrice;
            const testPercent = testDist / latestM15.high;
            
            if (testPercent > 0.0001) { // Any touching
                const rr = (structure.mid - currentPrice) / (latestM15.high - currentPrice + (atr * 0.5));
                
                if (rr >= this._config.MIN_RR_RATIO) {
                    this._updateDashboard({
                        stage: 'M15_OPPORTUNITY',
                        type: 'SHORT_AT_RESISTANCE',
                        level: structure.high.toFixed(4),
                        currentPrice: currentPrice.toFixed(4),
                        target: structure.mid.toFixed(4),
                        rr: rr.toFixed(2),
                    });
                    
                    return {
                        direction: 'SHORT',
                        level: structure.high,
                        target: structure.mid,
                        rr: rr,
                    };
                }
            }
        }
        
        // LONG at M15 support
        if (latestM15.low < structure.low && currentPrice > structure.mid) {
            const testDist = currentPrice - latestM15.low;
            const testPercent = testDist / currentPrice;
            
            if (testPercent > 0.0001) {
                const rr = (currentPrice - structure.mid) / (currentPrice - latestM15.low + (atr * 0.5));
                
                if (rr >= this._config.MIN_RR_RATIO) {
                    this._updateDashboard({
                        stage: 'M15_OPPORTUNITY',
                        type: 'LONG_AT_SUPPORT',
                        level: structure.low.toFixed(4),
                        currentPrice: currentPrice.toFixed(4),
                        target: structure.mid.toFixed(4),
                        rr: rr.toFixed(2),
                    });
                    
                    return {
                        direction: 'LONG',
                        level: structure.low,
                        target: structure.mid,
                        rr: rr,
                    };
                }
            }
        }
        
        return null;
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // RETEST TRACKING
    // ═══════════════════════════════════════════════════════════════════════
    _isRetesting(m5Candle, breakLevel, breakDirection) {
        if (!m5Candle || !breakLevel) return false;
        
        const tolerance = breakLevel * 0.001;
        
        if (breakDirection === 'SHORT') {
            return m5Candle.high >= (breakLevel - tolerance) && m5Candle.close < breakLevel;
        } else {
            return m5Candle.low <= (breakLevel + tolerance) && m5Candle.close > breakLevel;
        }
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // M15 CONFIRMATION DETECTION
    // ═══════════════════════════════════════════════════════════════════════
    _detectRejectionCandle(m15Candles, breakLevel, breakDirection) {
        if (!m15Candles || m15Candles.length < 2) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const tolerance = breakLevel * 0.001;
        
        if (breakDirection === 'SHORT') {
            const rejectsLevel = latestM15.close < (breakLevel - tolerance);
            const closesAwayThreshold = (breakLevel - latestM15.close) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            const candleTouchesLevel = latestM15.high >= breakLevel;
            const bodySize = Math.abs(latestM15.close - latestM15.open);
            const candleRange = latestM15.high - latestM15.low;
            const hasBody = bodySize > (candleRange * 0.4);
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                this._diagnostics.confirmationsDetected++;
                this._diagnostics.lastConfirmTime = new Date();
                
                this._updateDashboard({
                    stage: 'CONFIRMATION_FOUND',
                    direction: 'SHORT',
                    rejectionHigh: latestM15.high.toFixed(4),
                    rejectionLow: latestM15.low.toFixed(4),
                    rejectionClose: latestM15.close.toFixed(4),
                    closesAway: (closesAwayThreshold * 100).toFixed(2),
                });
                
                return {
                    direction: 'SHORT',
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    strength: closesAwayThreshold,
                };
            }
        } else {
            const rejectsLevel = latestM15.close > (breakLevel + tolerance);
            const closesAwayThreshold = (latestM15.close - breakLevel) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            const candleTouchesLevel = latestM15.low <= breakLevel;
            const bodySize = Math.abs(latestM15.close - latestM15.open);
            const candleRange = latestM15.high - latestM15.low;
            const hasBody = bodySize > (candleRange * 0.4);
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                this._diagnostics.confirmationsDetected++;
                this._diagnostics.lastConfirmTime = new Date();
                
                this._updateDashboard({
                    stage: 'CONFIRMATION_FOUND',
                    direction: 'LONG',
                    rejectionHigh: latestM15.high.toFixed(4),
                    rejectionLow: latestM15.low.toFixed(4),
                    rejectionClose: latestM15.close.toFixed(4),
                    closesAway: (closesAwayThreshold * 100).toFixed(2),
                });
                
                return {
                    direction: 'LONG',
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    strength: closesAwayThreshold,
                };
            }
        }
        
        return null;
    },
    
    // ═══════════════════════════════════════════════════════════════════════
    // MAIN ENTRY CHECK
    // ═══════════════════════════════════════════════════════════════════════
    checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._diagnostics.callCount++;
        
        // Every 50 calls, send status report
        if (this._diagnostics.callCount % 50 === 0) {
            this._updateDashboard({
                stage: 'STATUS_REPORT',
                callCount: this._diagnostics.callCount,
                h4BreaksDetected: this._diagnostics.h4BreaksDetected,
                retestsDetected: this._diagnostics.retestsDetected,
                confirmationsDetected: this._diagnostics.confirmationsDetected,
                entriesFired: this._diagnostics.entriesFired,
                currentState: this._state.lastBreakLevel ? 'SETUP_ACTIVE' : 'IDLE',
                m5Candles: m5Candles?.length || 0,
                m15Candles: m15Candles?.length || 0,
                h4Candles: h4Candles?.length || 0,
            });
        }
        
        // Validate data
        if (!m5Candles || !m15Candles || !h4Candles || !atr) return null;
        if (m5Candles.length < 10 || m15Candles.length < 10 || h4Candles.length < 5) return null;
        
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // ══════════════════════════════════════════════════════════════════
        // PHASE 1: Check for H4 breaks
        // ══════════════════════════════════════════════════════════════════
        if (!this._state.lastBreakLevel) {
            const breakSignal = this._detectH4Break(h4Candles, m5Candles);
            
            if (breakSignal) {
                this._state.lastBreakLevel = breakSignal.breakLevel;
                this._state.lastBreakDirection = breakSignal.direction;
                this._state.retestCount = 0;
                this._state.confirmationCandleFound = false;
                this._state.setupStartTime = new Date();
            }
        }
        
        // ══════════════════════════════════════════════════════════════════
        // PHASE 2: Check for M15 intra-candle opportunities
        // ══════════════════════════════════════════════════════════════════
        const m15Opportunity = this._detectM15Opportunity(m15Candles, m5Candles, atr);
        
        if (m15Opportunity && m15Opportunity.rr >= this._config.MIN_RR_RATIO) {
            const direction = m15Opportunity.direction;
            const sl = direction === 'SHORT' 
                ? latestM15.high + (this._config.BREATHING_ROOM_PTS / 10000)
                : latestM15.low - (this._config.BREATHING_ROOM_PTS / 10000);
            const tp = m15Opportunity.target;
            const risk = Math.abs(sl - currentPrice);
            const reward = Math.abs(tp - currentPrice);
            const rr = reward / risk;
            
            if (rr >= this._config.MIN_RR_RATIO) {
                this._diagnostics.entriesFired++;
                
                this._updateDashboard({
                    stage: 'ENTRY_FIRED',
                    source: 'M15_OPPORTUNITY',
                    direction: direction,
                    entryPrice: currentPrice.toFixed(4),
                    sl: sl.toFixed(4),
                    tp: tp.toFixed(4),
                    rr: rr.toFixed(2),
                });
                
                return {
                    direction: direction === 'SHORT' ? 'SELL' : 'BUY',
                    type: direction,
                    label: `JD75 ${direction} [M15]`,
                    score: 65,
                    factors: [
                        `${direction} at M15`,
                        `R:R ${rr.toFixed(2)}:1`,
                    ],
                    slMultiplier: risk / atr,
                    tpMultiplier: reward / atr,
                };
            }
        }
        
        // ══════════════════════════════════════════════════════════════════
        // PHASE 3: If H4 break active, track retests + confirmation
        // ══════════════════════════════════════════════════════════════════
        if (this._state.lastBreakLevel) {
            const setupAge = (new Date() - this._state.setupStartTime) / (1000 * 60 * 60);
            
            if (setupAge > this._config.MAX_RETEST_AGE_HOURS) {
                this._updateDashboard({
                    stage: 'SETUP_TIMEOUT',
                    ageHours: setupAge.toFixed(1),
                });
                this._state.lastBreakLevel = null;
                this._state.confirmationCandleFound = false;
                return null;
            }
            
            // Track retests
            const isRetesting = this._isRetesting(
                m5Candles[m5Candles.length - 1],
                this._state.lastBreakLevel,
                this._state.lastBreakDirection
            );
            
            if (isRetesting && !this._state.confirmationCandleFound) {
                this._state.retestCount++;
                this._diagnostics.retestsDetected++;
                this._diagnostics.lastRetestTime = new Date();
                
                this._updateDashboard({
                    stage: 'RETEST_DETECTED',
                    retestNumber: this._state.retestCount,
                    level: this._state.lastBreakLevel.toFixed(4),
                    price: m5Candles[m5Candles.length - 1].close.toFixed(4),
                });
            }
            
            // Look for confirmation
            if (this._state.retestCount > 0 && !this._state.confirmationCandleFound) {
                const rejectionSignal = this._detectRejectionCandle(
                    m15Candles,
                    this._state.lastBreakLevel,
                    this._state.lastBreakDirection
                );
                
                if (rejectionSignal) {
                    this._state.confirmationCandle = rejectionSignal;
                    this._state.confirmationCandleFound = true;
                }
            }
            
            // Enter after confirmation closes
            if (this._state.confirmationCandleFound) {
                const confirmCandle = this._state.confirmationCandle;
                const prevM15 = m15Candles[m15Candles.length - 2];
                const isNewM15Candle = latestM15.open !== confirmCandle.rejectionClose;
                
                if (isNewM15Candle) {
                    const direction = confirmCandle.direction;
                    const sl = direction === 'SHORT'
                        ? confirmCandle.rejectionHigh + (this._config.BREATHING_ROOM_PTS / 10000)
                        : confirmCandle.rejectionLow - (this._config.BREATHING_ROOM_PTS / 10000);
                    const tp = direction === 'SHORT'
                        ? this._state.lastBreakLevel - (atr * 2)
                        : this._state.lastBreakLevel + (atr * 2);
                    
                    const risk = Math.abs(sl - currentPrice);
                    const reward = Math.abs(tp - currentPrice);
                    const rr = reward / risk;
                    
                    if (rr >= this._config.MIN_RR_RATIO) {
                        this._state.lastBreakLevel = null;
                        this._state.confirmationCandleFound = false;
                        this._state.retestCount = 0;
                        
                        this._diagnostics.entriesFired++;
                        
                        this._updateDashboard({
                            stage: 'ENTRY_FIRED',
                            source: 'H4_BREAK_CONFIRMATION',
                            direction: direction,
                            retests: this._state.retestCount,
                            entryPrice: currentPrice.toFixed(4),
                            sl: sl.toFixed(4),
                            tp: tp.toFixed(4),
                            rr: rr.toFixed(2),
                        });
                        
                        return {
                            direction: direction === 'SHORT' ? 'SELL' : 'BUY',
                            type: direction,
                            label: `JD75 ${direction} [H4 Break]`,
                            score: 78,
                            factors: [
                                `${direction} H4 Break`,
                                `${this._state.retestCount} retests`,
                                `R:R ${rr.toFixed(2)}:1`,
                            ],
                            slMultiplier: risk / atr,
                            tpMultiplier: reward / atr,
                        };
                    }
                }
            }
        }
        
        return null;
    },
    
    checkClose(m5Candle, trade) {
        if (!m5Candle || !trade) return null;
        const price = m5Candle.close;
        
        if (trade.type === 'BUY' && price >= trade.tp) {
            return { action: 'CLOSE', reason: 'take_profit' };
        }
        if (trade.type === 'SELL' && price <= trade.tp) {
            return { action: 'CLOSE', reason: 'take_profit' };
        }
        if (trade.type === 'BUY' && price <= trade.sl) {
            return { action: 'CLOSE', reason: 'stop_loss' };
        }
        if (trade.type === 'SELL' && price >= trade.sl) {
            return { action: 'CLOSE', reason: 'stop_loss' };
        }
        
        return null;
    },
    
    resetState() {
        this._state = {
            lastBreakLevel: null,
            lastBreakDirection: null,
            retestCount: 0,
            confirmationCandleFound: false,
            confirmationCandle: null,
            setupStartTime: null,
        };
    },
    
    // Get diagnostic data for UI
    getDiagnostics() {
        return { ...this._diagnostics };
    }
};