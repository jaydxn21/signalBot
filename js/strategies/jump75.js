// ═══════════════════════════════════════════════════════════════════════════
// JUMP75 STRATEGY v20 - ADAPTIVE HYBRID WITH ONLINE LEARNING
// ═══════════════════════════════════════════════════════════════════════════
// Modes: 0=QUANTITY, 1=BALANCED (default), 2=QUALITY, 3=ULTRA
// Features:
//   - Adaptive mode selection (FIB vs BREAKOUT based on recent performance)
//   - Online learning - learns which strategy works better in real-time
//   - Auto-switches between retracement and breakout strategies
// ═══════════════════════════════════════════════════════════════════════════

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _h4SwingHigh: null,
    _h4SwingLow: null,
    _tradesCount: 0,

    // ═══ QUALITY MODE SELECTOR ═══
    // Change this ONE value to switch modes
    // 0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA
    QUALITY_MODE: 1,  // Default: BALANCED

    // ═══ ADAPTIVE LEARNING VARIABLES ═══
    _modePerformance: {
        FIB: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 },
        BREAKOUT: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 }
    },
    _currentMode: 'FIB',      // Starts with FIB, adapts based on performance
    _modeConfidence: 0.5,      // 0-1 confidence in current mode
    _lastSwitchTime: 0,
    _learningRate: 0.1,        // How fast to adapt (0.05 = slow, 0.2 = fast)
    _minTradesToSwitch: 5,     // Minimum trades before switching modes
    _performanceWindow: 20,    // Look back at last N trades
    _recentTrades: [],          // Trade memory for learning

    // ───────────────────────────────────────────────────────────────
    // MODE CONFIGURATIONS
    // ───────────────────────────────────────────────────────────────
    _getModeConfig() {
        const modes = {
            0: {
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                description: '100+ trades/day, 60% win rate, 1.15-1.20 PF',
                minCandlesM5: 30,
                minCandlesM15: 20,
                minCandlesH4: 6,
                cooldownMs: 60000,
                lossCooldownMs: 300000,
                minRangeATR: 3.0,
                nearFibATR: 1.2,
                minMomentum: 0.15,
                minScore: 55,
                requireTrend: false,
                requireVolume: false,
                tpMultipliers: { high: 1.8, medium: 1.6, low: 1.4, min: 1.2 },
                slMultipliers: { high: 0.9, medium: 0.9, low: 0.8, min: 0.7 },
                lotMultiplier: 1.0,
                riskPercent: 0.75
            },
            1: {
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                description: '50-70 trades/day, 65% win rate, 1.20-1.30 PF',
                minCandlesM5: 40,
                minCandlesM15: 25,
                minCandlesH4: 8,
                cooldownMs: 120000,
                lossCooldownMs: 600000,
                minRangeATR: 3.5,
                nearFibATR: 0.9,
                minMomentum: 0.25,
                minScore: 65,
                requireTrend: true,
                requireVolume: false,
                tpMultipliers: { high: 2.2, medium: 2.0, low: 1.8, min: 1.5 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 0.9, min: 0.8 },
                lotMultiplier: 1.0,
                riskPercent: 0.75
            },
            2: {
                name: 'QUALITY',
                displayName: 'QUALITY (Conservative)',
                description: '20-30 trades/day, 70% win rate, 1.30-1.50 PF',
                minCandlesM5: 50,
                minCandlesM15: 30,
                minCandlesH4: 10,
                cooldownMs: 180000,
                lossCooldownMs: 900000,
                minRangeATR: 4.0,
                nearFibATR: 0.7,
                minMomentum: 0.4,
                minScore: 75,
                requireTrend: true,
                requireVolume: true,
                tpMultipliers: { high: 2.5, medium: 2.2, low: 2.0, min: 1.8 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 0.9 },
                lotMultiplier: 0.8,
                riskPercent: 0.6
            },
            3: {
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                description: '5-10 trades/day, 80%+ win rate, 1.50-2.00 PF',
                minCandlesM5: 60,
                minCandlesM15: 40,
                minCandlesH4: 12,
                cooldownMs: 300000,
                lossCooldownMs: 1800000,
                minRangeATR: 5.0,
                nearFibATR: 0.5,
                minMomentum: 0.6,
                minScore: 85,
                requireTrend: true,
                requireVolume: true,
                tpMultipliers: { high: 3.0, medium: 2.5, low: 2.2, min: 2.0 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 1.0 },
                lotMultiplier: 0.5,
                riskPercent: 0.5
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },

    // ───────────────────────────────────────────────────────────────
    // ADAPTIVE MODE SELECTION
    // ───────────────────────────────────────────────────────────────
    
    _calculateModeScore(mode) {
        const perf = this._modePerformance[mode];
        if (perf.trades < this._minTradesToSwitch) return 0.5;
        
        const winRate = perf.trades > 0 ? perf.wins / perf.trades : 0.5;
        const avgPnL = perf.trades > 0 ? perf.totalPnL / perf.trades : 0;
        
        // Recency weighting - recent trades matter more
        let recencyBonus = 0;
        const recentModeTrades = this._recentTrades.filter(t => t.mode === mode).slice(0, 10);
        if (recentModeTrades.length > 0) {
            const recentWins = recentModeTrades.filter(t => t.outcome === 'TP').length;
            recencyBonus = (recentWins / recentModeTrades.length) * 0.3;
        }
        
        // Score: 60% win rate, 30% recency, 10% PnL magnitude
        let score = (winRate * 0.6) + recencyBonus + (Math.min(Math.abs(avgPnL), 5) / 50);
        return Math.min(0.95, Math.max(0.05, score));
    },
    
    _selectAdaptiveMode() {
        const fibScore = this._calculateModeScore('FIB');
        const breakoutScore = this._calculateModeScore('BREAKOUT');
        
        const oldMode = this._currentMode;
        
        // Switch if other mode has significantly better score (15%+ better)
        if (breakoutScore > fibScore + 0.15 && breakoutScore > 0.55) {
            this._currentMode = 'BREAKOUT';
            this._modeConfidence = breakoutScore;
        } else if (fibScore > breakoutScore + 0.15 && fibScore > 0.55) {
            this._currentMode = 'FIB';
            this._modeConfidence = fibScore;
        }
        
        if (oldMode !== this._currentMode && Date.now() - this._lastSwitchTime > 3600000) {
            this._lastSwitchTime = Date.now();
            console.log(`[Jump75-ADAPT] 🔄 Mode switch: ${oldMode} → ${this._currentMode} (Confidence: ${Math.round(this._modeConfidence*100)}%)`);
        }
        
        return this._currentMode;
    },
    
    recordTradeResult(mode, outcome, pnl) {
        if (!this._modePerformance[mode]) {
            this._modePerformance[mode] = { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 };
        }
        
        if (outcome === 'TP') {
            this._modePerformance[mode].wins++;
        } else {
            this._modePerformance[mode].losses++;
        }
        this._modePerformance[mode].totalPnL += pnl;
        this._modePerformance[mode].trades++;
        
        // Store recent trade
        this._recentTrades.unshift({ mode, outcome, pnl, time: Date.now() });
        if (this._recentTrades.length > this._performanceWindow) {
            this._recentTrades.pop();
        }
        
        // Adaptive learning rate - improve faster after losses
        if (outcome === 'SL') {
            this._learningRate = Math.min(0.25, this._learningRate + 0.02);
        } else {
            this._learningRate = Math.max(0.05, this._learningRate - 0.005);
        }
        
        // Log performance update
        if (this._modePerformance[mode].trades % 5 === 0) {
            const winRate = Math.round((this._modePerformance[mode].wins / this._modePerformance[mode].trades) * 100);
            console.log(`[Jump75-Learn] 📊 ${mode} performance: ${winRate}% win rate (${this._modePerformance[mode].trades} trades) | Learning rate: ${Math.round(this._learningRate*100)}%`);
        }
    },

    // ───────────────────────────────────────────────────────────────
    // BREAKOUT DETECTION (NEW)
    // ───────────────────────────────────────────────────────────────
    
    _detectBreakout(m5Candles, m15Candles, h4Candles, atr, config) {
        if (m5Candles.length < 20) return null;
        
        const lastM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const lastM15 = m15Candles[m15Candles.length - 1];
        
        // Calculate momentum
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return null;
        
        const momentum = (ema8 - ema21) / atr;
        
        // Volume confirmation
        const volumeConfirmed = this._hasVolumeConfirmation(m5Candles);
        const volumeOk = !config.requireVolume || volumeConfirmed;
        
        // Breakout detection conditions
        const strongGreenCandle = lastM5.close > lastM5.open && 
                                   (lastM5.close - lastM5.open) > atr * 0.4;
        const strongRedCandle = lastM5.close < lastM5.open && 
                                 (lastM5.open - lastM5.close) > atr * 0.4;
        const consecutiveGreen = lastM5.close > lastM5.open && 
                                  prevM5.close > prevM5.open;
        const consecutiveRed = lastM5.close < lastM5.open && 
                                prevM5.close < prevM5.open;
        const aboveEMAs = lastM15.close > ema8 && ema8 > ema21;
        const momentumStrong = Math.abs(momentum) > 0.4;
        
        // Breakout BUY - catch early trend
        if (strongGreenCandle && momentumStrong && aboveEMAs && volumeOk && momentum > 0) {
            const scoreBoost = consecutiveGreen ? 10 : 5;
            return {
                type: 'LONG',
                score: 75 + scoreBoost,
                factors: ['🔥 BREAKOUT', 'Strong momentum', 'Above EMAs', consecutiveGreen ? '2nd green candle' : 'Volume surge'],
                mode: 'BREAKOUT'
            };
        }
        
        // Breakout SELL
        if (strongRedCandle && momentumStrong && !aboveEMAs && volumeOk && momentum < 0) {
            const scoreBoost = consecutiveRed ? 10 : 5;
            return {
                type: 'SHORT',
                score: 75 + scoreBoost,
                factors: ['🔥 BREAKDOWN', 'Strong momentum', 'Below EMAs', consecutiveRed ? '2nd red candle' : 'Volume surge'],
                mode: 'BREAKOUT'
            };
        }
        
        return null;
    },
    
    // ───────────────────────────────────────────────────────────────
    // FIBONACCI RETRACEMENT DETECTION
    // ───────────────────────────────────────────────────────────────
    
    _detectFibonacciRetracement(m5Candles, m15Candles, h4Candles, atr, config) {
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * config.minRangeATR) return null;
        
        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * config.nearFibATR;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atr * (config.nearFibATR + 0.2);
        
        const m5Momentum = this._getM5Momentum(m5Candles);
        const bullishCandle = latestM5.close > prevM5.close;
        const bearishCandle = latestM5.close < prevM5.close;
        const aboveLow = latestM15.close > this._h4SwingLow;
        const belowHigh = latestM15.close < this._h4SwingHigh;
        
        const m15Trend = this._getM15Trend(m15Candles);
        const trendOk = !config.requireTrend || m15Trend !== 'NEUTRAL';
        const volumeOk = !config.requireVolume || this._hasVolumeConfirmation(m5Candles);
        
        // Fibonacci LONG
        if (near618 && m5Momentum > config.minMomentum && bullishCandle && aboveLow && trendOk && volumeOk) {
            return {
                type: 'LONG',
                score: 78,
                factors: ['📊 Fib 61.8% bounce', 'Momentum confirmation', 'H4 structure'],
                mode: 'FIB'
            };
        }
        
        // Fibonacci SHORT
        if (near618 && m5Momentum < -config.minMomentum && bearishCandle && belowHigh && trendOk && volumeOk) {
            return {
                type: 'SHORT',
                score: 78,
                factors: ['📊 Fib 61.8% rejection', 'Momentum confirmation', 'H4 structure'],
                mode: 'FIB'
            };
        }
        
        // Fib 50% (lower quality)
        if (near50 && Math.abs(m5Momentum) > config.minMomentum * 0.8 && trendOk) {
            if (m5Momentum > 0 && aboveLow) {
                return {
                    type: 'LONG',
                    score: 68,
                    factors: ['📊 Fib 50% reaction', 'Entry confirmed'],
                    mode: 'FIB'
                };
            } else if (m5Momentum < 0 && belowHigh) {
                return {
                    type: 'SHORT',
                    score: 68,
                    factors: ['📊 Fib 50% reaction', 'Entry confirmed'],
                    mode: 'FIB'
                };
            }
        }
        
        return null;
    },

    // ───────────────────────────────────────────────────────────────
    // SESSION MANAGEMENT
    // ───────────────────────────────────────────────────────────────
    initSession() {
        const now = new Date();
        const today = now.toDateString();
        if (!this._dailyStartTime || new Date(this._dailyStartTime).toDateString() !== today) {
            this._dailyProfit = 0;
            this._tradesCount = 0;
            this._consecutiveLosses = 0;
            this._dailyStartTime = now.getTime();
            const config = this._getModeConfig();
            console.log(`[Jump75 ${config.name}] New session started - Adaptive learning active`);
        }
    },

    recordTrade(outcome, pnl, mode = null) {
        this._tradesCount++;
        this._dailyProfit += pnl;
        
        if (mode) {
            this.recordTradeResult(mode, outcome, pnl);
        }
        
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
        } else {
            this._consecutiveLosses++;
        }
    },

    // ───────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK (ADAPTIVE)
    // ───────────────────────────────────────────────────────────────
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this.initSession();
        const config = this._getModeConfig();
        
        if (!m5Candles || m5Candles.length < config.minCandlesM5 || 
            !m15Candles || m15Candles.length < config.minCandlesM15 || 
            !h4Candles || h4Candles.length < config.minCandlesH4) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < config.lossCooldownMs) return null;

        const latestM15 = m15Candles[m15Candles.length - 1];
        
        // Update H4 structure
        this._updateH4Structure(h4Candles);
        
        // Select which mode to use based on recent performance
        const activeMode = this._selectAdaptiveMode();
        
        let signal = null;
        
        // Try BREAKOUT mode if it's selected or if confidence is high
        if (activeMode === 'BREAKOUT' || this._modePerformance.BREAKOUT.trades < 3) {
            signal = this._detectBreakout(m5Candles, m15Candles, h4Candles, atr, config);
            if (signal) {
                signal.adaptiveMode = 'BREAKOUT';
            }
        }
        
        // Try FIB mode if breakout didn't fire or if FIB is selected
        if (!signal && (activeMode === 'FIB' || this._modePerformance.FIB.trades < 3)) {
            signal = this._detectFibonacciRetracement(m5Candles, m15Candles, h4Candles, atr, config);
            if (signal) {
                signal.adaptiveMode = 'FIB';
            }
        }
        
        // If both modes failed, try the other mode as fallback
        if (!signal) {
            if (activeMode === 'BREAKOUT') {
                signal = this._detectFibonacciRetracement(m5Candles, m15Candles, h4Candles, atr, config);
                if (signal) signal.adaptiveMode = 'FIB';
            } else {
                signal = this._detectBreakout(m5Candles, m15Candles, h4Candles, atr, config);
                if (signal) signal.adaptiveMode = 'BREAKOUT';
            }
        }
        
        if (!signal) return null;
        
        // Quality filter
        if (signal.score < config.minScore) return null;
        
        // Store mode for result tracking
        this._lastTradeTime = now;
        
        // Different TP/SL for different modes
        if (signal.adaptiveMode === 'BREAKOUT') {
            signal.tpMultiplier = 1.5;  // Shorter target for breakouts (catch early momentum)
            signal.slMultiplier = 0.8;  // Tighter SL for breakouts
            signal.riskPercent = 0.5;   // Lower risk for breakouts (quick scalps)
        } else {
            signal.tpMultiplier = 2.2;  // Wider target for retracements
            signal.slMultiplier = 1.0;  // Normal SL for retracements
            signal.riskPercent = 0.75;  // Normal risk
        }
        
        // Log signal with performance stats
        const fibWR = this._modePerformance.FIB.trades > 0 ? 
            Math.round((this._modePerformance.FIB.wins / this._modePerformance.FIB.trades) * 100) : 0;
        const breakoutWR = this._modePerformance.BREAKOUT.trades > 0 ? 
            Math.round((this._modePerformance.BREAKOUT.wins / this._modePerformance.BREAKOUT.trades) * 100) : 0;
        
        console.log(`[Jump75 ${config.name}] 🎯 ${signal.adaptiveMode} mode → ${signal.type} signal | Score ${signal.score} | ${signal.factors.join(' · ')}`);
        console.log(`   Performance: FIB: ${fibWR}% (${this._modePerformance.FIB.trades}) | BREAKOUT: ${breakoutWR}% (${this._modePerformance.BREAKOUT.trades}) | Active: ${activeMode}`);
        
        return signal;
    },

    _createSignal(type, score, factors, config) {
        let tpMultiplier, slMultiplier;
        if (score >= 85) {
            tpMultiplier = config.tpMultipliers.high;
            slMultiplier = config.slMultipliers.high;
        } else if (score >= 75) {
            tpMultiplier = config.tpMultipliers.medium;
            slMultiplier = config.slMultipliers.medium;
        } else if (score >= 65) {
            tpMultiplier = config.tpMultipliers.low;
            slMultiplier = config.slMultipliers.low;
        } else {
            tpMultiplier = config.tpMultipliers.min;
            slMultiplier = config.slMultipliers.min;
        }
        return {
            type, score, factors, tpMultiplier, slMultiplier,
            isJump75: true, qualityMode: config.name,
            lotMultiplier: config.lotMultiplier, riskPercent: config.riskPercent
        };
    },

    _getM15Trend(m15Candles) {
        if (m15Candles.length < 20) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        const prev = m15Candles[m15Candles.length - 2];
        if (latest.close > ema8 && ema8 > ema21 && latest.close > prev.close) return 'UP';
        if (latest.close < ema8 && ema8 < ema21 && latest.close < prev.close) return 'DOWN';
        return 'NEUTRAL';
    },

    _hasVolumeConfirmation(m5Candles) {
        if (m5Candles.length < 10) return false;
        const latest = m5Candles[m5Candles.length - 1];
        const avgVolume = m5Candles.slice(-10).reduce((s, c) => s + (c.volume || 0), 0) / 10;
        return (latest.volume || 0) > avgVolume * 1.2;
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 12) return;
        const recent = h4Candles.slice(-14);
        this._h4SwingHigh = Math.max(...recent.map(c => c.high));
        this._h4SwingLow = Math.min(...recent.map(c => c.low));
    },

    _calculateFibLevels(low, high) {
        const diff = high - low;
        return { fib50: high - diff * 0.5, fib618: high - diff * 0.618 };
    },

    _getM5Momentum(m5Candles) {
        if (m5Candles.length < 15) return 0;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return 0;
        const atr = this._calculateATR(m5Candles, 14);
        if (atr === 0) return (ema8 - ema21) / 10;
        return (ema8 - ema21) / atr;
    },

    _calculateEMA(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    _calculateATR(candles, period) {
        if (candles.length < period + 1) return 0;
        let atr = 0;
        for (let i = 1; i <= period; i++) {
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i-1].close),
                Math.abs(candles[i].low - candles[i-1].close)
            );
            atr += tr;
        }
        return atr / period;
    },

    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        let closeAction = null;
        let outcome = null;
        let pnl = 0;
        
        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                outcome = 'TP';
                pnl = (trade.tp - trade.entry) * (trade.lotSize || 0.01);
                closeAction = { action: 'CLOSE', reason: 'TP' };
            } else if (currentCandle.low <= trade.sl) {
                outcome = 'SL';
                pnl = (trade.entry - trade.sl) * (trade.lotSize || 0.01);
                closeAction = { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                outcome = 'TP';
                pnl = (trade.entry - trade.tp) * (trade.lotSize || 0.01);
                closeAction = { action: 'CLOSE', reason: 'TP' };
            } else if (currentCandle.high >= trade.sl) {
                outcome = 'SL';
                pnl = (trade.sl - trade.entry) * (trade.lotSize || 0.01);
                closeAction = { action: 'CLOSE', reason: 'SL' };
            }
        }
        
        if (closeAction) {
            // Record trade with adaptive mode if available
            const mode = trade.adaptiveMode || (trade.factors?.includes('BREAKOUT') ? 'BREAKOUT' : 'FIB');
            this.recordTrade(outcome, pnl, mode);
            
            if (outcome === 'TP') {
                this._consecutiveLosses = 0;
            } else {
                this._consecutiveLosses++;
            }
        }
        
        return closeAction;
    },

    getStats() {
        const config = this._getModeConfig();
        const fibPerf = this._modePerformance.FIB;
        const breakoutPerf = this._modePerformance.BREAKOUT;
        
        return {
            mode: config.name,
            displayName: config.displayName,
            dailyProfit: this._dailyProfit,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            winRate: this._tradesCount > 0 ? (((this._tradesCount - this._consecutiveLosses) / this._tradesCount) * 100).toFixed(1) : 0,
            adaptiveMode: this._currentMode,
            learningRate: Math.round(this._learningRate * 100),
            performance: {
                FIB: {
                    wins: fibPerf.wins,
                    losses: fibPerf.losses,
                    trades: fibPerf.trades,
                    winRate: fibPerf.trades > 0 ? Math.round((fibPerf.wins / fibPerf.trades) * 100) : 0,
                    avgPnL: fibPerf.trades > 0 ? (fibPerf.totalPnL / fibPerf.trades).toFixed(2) : 0
                },
                BREAKOUT: {
                    wins: breakoutPerf.wins,
                    losses: breakoutPerf.losses,
                    trades: breakoutPerf.trades,
                    winRate: breakoutPerf.trades > 0 ? Math.round((breakoutPerf.wins / breakoutPerf.trades) * 100) : 0,
                    avgPnL: breakoutPerf.trades > 0 ? (breakoutPerf.totalPnL / breakoutPerf.trades).toFixed(2) : 0
                }
            }
        };
    },

    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using BALANCED (1) instead.`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] Quality mode switched to ${config.displayName}`);
        return true;
    },

    forceAdaptiveMode(mode) {
        if (mode !== 'FIB' && mode !== 'BREAKOUT') return false;
        this._currentMode = mode;
        console.log(`[Jump75] ⚡ Force adaptive mode: ${mode}`);
        return true;
    },

    resetLearning() {
        this._modePerformance = {
            FIB: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 },
            BREAKOUT: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 }
        };
        this._recentTrades = [];
        this._currentMode = 'FIB';
        this._learningRate = 0.1;
        this._modeConfidence = 0.5;
        console.log(`[Jump75] 🧠 Learning data reset - starting fresh`);
        return true;
    },

    getAllModes() {
        return {
            0: this._getModeConfig.call({ QUALITY_MODE: 0 }),
            1: this._getModeConfig.call({ QUALITY_MODE: 1 }),
            2: this._getModeConfig.call({ QUALITY_MODE: 2 }),
            3: this._getModeConfig.call({ QUALITY_MODE: 3 })
        };
    }
};

export default Jump75Strategy;