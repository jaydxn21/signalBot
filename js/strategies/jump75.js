/**
 * Jump75Strategy v21 - Support Bounce Edition
 * 
 * Replaces Fibonacci retracement with H4 swing low support + M5 reversal confirmation.
 * Detects real support levels where price bounces, not mathematical retracement levels.
 * 
 * Pattern Recognition:
 * 1. H4 forms swing low support (dotted line on your chart)
 * 2. Price trends DOWN toward support
 * 3. M5 reversal candle forms (green candle closes above support)
 * 4. ENTRY: Buy when reversal confirmed
 * 5. TP: 2x the distance from support to entry
 * 6. SL: Below support by ATR buffer
 */

import { SupportBounceDetector } from './support-bounce-detector.js';

class Jump75StrategyV21 {
    constructor() {
        this.detector = new SupportBounceDetector();
        this.qualityMode = 1; // 0=Quantity, 1=Balanced, 2=Quality, 3=Ultra
        
        // Quality mode configs
        this.qualityModes = {
            0: { 
                name: 'QUANTITY', 
                displayName: 'QUANTITY (High Frequency)',
                minScore: 55, 
                cooldownMs: 60000,
                minMomentum: 0.10,
                minRangeATR: 2.5,
                nearFibATR: 1.5,
                riskPercent: 0.5,
                requireTrend: false,
                requireVolume: false
            },
            1: { 
                name: 'BALANCED', 
                displayName: 'BALANCED (Recommended)',
                minScore: 65, 
                cooldownMs: 120000,
                minMomentum: 0.20,
                minRangeATR: 3.0,
                nearFibATR: 1.2,
                riskPercent: 0.75,
                requireTrend: false,
                requireVolume: false
            },
            2: { 
                name: 'QUALITY', 
                displayName: 'QUALITY (Selective)',
                minScore: 75, 
                cooldownMs: 180000,
                minMomentum: 0.30,
                minRangeATR: 3.5,
                nearFibATR: 1.0,
                riskPercent: 0.7,
                requireTrend: true,
                requireVolume: false
            },
            3: { 
                name: 'ULTRA', 
                displayName: 'ULTRA (Very Selective)',
                minScore: 85, 
                cooldownMs: 300000,
                minMomentum: 0.40,
                minRangeATR: 4.0,
                nearFibATR: 0.8,
                riskPercent: 0.6,
                requireTrend: true,
                requireVolume: false
            }
        };

        // Performance tracking for adaptive weighting
        this.performance = {
            supportBounce: { wins: 0, losses: 0, trades: 0, totalPnL: 0 },
            resistanceBreakdown: { wins: 0, losses: 0, trades: 0, totalPnL: 0 }
        };

        this.lastSignalTime = 0;
        this._tradesCount = 0;
        this._dailyProfit = 0;
        this._consecutiveLosses = 0;
    }

    /**
     * Get all modes configuration (for UI)
     */
    getAllModes() {
        return this.qualityModes;
    }

    /**
     * Get current mode configuration
     */
    getCurrentConfig() {
        return this.qualityModes[this.qualityMode];
    }

    /**
     * Set quality mode (0-3)
     */
    setMode(mode) {
        if (mode >= 0 && mode <= 3) {
            this.qualityMode = mode;
            const config = this.getCurrentConfig();
            console.log(`[Jump75] Quality mode set to: ${mode} (${config.displayName})`);
            console.log(`   Min Score: ${config.minScore} | Min Momentum: ${config.minMomentum}`);
            return true;
        }
        return false;
    }

    /**
     * Main entry detection
     * Checks for support bounces and resistance breakdowns
     */
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        // Basic validation
        if (!m5Candles || !m15Candles || !h4Candles) return null;
        if (m5Candles.length < 5 || m15Candles.length < 3 || h4Candles.length < 7) return null;
        if (!atr || atr === 0) return null;

        const now = Date.now();
        const currentPrice = m5Candles[m5Candles.length - 1].close;

        // Check quality mode cooldown
        const config = this.getCurrentConfig();
        if ((now - this.lastSignalTime) < config.cooldownMs) {
            return null;
        }

        // Get signal from support bounce detector
        const signal = this.detector.checkEntry(
            m5Candles,
            h4Candles,
            currentPrice,
            atr,
            'jump75'
        );

        if (!signal) return null;

        // Apply quality mode filter
        if (signal.score < config.minScore) {
            return null; // Score too low for this quality mode
        }

        // ───────────────────────────────────────────────────────
        // ADDITIONAL CONFIRMATION: M15 Trend Alignment
        // ───────────────────────────────────────────────────────
        const m15Trend = this._getM15Trend(m15Candles);
        
        if (signal.type === 'BUY') {
            if (config.requireTrend && m15Trend === 'DOWNTREND') {
                return null; // Strong M15 downtrend = unfavorable
            }
            signal.m15Trend = m15Trend;
            signal.factors.push(`M15 trend: ${m15Trend}`);
        } else if (signal.type === 'SELL') {
            if (config.requireTrend && m15Trend === 'UPTREND') {
                return null; // Strong M15 uptrend = unfavorable
            }
            signal.m15Trend = m15Trend;
            signal.factors.push(`M15 trend: ${m15Trend}`);
        }

        // ───────────────────────────────────────────────────────
        // APPLY QUALITY MODE FILTERS
        // ───────────────────────────────────────────────────────
        
