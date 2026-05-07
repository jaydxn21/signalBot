// ═══════════════════════════════════════════════════════════════════════════
// JUMP75 STRATEGY v21 - UI SYNC & IMPROVED WIN RATE
// ═══════════════════════════════════════════════════════════════════════════
// Modes: 0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA
// Features:
//   - UI Quality Mode Selector support (setMode/getCurrentConfig)
//   - Tighter entry filters for better win rate
//   - Market state detection (trending vs ranging)
//   - Adaptive TP/SL based on market conditions
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
    QUALITY_MODE: 2,  // Changed to QUALITY mode (was BALANCED) for better win rate

    // ═══ MARKET STATE TRACKING ═══
    _marketState: 'RANGING',  // RANGING, TRENDING_UP, TRENDING_DOWN
    _lastMarketCheck: 0,

    // ═══ ADAPTIVE LEARNING VARIABLES ═══
    _modePerformance: {
        FIB: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 },
        BREAKOUT: { wins: 0, losses: 0, totalPnL: 0, trades: 0, lastUsed: 0 }
    },
    _currentMode: 'FIB',
    _modeConfidence: 0.5,
    _lastSwitchTime: 0,
    _learningRate: 0.1,
    _minTradesToSwitch: 5,
    _performanceWindow: 20,
    _recentTrades: [],

    // ───────────────────────────────────────────────────────────────
    // MODE CONFIGURATIONS (UPDATED FOR BETTER WIN RATE)
    // ───────────────────────────────────────────────────────────────
    _getModeConfig() {
        const modes = {
            0: {
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                minCandlesM5: 30, minCandlesM15: 20, minCandlesH4: 6,
                cooldownMs: 60000, lossCooldownMs: 300000,
                minRangeATR: 3.0, nearFibATR: 1.2,
                minMomentum: 0.15, minScore: 55,
                requireTrend: false, requireVolume: false,
                tpMultipliers: { high: 1.8, medium: 1.6, low: 1.4, min: 1.2 },
                slMultipliers: { high: 0.9, medium: 0.9, low: 0.8, min: 0.7 },
                lotMultiplier: 1.0, riskPercent: 0.75,
                requireEngulfing: false, requireWickRejection: false
            },
            1: {
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                minCandlesM5: 40, minCandlesM15: 25, minCandlesH4: 8,
                cooldownMs: 120000, lossCooldownMs: 600000,
                minRangeATR: 3.5, nearFibATR: 0.9,
                minMomentum: 0.25, minScore: 65,
                requireTrend: true, requireVolume: false,
                tpMultipliers: { high: 2.2, medium: 2.0, low: 1.8, min: 1.5 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 0.9, min: 0.8 },
                lotMultiplier: 1.0, riskPercent: 0.75,
                requireEngulfing: false, requireWickRejection: false
            },
            2: {
                name: 'QUALITY',
                displayName: 'QUALITY (Conservative)',
                minCandlesM5: 50, minCandlesM15: 30, minCandlesH4: 10,
                cooldownMs: 180000, lossCooldownMs: 900000,
                minRangeATR: 4.0, nearFibATR: 0.6,  // TIGHTER zone
                minMomentum: 0.45, minScore: 75,    // HIGHER momentum
                requireTrend: true, requireVolume: true,
                tpMultipliers: { high: 2.8, medium: 2.5, low: 2.2, min: 2.0 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 0.95 },
                lotMultiplier: 0.7, riskPercent: 0.6,
                requireEngulfing: true, requireWickRejection: true  // NEW: pattern confirmation
            },
            3: {
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                minCandlesM5: 60, minCandlesM15: 40, minCandlesH4: 12,
                cooldownMs: 300000, lossCooldownMs: 1800000,
                minRangeATR: 5.0, nearFibATR: 0.5,
                minMomentum: 0.6, minScore: 85,
                requireTrend: true, requireVolume: true,
                tpMultipliers: { high: 3.0, medium: 2.5, low: 2.2, min: 2.0 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 1.0 },
                lotMultiplier: 0.5, riskPercent: 0.5,
                requireEngulfing: true, requireWickRejection: true
            }
        };
        return modes[this.QUALITY_MODE] || modes[2];
    },

    // ───────────────────────────────────────────────────────────────
    // MARKET STATE DETECTION
    // ───────────────────────────────────────────────────────────────
    _detectMarketState(h4Candles, atr) {
        if (h4Candles.length < 10) return 'RANGING';
        
        const ema20 = this._calculateEMA(h4Candles, 20);
        const ema50 = this._calculateEMA(h4Candles, 50);
        if (!ema20 || !ema50) return 'RANGING';
        
        const latest = h4Candles[h4Candles.length - 1];
        const prev = h4Candles[h4Candles.length - 2];
        
        if (latest.close > ema20 && ema20 > ema50 && latest.close > prev.close) {
            return 'TRENDING_UP';
        }
        if (latest.close < ema20 && ema20 < ema50 && latest.close < prev.close) {
            return 'TRENDING_DOWN';
        }
        return 'RANGING';
    },

    // ───────────────────────────────────────────────────────────────
    // CANDLE PATTERN CONFIRMATIONS (NEW)
    // ───────────────────────────────────────────────────────────────
    _isBullishEngulfing(prev, curr) {
        if (!prev || !curr) return false;
        return prev.close < prev.open && 
               curr.close > curr.open && 
               curr.close > prev.high && 
               curr.open < prev.low;
    },

    _isBearishEngulfing(prev, curr) {
        if (!prev || !curr) return false;
        return prev.close > prev.open && 
               curr.close < curr.open && 
               curr.close < prev.low && 
               curr.open > prev.high;
    },

    _hasWickRejection(candle) {
        if (!candle) return false;
        const body = Math.abs(candle.close - candle.open);
        const upperWick = candle.high - Math.max(candle.close, candle.open);
        const lowerWick = Math.min(candle.close, candle.open) - candle.low;
        return upperWick > body * 1.5 || lowerWick > body * 1.5;
    },

    // ───────────────────────────────────────────────────────────────
    // ADAPTIVE MODE SELECTION
    // ───────────────────────────────────────────────────────────────
    _calculateModeScore(mode) {
        const perf = this._modePerformance[mode];
        if (perf.trades < this._minTradesToSwitch) return 0.5;
        
        const winRate = perf.trades > 0 ? perf.wins / perf.trades : 0.5;
        const avgPnL = perf.trades > 0 ? perf.totalPnL / perf.trades : 0;
        
        let recencyBonus = 0;
        const recentModeTrades = this._recentTrades.filter(t => t.mode === mode).slice(0, 10);
        if (recentModeTrades.length > 0) {
            const recentWins = recentModeTrades.filter(t => t.outcome === 'TP').length;
            recencyBonus = (recentWins / recentModeTrades.length) * 0.3;
        }
        
        let score = (winRate * 0.6) + recencyBonus + (Math.min(Math.abs(avgPnL), 5) / 50);
        return Math.min(0.95, Math.max(0.05, score));
    },
    
    _selectAdaptiveMode() {
        const fibScore = this._calculateModeScore('FIB');
        const breakoutScore = this._calculateModeScore('BREAKOUT');
        
        const oldMode = this._currentMode;
        
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
        
        this._recentTrades.unshift({ mode, outcome, pnl, time: Date.now() });
        if (this._recentTrades.length > this._performanceWindow) {
            this._recentTrades.pop();
        }
        
        if (outcome === 'SL') {
            this._learningRate = Math.min(0.25, this._learningRate + 0.02);
        } else {
            this._learningRate = Math.max(0.05, this._learningRate - 0.005);
        }
        
        if (this._modePerformance[mode].trades % 5 === 0) {
            const winRate = Math.round((this._modePerformance[mode].wins / this._modePerformance[mode].trades) * 100);
            console.log(`[Jump75-Learn] 📊 ${mode} performance: ${winRate}% (${this._modePerformance[mode].trades} trades)`);
        }
    },

    // ───────────────────────────────────────────────────────────────
    // QUALITY SIGNAL DETECTION (UPDATED)
    // ───────────────────────────────────────────────────────────────
    _getQualitySignal(m5Candles, m15Candles, h4Candles, atr, config) {
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * config.minRangeATR) return null;
        
        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * config.nearFibATR;
        
        if (!near618) return null;
        
        const m5Momentum = this._getM5Momentum(m5Candles);
        if (Math.abs(m5Momentum) < config.minMomentum) return null;
        
        // Pattern confirmations
        const bullishEngulfing = this._isBullishEngulfing(prevM5, latestM5);
        const bearishEngulfing = this._isBearishEngulfing(prevM5, latestM5);
        const wickRejection = this._hasWickRejection(latestM5);
        
        // Pattern requirement for QUALITY/ULTRA modes
        if (config.requireEngulfing && !bullishEngulfing && !bearishEngulfing) return null;
        if (config.requireWickRejection && !wickRejection) return null;
        
        const m15Trend = this._getM15Trend(m15Candles);
        const aboveLow = latestM15.close > this._h4SwingLow;
        const belowHigh = latestM15.close < this._h4SwingHigh;
        const volumeConfirmed = this._hasVolumeConfirmation(m5Candles);
        
        let signal = null;
        let score = config.minScore;
        
        // LONG
        if (m5Momentum > 0 && aboveLow) {
            if (bullishEngulfing) score += 10;
            if (wickRejection) score += 8;
            if (m15Trend === 'UP') score += 7;
            if (volumeConfirmed) score += 5;
            
            if (score >= config.minScore) {
                signal = this._createSignal('LONG', score, 
                    this._buildFactors(['Fib 61.8%', 'Momentum'], bullishEngulfing, wickRejection, m15Trend === 'UP', volumeConfirmed), 
                    config);
            }
        }
        
        // SHORT
        if (!signal && m5Momentum < 0 && belowHigh) {
            if (bearishEngulfing) score += 10;
            if (wickRejection) score += 8;
            if (m15Trend === 'DOWN') score += 7;
            if (volumeConfirmed) score += 5;
            
            if (score >= config.minScore) {
                signal = this._createSignal('SHORT', score,
                    this._buildFactors(['Fib 61.8%', 'Momentum'], bearishEngulfing, wickRejection, m15Trend === 'DOWN', volumeConfirmed),
                    config);
            }
        }
        
        return signal;
    },

    _buildFactors(base, engulfing, wickRejection, trendAligned, volumeConfirmed) {
        const factors = [...base];
        if (engulfing) factors.push('Engulfing');
        if (wickRejection) factors.push('Wick rejection');
        if (trendAligned) factors.push('Trend aligned');
        if (volumeConfirmed) factors.push('Volume spike');
        return factors;
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
            console.log(`[Jump75 ${config.name}] New session started`);
        }
    },

    recordTrade(outcome, pnl, mode = null) {
        this._tradesCount++;
        this._dailyProfit += pnl;
        if (mode) this.recordTradeResult(mode, outcome, pnl);
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
        } else {
            this._consecutiveLosses++;
        }
    },

    // ───────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
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
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.lossCooldownMs) return null;

        this._updateH4Structure(h4Candles);
        this._marketState = this._detectMarketState(h4Candles, atr);
        
        const signal = this._getQualitySignal(m5Candles, m15Candles, h4Candles, atr, config);
        if (!signal) return null;
        
        // In trending markets, only take signals with the trend
        if (this._marketState === 'TRENDING_UP' && signal.type !== 'LONG') return null;
        if (this._marketState === 'TRENDING_DOWN' && signal.type !== 'SHORT') return null;
        
        this._lastTradeTime = now;
        console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | Market: ${this._marketState}`);
        
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

    // ───────────────────────────────────────────────────────────────
    // HELPER METHODS
    // ───────────────────────────────────────────────────────────────
    _getM15Trend(m15Candles) {
        if (m15Candles.length < 20) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        if (latest.close > ema8 && ema8 > ema21) return 'UP';
        if (latest.close < ema8 && ema8 < ema21) return 'DOWN';
        return 'NEUTRAL';
    },

    _hasVolumeConfirmation(m5Candles) {
        if (m5Candles.length < 10) return false;
        const latest = m5Candles[m5Candles.length - 1];
        const avgVolume = m5Candles.slice(-10).reduce((s, c) => s + (c.volume || 0), 0) / 10;
        return (latest.volume || 0) > avgVolume * 1.3;  // 30% volume spike required
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

    // ───────────────────────────────────────────────────────────────
    // TRADE CLOSE CHECK
    // ───────────────────────────────────────────────────────────────
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
            const mode = trade.adaptiveMode || (trade.factors?.some(f => f.includes('BREAKOUT')) ? 'BREAKOUT' : 'FIB');
            this.recordTrade(outcome, pnl, mode);
        }
        
        return closeAction;
    },

    // ───────────────────────────────────────────────────────────────
    // PUBLIC API METHODS (FOR UI INTEGRATION)
    // ───────────────────────────────────────────────────────────────
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
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0,
            adaptiveMode: this._currentMode,
            marketState: this._marketState,
            performance: {
                FIB: { wins: fibPerf.wins, losses: fibPerf.losses, trades: fibPerf.trades, winRate: fibPerf.trades > 0 ? Math.round(fibPerf.wins / fibPerf.trades * 100) : 0 },
                BREAKOUT: { wins: breakoutPerf.wins, losses: breakoutPerf.losses, trades: breakoutPerf.trades, winRate: breakoutPerf.trades > 0 ? Math.round(breakoutPerf.wins / breakoutPerf.trades * 100) : 0 }
            }
        };
    },

    getCurrentConfig() {
        return this._getModeConfig();
    },

    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using QUALITY (2) instead.`);
            this.QUALITY_MODE = 2;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName}`);
        console.log(`   Min Score: ${config.minScore} | Min Momentum: ${config.minMomentum}`);
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
        console.log(`[Jump75] 🧠 Learning data reset`);
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