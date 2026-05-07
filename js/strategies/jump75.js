// js/strategies/jump75.js - v22: REALISTIC FILTERS FOR JUMP INDICES

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _h4SwingHigh: null,
    _h4SwingLow: null,
    _tradesCount: 0,

    // ═══ QUALITY MODE SELECTOR ═══
    // 0=QUANTITY, 1=BALANCED (DEFAULT), 2=QUALITY, 3=ULTRA
    QUALITY_MODE: 1,  // START WITH BALANCED - WILL GENERATE SIGNALS

    // ───────────────────────────────────────────────────────────────
    // REALISTIC MODE CONFIGURATIONS FOR JUMP INDICES
    // ───────────────────────────────────────────────────────────────
    _getModeConfig() {
        const modes = {
            // QUANTITY: Maximum trades (50-80/day)
            0: {
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                minCandlesM5: 25,
                minCandlesM15: 15,
                minCandlesH4: 5,
                cooldownMs: 30000,          // 30 seconds
                lossCooldownMs: 120000,     // 2 minutes
                minRangeATR: 2.5,
                nearFibATR: 1.5,            // Wide zone
                minMomentum: 0.10,
                minScore: 50,
                requireTrend: false,
                requireVolume: false,
                tpMultipliers: { high: 1.5, medium: 1.3, low: 1.2, min: 1.1 },
                slMultipliers: { high: 0.8, medium: 0.8, low: 0.7, min: 0.7 },
                lotMultiplier: 0.8,
                riskPercent: 0.5
            },
            // BALANCED: Good balance (25-40 trades/day) - DEFAULT
            1: {
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                minCandlesM5: 35,
                minCandlesM15: 20,
                minCandlesH4: 6,
                cooldownMs: 60000,          // 1 minute
                lossCooldownMs: 300000,     // 5 minutes
                minRangeATR: 3.0,
                nearFibATR: 1.2,            // Moderate zone
                minMomentum: 0.20,
                minScore: 60,
                requireTrend: false,        // Don't require trend - markets range often
                requireVolume: false,
                tpMultipliers: { high: 2.0, medium: 1.8, low: 1.6, min: 1.4 },
                slMultipliers: { high: 0.9, medium: 0.9, low: 0.8, min: 0.8 },
                lotMultiplier: 1.0,
                riskPercent: 0.75
            },
            // QUALITY: Selective but still trades (10-20 trades/day)
            2: {
                name: 'QUALITY',
                displayName: 'QUALITY (Selective)',
                minCandlesM5: 45,
                minCandlesM15: 25,
                minCandlesH4: 8,
                cooldownMs: 120000,         // 2 minutes
                lossCooldownMs: 600000,     // 10 minutes
                minRangeATR: 3.5,
                nearFibATR: 1.0,            // Tighter but achievable
                minMomentum: 0.30,
                minScore: 70,
                requireTrend: false,        // REMOVED - was blocking trades
                requireVolume: false,       // REMOVED - Jump volume unreliable
                tpMultipliers: { high: 2.3, medium: 2.0, low: 1.8, min: 1.6 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 0.9, min: 0.9 },
                lotMultiplier: 0.9,
                riskPercent: 0.7
            },
            // ULTRA: Very selective (3-8 trades/day)
            3: {
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                minCandlesM5: 55,
                minCandlesM15: 30,
                minCandlesH4: 10,
                cooldownMs: 180000,         // 3 minutes
                lossCooldownMs: 900000,     // 15 minutes
                minRangeATR: 4.0,
                nearFibATR: 0.8,            // Tight zone
                minMomentum: 0.40,
                minScore: 80,
                requireTrend: false,        // REMOVED
                requireVolume: false,       // REMOVED
                tpMultipliers: { high: 2.5, medium: 2.2, low: 2.0, min: 1.8 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 1.0 },
                lotMultiplier: 0.7,
                riskPercent: 0.6
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },

    // ───────────────────────────────────────────────────────────────
    // SIMPLIFIED SIGNAL DETECTION (WORKS FOR JUMP INDICES)
    // ───────────────────────────────────────────────────────────────
    _getSignal(m5Candles, m15Candles, h4Candles, atr, config) {
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;
        
        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        // Calculate range
        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * config.minRangeATR) return null;
        
        // Fibonacci levels
        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);
        
        // Use wider zones for better hit rate
        const atrZone = atr * config.nearFibATR;
        const near618 = Math.abs(latestM15.close - fib.fib618) < atrZone;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atrZone;
        
        // Momentum calculation
        const m5Momentum = this._getM5Momentum(m5Candles);
        const m15Trend = this._getM15Trend(m15Candles);
        
        const bullishCandle = latestM5.close > prevM5.open;
        const bearishCandle = latestM5.close < prevM5.open;
        const aboveLow = latestM15.close > this._h4SwingLow;
        const belowHigh = latestM15.close < this._h4SwingHigh;
        
        let signal = null;
        let score = 0;
        
        // Check for LONG signal
        if (m5Momentum > config.minMomentum && bullishCandle && aboveLow) {
            score = config.minScore;
            
            // Bonus for Fib level
            if (near618) score += 15;
            else if (near50) score += 8;
            
            // Bonus for trend alignment (optional, not required)
            if (m15Trend === 'UP') score += 10;
            
            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : 'Support');
                signal = {
                    type: 'LONG',
                    score: Math.min(score, 95),
                    factors: [`📈 ${zone} bounce`, 'Momentum', m15Trend === 'UP' ? 'Trend up' : 'Structure'],
                    mode: 'FIB'
                };
            }
        }
        
        // Check for SHORT signal
        if (!signal && m5Momentum < -config.minMomentum && bearishCandle && belowHigh) {
            score = config.minScore;
            
            if (near618) score += 15;
            else if (near50) score += 8;
            
            if (m15Trend === 'DOWN') score += 10;
            
            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : 'Resistance');
                signal = {
                    type: 'SHORT',
                    score: Math.min(score, 95),
                    factors: [`📉 ${zone} rejection`, 'Momentum', m15Trend === 'DOWN' ? 'Trend down' : 'Structure'],
                    mode: 'FIB'
                };
            }
        }
        
        return signal;
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
            console.log(`[Jump75] New session started`);
        }
    },

    recordTrade(outcome, pnl, mode = null) {
        this._tradesCount++;
        this._dailyProfit += pnl;
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
        
        // Minimum candles check
        if (!m5Candles || m5Candles.length < config.minCandlesM5 || 
            !m15Candles || m15Candles.length < config.minCandlesM15 || 
            !h4Candles || h4Candles.length < config.minCandlesH4) {
            return null;
        }
        
        // Cooldown check
        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.lossCooldownMs) return null;
        
        // Update H4 structure
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;
        
        // Get signal
        const signal = this._getSignal(m5Candles, m15Candles, h4Candles, atr, config);
        if (!signal) return null;
        
        this._lastTradeTime = now;
        console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
        
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
        if (m15Candles.length < 15) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        if (latest.close > ema8 && ema8 > ema21) return 'UP';
        if (latest.close < ema8 && ema8 < ema21) return 'DOWN';
        return 'NEUTRAL';
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 10) return;
        const recent = h4Candles.slice(-12);
        this._h4SwingHigh = Math.max(...recent.map(c => c.high));
        this._h4SwingLow = Math.min(...recent.map(c => c.low));
    },

    _calculateFibLevels(low, high) {
        const diff = high - low;
        return { fib50: high - diff * 0.5, fib618: high - diff * 0.618 };
    },

    _getM5Momentum(m5Candles) {
        if (m5Candles.length < 10) return 0;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return 0;
        const atr = this._calculateATR(m5Candles, 14);
        if (atr === 0) return (ema8 - ema21) / 20;
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
            this.recordTrade(outcome, pnl);
        }
        
        return closeAction;
    },

    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            displayName: config.displayName,
            dailyProfit: this._dailyProfit,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0
        };
    },

    getCurrentConfig() {
        return this._getModeConfig();
    },

    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using BALANCED (1) instead.`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName}`);
        console.log(`   Min Score: ${config.minScore} | Min Momentum: ${config.minMomentum}`);
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