        // ULTRA mode (3): Only strongest setups
        if (this.qualityMode === 3) {
            if (signal.testCount < 3) return null;
            const lastCandle = m5Candles[m5Candles.length - 1];
            const bodyRatio = Math.abs(lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low);
            if (bodyRatio < 0.6) return null;
            signal.factors.push('✓ Ultra mode: Confirmed support + strong reversal');
        }

        // QUALITY mode (2): Good setups only
        if (this.qualityMode === 2) {
            if (signal.testCount < 2) return null;
            signal.factors.push('✓ Quality mode: Multi-tested support');
        }

        // BALANCED mode (1): Standard filters
        if (this.qualityMode === 1) {
            if (signal.testCount < 1) return null;
            signal.factors.push('✓ Balanced mode: Support identified');
        }

        // Update last signal time
        this.lastSignalTime = now;
        this._tradesCount++;

        // Add metadata
        signal.qualityMode = this.qualityMode;
        signal.mode = config.displayName;
        signal.tpMultiplier = 2.0;
        signal.slMultiplier = 0.8;
        signal.riskPercent = config.riskPercent;
        
        console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
        
        return signal;
    }

    /**
     * Determine M15 trend (UPTREND / NEUTRAL / DOWNTREND)
     */
    _getM15Trend(m15Candles) {
        if (!m15Candles || m15Candles.length < 5) return 'NEUTRAL';

        const slice = m15Candles.slice(-5);
        let upCount = 0, downCount = 0;

        for (let i = 1; i < slice.length; i++) {
            if (slice[i].close > slice[i - 1].close) upCount++;
            if (slice[i].close < slice[i - 1].close) downCount++;
        }

        if (upCount >= 4) return 'UPTREND';
        if (downCount >= 4) return 'DOWNTREND';
        return 'NEUTRAL';
    }

    /**
     * Handle trade closure for learning
     */
    recordTrade(outcome, pnl, direction) {
        const key = direction === 'BUY' ? 'supportBounce' : 'resistanceBreakdown';
        
        this.performance[key].trades++;
        this.performance[key].totalPnL += pnl;
        
        if (outcome === 'TP' || pnl > 0) {
            this.performance[key].wins++;
            this._consecutiveLosses = 0;
        } else {
            this.performance[key].losses++;
            this._consecutiveLosses++;
        }
        
        this._dailyProfit += pnl;

        this.detector.recordTrade('jump75', outcome, pnl);
    }

    /**
     * Check if signal should be closed (advanced exit logic)
     */
    checkClose(m5Candle, openSignal) {
        if (!openSignal || !m5Candle) return null;

        const { entry, sl, tp, type } = openSignal;

        // Standard TP/SL checks
        if (type === 'BUY') {
            if (m5Candle.high >= tp) {
                this.recordTrade('TP', tp - entry, 'BUY');
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (m5Candle.low <= sl) {
                this.recordTrade('SL', entry - sl, 'BUY');
                return { action: 'CLOSE', reason: 'SL' };
            }
            
            // Trail stop after 1R profit
            const profit = m5Candle.close - entry;
            const riskDistance = entry - sl;
            if (profit >= riskDistance) {
                const newSL = entry - (riskDistance * 0.1);
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        } else {
            // SELL
            if (m5Candle.low <= tp) {
                this.recordTrade('TP', entry - tp, 'SELL');
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (m5Candle.high >= sl) {
                this.recordTrade('SL', sl - entry, 'SELL');
                return { action: 'CLOSE', reason: 'SL' };
            }
            
            // Trail stop after 1R profit
            const profit = entry - m5Candle.close;
            const riskDistance = sl - entry;
            if (profit >= riskDistance) {
                const newSL = entry + (riskDistance * 0.1);
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        }

        return null;
    }

    /**
     * Get stats for UI
     */
    getStats() {
        const config = this.getCurrentConfig();
        return {
            mode: config.name,
            displayName: config.displayName,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            dailyProfit: this._dailyProfit,
            winRate: this.performance.supportBounce.trades + this.performance.resistanceBreakdown.trades > 0
                ? ((this.performance.supportBounce.wins + this.performance.resistanceBreakdown.wins) / 
                   (this.performance.supportBounce.trades + this.performance.resistanceBreakdown.trades) * 100).toFixed(1)
                : 0
        };
    }

    /**
     * Get session summary
     */
    getSessionSummary() {
        return {
            supportBounce: {
                ...this.performance.supportBounce,
                winRate: this.performance.supportBounce.trades > 0 
                    ? (this.performance.supportBounce.wins / this.performance.supportBounce.trades * 100).toFixed(1) + '%'
                    : '0%'
            },
            resistanceBreakdown: {
                ...this.performance.resistanceBreakdown,
                winRate: this.performance.resistanceBreakdown.trades > 0
                    ? (this.performance.resistanceBreakdown.wins / this.performance.resistanceBreakdown.trades * 100).toFixed(1) + '%'
                    : '0%'
            },
            qualityMode: this.getCurrentConfig().displayName
        };
    }

    /**
     * Reset for new session
     */
    reset() {
        this.performance = {
            supportBounce: { wins: 0, losses: 0, trades: 0, totalPnL: 0 },
            resistanceBreakdown: { wins: 0, losses: 0, trades: 0, totalPnL: 0 }
        };
        this.lastSignalTime = 0;
        this._tradesCount = 0;
        this._dailyProfit = 0;
        this._consecutiveLosses = 0;
        this.detector.resetSession('jump75');
    }
}

// Create singleton
const Jump75Strategy = new Jump75StrategyV21();

export { Jump75Strategy, Jump75StrategyV21 };