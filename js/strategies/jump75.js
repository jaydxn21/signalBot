// ═══════════════════════════════════════════════════════════════════════════
// JUMP 75 STRUCTURE BREAK STRATEGY - WITH STATUS REPORTING
// ═══════════════════════════════════════════════════════════════════════════
// 
// This version sends status updates to your Render backend
// which then displays on your Vercel frontend
//
// ═══════════════════════════════════════════════════════════════════════════

// Helper function to send status to your Render API
async function _sendStatusUpdate(status) {
    try {
        const response = await fetch('https://nexus-api-khvt.onrender.com/api/strategy-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                strategy: 'Jump75',
                timestamp: Date.now(),
                ...status
            })
        });
        
        if (response.ok) {
            console.log(`[Status] ✓ Sent: ${status.status}`);
        } else {
            console.log(`[Status] ✗ Failed: ${response.status}`);
        }
    } catch(e) {
        console.log('[Status] Could not send update:', e.message);
    }
}

export const Jump75Strategy = {
    
    _state: {
        lastBreakLevel: null,
        lastBreakDirection: null,
        retestCount: 0,
        maxRetests: 3,
        confirmationCandleFound: false,
        confirmationCandle: null,
        setupStartTime: null,
    },
    
    _config: {
        symbol: 'JD75',
        H4_BREAKOUT_THRESHOLD: 0.0003,      // 0.03% - catches small breaks
        M15_REJECTION_THRESHOLD: 0.0015,    // 0.15% - sensitive
        MIN_RR_RATIO: 1.5,                  // 1.5:1 - more trades
        BREATHING_ROOM_PTS: 80,             // Tighter SL
        MAX_RETEST_AGE_HOURS: 2,
        CONFIRMATION_CLOSE_THRESHOLD: 0.0015, // 0.15% - easier confirm
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
    // UTILITY: Calculate H4 structure levels (with logging)
    // ─────────────────────────────────────────────────────────────────────
    _getH4Structure(h4Candles) {
        if (!h4Candles || h4Candles.length < 5) {
            console.log('[JD75-DIAG] ⚠️  Insufficient H4 candles:', h4Candles?.length || 0);
            return null;
        }
        
        const recent = h4Candles.slice(-20); // Last 5 days
        const high = Math.max(...recent.map(c => c.high));
        const low = Math.min(...recent.map(c => c.low));
        const mid = (high + low) / 2;
        
        console.log(`[JD75-DIAG] H4 Structure (last 20 H4s):
           High: ${high.toFixed(4)}
           Low: ${low.toFixed(4)}
           Range: ${(high - low).toFixed(4)}`);
        
        return {
            high,
            low,
            mid,
            range: high - low
        };
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Detect H4 Structure Break (with full logging)
    // ─────────────────────────────────────────────────────────────────────
    async _detectH4Break(h4Candles, m5Candles) {
        if (!h4Candles || h4Candles.length < 5) return null;
        
        const structure = this._getH4Structure(h4Candles);
        if (!structure) return null;
        
        const latestH4 = h4Candles[h4Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const currentPrice = latestM5.close;
        
        console.log(`[JD75-DIAG] H4 Break Check:
           Current Price: ${currentPrice.toFixed(4)}
           H4 High: ${structure.high.toFixed(4)}
           H4 Low: ${structure.low.toFixed(4)}
           Latest H4 High: ${latestH4.high.toFixed(4)}
           Latest H4 Low: ${latestH4.low.toFixed(4)}`);
        
        // Check SHORT break (below support)
        if (latestH4.low < structure.low && currentPrice < structure.low) {
            const breakDist = structure.low - currentPrice;
            const breakPercent = breakDist / structure.low;
            
            console.log(`[JD75-DIAG] SHORT Break candidate:
               Break distance: ${breakDist.toFixed(4)} (${(breakPercent * 100).toFixed(3)}%)
               Threshold: ${this._config.H4_BREAKOUT_THRESHOLD * 100}%
               PASS? ${breakPercent > this._config.H4_BREAKOUT_THRESHOLD}`);
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                console.log(`[JD75] 🔨 SHORT BREAK DETECTED!`);
                this._diagnostics.h4BreaksDetected++;
                
                // Send status update
                await _sendStatusUpdate({
                    status: 'H4_BREAK_DETECTED',
                    direction: 'SHORT',
                    breakLevel: structure.low,
                    breakDistance: breakDist,
                    breakPercent: breakPercent * 100,
                    currentPrice: currentPrice,
                    timeDetected: new Date().toISOString()
                });
                
                return {
                    direction: 'SHORT',
                    breakLevel: structure.low,
                    nextTarget: structure.mid,
                    distance: breakDist,
                    timeDetected: new Date()
                };
            }
        }
        
        // Check LONG break (above resistance)
        if (latestH4.high > structure.high && currentPrice > structure.high) {
            const breakDist = currentPrice - structure.high;
            const breakPercent = breakDist / structure.high;
            
            console.log(`[JD75-DIAG] LONG Break candidate:
               Break distance: ${breakDist.toFixed(4)} (${(breakPercent * 100).toFixed(3)}%)
               Threshold: ${this._config.H4_BREAKOUT_THRESHOLD * 100}%
               PASS? ${breakPercent > this._config.H4_BREAKOUT_THRESHOLD}`);
            
            if (breakPercent > this._config.H4_BREAKOUT_THRESHOLD) {
                console.log(`[JD75] 🔨 LONG BREAK DETECTED!`);
                this._diagnostics.h4BreaksDetected++;
                
                // Send status update
                await _sendStatusUpdate({
                    status: 'H4_BREAK_DETECTED',
                    direction: 'LONG',
                    breakLevel: structure.high,
                    breakDistance: breakDist,
                    breakPercent: breakPercent * 100,
                    currentPrice: currentPrice,
                    timeDetected: new Date().toISOString()
                });
                
                return {
                    direction: 'LONG',
                    breakLevel: structure.high,
                    nextTarget: structure.mid,
                    distance: breakDist,
                    timeDetected: new Date()
                };
            }
        }
        
        console.log(`[JD75-DIAG] No break detected`);
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Track Retests (with logging)
    // ─────────────────────────────────────────────────────────────────────
    _isRetesting(m5Candle, breakLevel, breakDirection) {
        if (!m5Candle || !breakLevel) return false;
        
        const tolerance = breakLevel * 0.001;
        
        if (breakDirection === 'SHORT') {
            const isRetesting = m5Candle.high >= (breakLevel - tolerance) && 
                               m5Candle.close < breakLevel;
            if (isRetesting) {
                console.log(`[JD75-DIAG] SHORT Retest: High=${m5Candle.high.toFixed(4)}, Close=${m5Candle.close.toFixed(4)}, Level=${breakLevel.toFixed(4)}`);
            }
            return isRetesting;
        } else {
            const isRetesting = m5Candle.low <= (breakLevel + tolerance) && 
                               m5Candle.close > breakLevel;
            if (isRetesting) {
                console.log(`[JD75-DIAG] LONG Retest: Low=${m5Candle.low.toFixed(4)}, Close=${m5Candle.close.toFixed(4)}, Level=${breakLevel.toFixed(4)}`);
            }
            return isRetesting;
        }
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: M15 Rejection Candle Detection (with detailed logging)
    // ─────────────────────────────────────────────────────────────────────
    async _detectRejectionCandle(m15Candles, m5Candles, breakLevel, breakDirection) {
        if (m15Candles.length < 2 || m5Candles.length < 2) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const tolerance = breakLevel * 0.001;
        
        console.log(`[JD75-DIAG] M15 Rejection Check (${breakDirection}):
           Latest M15: O=${latestM15.open.toFixed(4)}, H=${latestM15.high.toFixed(4)}, L=${latestM15.low.toFixed(4)}, C=${latestM15.close.toFixed(4)}
           Break Level: ${breakLevel.toFixed(4)}`);
        
        if (breakDirection === 'SHORT') {
            const rejectsLevel = latestM15.close < (breakLevel - tolerance);
            const closesAwayThreshold = (breakLevel - latestM15.close) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            const candleTouchesLevel = latestM15.high >= breakLevel;
            const bodySize = Math.abs(latestM15.close - latestM15.open);
            const candleRange = latestM15.high - latestM15.low;
            const hasBody = bodySize > (candleRange * 0.4);
            
            console.log(`[JD75-DIAG] SHORT Rejection Analysis:
               Closes below level? ${rejectsLevel}
               Closes away %: ${(closesAwayThreshold * 100).toFixed(3)}% (needs ${this._config.CONFIRMATION_CLOSE_THRESHOLD * 100}%)
               Is Decisive? ${isDecisive}
               Touches level? ${candleTouchesLevel}
               Body: ${bodySize.toFixed(4)} / Range: ${candleRange.toFixed(4)} = ${(bodySize/candleRange*100).toFixed(1)}% (needs 40%)
               Has Body? ${hasBody}
               ALL PASS? ${rejectsLevel && isDecisive && candleTouchesLevel && hasBody}`);
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                console.log(`[JD75] ✅ SHORT REJECTION CANDLE FOUND!`);
                this._diagnostics.confirmationsDetected++;
                
                // Send status update
                await _sendStatusUpdate({
                    status: 'CONFIRMATION_CANDLE',
                    direction: 'SHORT',
                    strength: closesAwayThreshold * 100,
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    timeDetected: new Date().toISOString()
                });
                
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
            const rejectsLevel = latestM15.close > (breakLevel + tolerance);
            const closesAwayThreshold = (latestM15.close - breakLevel) / breakLevel;
            const isDecisive = closesAwayThreshold > this._config.CONFIRMATION_CLOSE_THRESHOLD;
            const candleTouchesLevel = latestM15.low <= breakLevel;
            const bodySize = Math.abs(latestM15.close - latestM15.open);
            const candleRange = latestM15.high - latestM15.low;
            const hasBody = bodySize > (candleRange * 0.4);
            
            console.log(`[JD75-DIAG] LONG Rejection Analysis:
               Closes above level? ${rejectsLevel}
               Closes away %: ${(closesAwayThreshold * 100).toFixed(3)}% (needs ${this._config.CONFIRMATION_CLOSE_THRESHOLD * 100}%)
               Is Decisive? ${isDecisive}
               Touches level? ${candleTouchesLevel}
               Body: ${bodySize.toFixed(4)} / Range: ${candleRange.toFixed(4)} = ${(bodySize/candleRange*100).toFixed(1)}% (needs 40%)
               Has Body? ${hasBody}
               ALL PASS? ${rejectsLevel && isDecisive && candleTouchesLevel && hasBody}`);
            
            if (rejectsLevel && isDecisive && candleTouchesLevel && hasBody) {
                console.log(`[JD75] ✅ LONG REJECTION CANDLE FOUND!`);
                this._diagnostics.confirmationsDetected++;
                
                // Send status update
                await _sendStatusUpdate({
                    status: 'CONFIRMATION_CANDLE',
                    direction: 'LONG',
                    strength: closesAwayThreshold * 100,
                    rejectionHigh: latestM15.high,
                    rejectionLow: latestM15.low,
                    rejectionClose: latestM15.close,
                    timeDetected: new Date().toISOString()
                });
                
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
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._diagnostics.callCount++;
        
        // Send heartbeat every 50 checks
        if (this._diagnostics.callCount % 50 === 0) {
            await _sendStatusUpdate({
                status: 'HEARTBEAT',
                callCount: this._diagnostics.callCount,
                h4Breaks: this._diagnostics.h4BreaksDetected,
                retests: this._diagnostics.retestsDetected,
                confirmations: this._diagnostics.confirmationsDetected,
                entries: this._diagnostics.entriesFired,
                currentState: this._state.lastBreakLevel ? 'ACTIVE_SETUP' : 'IDLE',
                retestCount: this._state.retestCount,
                setupAge: this._state.setupStartTime ? (Date.now() - this._state.setupStartTime) / 1000 / 60 : 0,
                timestamp: Date.now()
            });
        }
        
        if (this._diagnostics.callCount % 100 === 0) {
            console.log(`[JD75-DIAG] ========== DIAGNOSTIC REPORT (Call #${this._diagnostics.callCount}) ==========
               H4 Breaks detected: ${this._diagnostics.h4BreaksDetected}
               Retests detected: ${this._diagnostics.retestsDetected}
               Confirmations detected: ${this._diagnostics.confirmationsDetected}
               Entries fired: ${this._diagnostics.entriesFired}
               Current state: ${this._state.lastBreakLevel ? `SETUP ACTIVE (${this._state.retestCount} retests)` : 'IDLE'}
               M5 candles: ${m5Candles?.length || 0}
               M15 candles: ${m15Candles?.length || 0}
               H4 candles: ${h4Candles?.length || 0}
               =============================================================`);
        }
        
        if (!m5Candles || !m15Candles || !h4Candles || !atr) {
            console.log(`[JD75-DIAG] ⚠️  Missing data:`, { m5: !!m5Candles, m15: !!m15Candles, h4: !!h4Candles, atr: !!atr });
            return null;
        }
        if (m5Candles.length < 10 || m15Candles.length < 10 || h4Candles.length < 5) {
            if (this._diagnostics.callCount % 50 === 0) {
                console.log(`[JD75-DIAG] ⚠️  Insufficient candles: M5=${m5Candles.length}, M15=${m15Candles.length}, H4=${h4Candles.length}`);
            }
            return null;
        }
        
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 1: New Break Detected?
        // ──────────────────────────────────────────────────────────────────
        if (!this._state.lastBreakLevel) {
            const breakSignal = await this._detectH4Break(h4Candles, m5Candles);
            
            if (breakSignal) {
                this._state.lastBreakLevel = breakSignal.breakLevel;
                this._state.lastBreakDirection = breakSignal.direction;
                this._state.retestCount = 0;
                this._state.confirmationCandleFound = false;
                this._state.setupStartTime = new Date();
                
                await _sendStatusUpdate({
                    status: 'SETUP_ACTIVE',
                    direction: breakSignal.direction,
                    breakLevel: breakSignal.breakLevel,
                    setupStartTime: this._state.setupStartTime.toISOString()
                });
                
                return null; // Wait for retest + confirmation
            }
            
            return null; // No setup yet
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 2: Are we in a Setup? Track Retests
        // ──────────────────────────────────────────────────────────────────
        
        const setupAge = (new Date() - this._state.setupStartTime) / (1000 * 60 * 60);
        if (setupAge > this._config.MAX_RETEST_AGE_HOURS) {
            console.log(`[JD75] ⏰ Setup abandoned (${setupAge.toFixed(1)}h old)`);
            
            await _sendStatusUpdate({
                status: 'SETUP_ABANDONED',
                reason: 'timeout',
                ageHours: setupAge,
                maxAgeHours: this._config.MAX_RETEST_AGE_HOURS
            });
            
            this._state.lastBreakLevel = null;
            this._state.confirmationCandleFound = false;
            return null;
        }
        
        const isRetesting = this._isRetesting(
            m5Candles[m5Candles.length - 1],
            this._state.lastBreakLevel,
            this._state.lastBreakDirection
        );
        
        if (isRetesting && !this._state.confirmationCandleFound) {
            this._state.retestCount++;
            this._diagnostics.retestsDetected++;
            console.log(`[JD75] 🔄 Retest #${this._state.retestCount}`);
            
            await _sendStatusUpdate({
                status: 'RETEST_DETECTED',
                retestCount: this._state.retestCount,
                direction: this._state.lastBreakDirection,
                level: this._state.lastBreakLevel
            });
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 3: Look for Confirmation Candle (M15)
        // ──────────────────────────────────────────────────────────────────
        if (this._state.retestCount > 0 && !this._state.confirmationCandleFound) {
            const rejectionSignal = await this._detectRejectionCandle(
                m15Candles,
                m5Candles,
                this._state.lastBreakLevel,
                this._state.lastBreakDirection
            );
            
            if (rejectionSignal) {
                this._state.confirmationCandle = rejectionSignal;
                this._state.confirmationCandleFound = true;
                
                await _sendStatusUpdate({
                    status: 'WAITING_FOR_CANDLE_CLOSE',
                    direction: rejectionSignal.direction,
                    strength: rejectionSignal.strength * 100,
                    confirmationCandle: rejectionSignal
                });
                
                return null; // Wait for candle to close
            }
        }
        
        // ──────────────────────────────────────────────────────────────────
        // STAGE 4: Enter AFTER Confirmation Candle Closes
        // ──────────────────────────────────────────────────────────────────
        if (this._state.confirmationCandleFound) {
            const confirmCandle = this._state.confirmationCandle;
            const prevM15 = m15Candles[m15Candles.length - 2];
            const isNewM15Candle = latestM15.open !== confirmCandle.rejectionClose;
            
            console.log(`[JD75-DIAG] Waiting for confirmation close: prevClose=${prevM15?.close.toFixed(4)}, currOpen=${latestM15.open.toFixed(4)}, newCandle=${isNewM15Candle}`);
            
            if (isNewM15Candle) {
                const direction = confirmCandle.direction;
                const currentPrice = m5Candles[m5Candles.length - 1].close;
                
                let sl, tp, risk, reward;
                
                if (direction === 'SHORT') {
                    sl = confirmCandle.rejectionHigh + (this._config.BREATHING_ROOM_PTS / 10000);
                    tp = this._state.lastBreakLevel - (atr * 2);
                    risk = sl - currentPrice;
                    reward = currentPrice - tp;
                } else {
                    sl = confirmCandle.rejectionLow - (this._config.BREATHING_ROOM_PTS / 10000);
                    tp = this._state.lastBreakLevel + (atr * 2);
                    risk = currentPrice - sl;
                    reward = tp - currentPrice;
                }
                
                const rr = reward / risk;
                
                if (rr < this._config.MIN_RR_RATIO) {
                    console.log(`[JD75] ⚠️  Poor R:R (${rr.toFixed(2)}:1), skipping entry`);
                    
                    await _sendStatusUpdate({
                        status: 'ENTRY_SKIPPED',
                        reason: 'poor_risk_reward',
                        rr: rr,
                        minRequired: this._config.MIN_RR_RATIO
                    });
                    
                    this._state.confirmationCandleFound = false;
                    return null;
                }
                
                this._state.lastBreakLevel = null;
                this._state.confirmationCandleFound = false;
                this._state.retestCount = 0;
                
                this._diagnostics.entriesFired++;
                console.log(`[JD75] 📊 ENTRY SIGNAL: ${direction}`);
                
                const signal = {
                    direction: direction === 'SHORT' ? 'SELL' : 'BUY',
                    type: direction,
                    label: `JD75 ${direction}`,
                    score: 78,
                    factors: [
                        `${direction}`,
                        `${this._state.retestCount} retests`,
                        `R:R ${rr.toFixed(2)}:1`
                    ],
                    slMultiplier: risk / atr,
                    tpMultiplier: reward / atr,
                    entryPrice: currentPrice,
                    sl: sl,
                    tp: tp,
                    rr: rr
                };
                
                // Send final entry signal
                await _sendStatusUpdate({
                    status: 'ENTRY_SIGNAL_FIRED',
                    direction: signal.direction,
                    entryPrice: currentPrice,
                    sl: sl,
                    tp: tp,
                    rr: rr,
                    factors: signal.factors,
                    retestCount: this._state.retestCount,
                    timeDetected: new Date().toISOString()
                });
                
                // Also send to your main signal endpoint
                try {
                    await fetch('https://nexus-api-khvt.onrender.com/api/signal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: signal.direction,
                            symbol: 'JD75',
                            price: currentPrice,
                            timestamp: Date.now(),
                            strategy: 'Jump75',
                            sl: sl,
                            tp: tp,
                            rr: rr,
                            factors: signal.factors
                        })
                    });
                    console.log('[JD75] ✓ Signal sent to main API');
                } catch(e) {
                    console.log('[JD75] ✗ Failed to send signal:', e.message);
                }
                
                return signal;
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
            maxRetests: 3,
            confirmationCandleFound: false,
            confirmationCandle: null,
            setupStartTime: null,
        };
    },
    
    getDiagnostics() {
        return {
            ...this._diagnostics,
            currentState: this._state.lastBreakLevel ? 'ACTIVE_SETUP' : 'IDLE',
            retestCount: this._state.retestCount,
            setupAge: this._state.setupStartTime ? (Date.now() - this._state.setupStartTime) / 1000 / 60 : 0,
            lastBreakLevel: this._state.lastBreakLevel,
            lastBreakDirection: this._state.lastBreakDirection
        };
    }
};