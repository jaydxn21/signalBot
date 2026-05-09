// js/strategies/jump75.js - v22: Support Bounce Detector Integration

import { SupportBounceDetector } from './support-bounce-detector.js';

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _tradesCount: 0,
    
    // Quality mode (0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA)
    QUALITY_MODE: 1,  // Start with BALANCED
    
    // Initialize support bounce detector
    _detector: null,
    
    _getDetector() {
        if (!this._detector) {
            this._detector = new SupportBounceDetector();
        }
        return this._detector;
    },
    
    // Quality mode configurations
    _getModeConfig() {
        const modes = {
            0: { // QUANTITY
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                minScore: 55,
                cooldownMs: 60000,
                minMomentum: 0.15,
                minTestCount: 1,
                riskPercent: 0.5,
                lotMultiplier: 0.8
            },
            1: { // BALANCED (DEFAULT)
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                minScore: 65,
                cooldownMs: 120000,
                minMomentum: 0.25,
                minTestCount: 1,
                riskPercent: 0.75,
                lotMultiplier: 1.0
            },
            2: { // QUALITY
                name: 'QUALITY',
                displayName: 'QUALITY (Conservative)',
                minScore: 75,
                cooldownMs: 180000,
                minMomentum: 0.35,
                minTestCount: 2,
                riskPercent: 0.7,
                lotMultiplier: 0.9
            },
            3: { // ULTRA
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                minScore: 85,
                cooldownMs: 300000,
                minMomentum: 0.45,
                minTestCount: 3,
                riskPercent: 0.6,
                lotMultiplier: 0.7
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    // Main entry check
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        const config = this._getModeConfig();
        const detector = this._getDetector();
        
        // Minimum candles check
        if (!m5Candles || m5Candles.length < 10 || 
            !h4Candles || h4Candles.length < 10) {
            return null;
        }
        
        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.cooldownMs * 2) return null;
        
        const currentPrice = m5Candles[m5Candles.length - 1].close;
        
        // Get signal from support bounce detector
        const signal = detector.checkEntry(m5Candles, h4Candles, currentPrice, atr, 'jump75');
        
        if (!signal) return null;
        
        // Apply quality mode filters
        if (signal.score < config.minScore) return null;
        if (signal.testCount < config.minTestCount) return null;
        
        // Add metadata
        signal.qualityMode = config.name;
        signal.tpMultiplier = 2.0;
        signal.slMultiplier = 0.8;
        signal.riskPercent = config.riskPercent;
        signal.lotMultiplier = config.lotMultiplier;
        signal.isJump75 = true;
        
        this._lastTradeTime = now;
        this._tradesCount++;
        
        console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
        
        return signal;
    },
    
    // Trade close check
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        let closeAction = null;
        let outcome = null;
        let pnl = 0;
        
        if (trade.type === 'BUY') {
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
            if (outcome === 'TP') {
                this._consecutiveLosses = 0;
            } else {
                this._consecutiveLosses++;
            }
            this._dailyProfit += pnl;
        }
        
        return closeAction;
    },
    
    // Record trade for learning
    recordTrade(outcome, pnl, direction) {
        const detector = this._getDetector();
        detector.recordTrade('jump75', outcome, pnl);
    },
    
    // Get stats
    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            displayName: config.displayName,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            dailyProfit: this._dailyProfit,
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0
        };
    },
    
    getCurrentConfig() {
        return this._getModeConfig();
    },
    
    getCurrentMode() {
        return this.QUALITY_MODE;
    },
    
    getAllModes() {
        return {
            0: this._getModeConfig.call({ QUALITY_MODE: 0 }),
            1: this._getModeConfig.call({ QUALITY_MODE: 1 }),
            2: this._getModeConfig.call({ QUALITY_MODE: 2 }),
            3: this._getModeConfig.call({ QUALITY_MODE: 3 })
        };
    },
    
    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using BALANCED (1).`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName}`);
        console.log(`   Min Score: ${config.minScore} | Min Test Count: ${config.minTestCount}`);
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
        if (this._detector) {
            this._detector.resetSession('jump75');
        }
    }
};

export default Jump75Strategy;