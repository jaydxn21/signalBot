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
            0: { minScore: 55, cooldownMs: 60000 },
            1: { minScore: 65, cooldownMs: 120000 },
            2: { minScore: 75, cooldownMs: 180000 },
            3: { minScore: 85, cooldownMs: 300000 }
        };

        // Performance tracking for adaptive weighting
        this.performance = {
            supportBounce: { wins: 0, losses: 0, trades: 0 },
            resistanceBreakdown: { wins: 0, losses: 0, trades: 0 }
        };

        this.lastSignalTime = 0;
    }

    /**
     * Set quality mode (0-3)
     */
    setMode(mode) {
        if (mode >= 0 && mode <= 3) {
            this.qualityMode = mode;
            console.log(`[Jump75] Quality mode set to: ${mode} (${['Quantity', 'Balanced', 'Quality', 'Ultra'][mode]})`);
        }
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
        const config = this.qualityModes[this.qualityMode];
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
            // For LONG: Prefer M15 uptrend or neutral, avoid strong downtrend
            if (m15Trend === 'DOWNTREND') {
                return null; // Strong M15 downtrend = unfavorable
            }
            signal.m15Trend = m15Trend;
            signal.factors.push(`M15 trend: ${m15Trend}`);
        } else if (signal.type === 'SELL') {
            // For SHORT: Prefer M15 downtrend or neutral, avoid strong uptrend
            if (m15Trend === 'UPTREND') {
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
            // Must be a very confirmed level (3+ tests)
            if (signal.testCount < 3) return null;
            
            // Must have strong reversal candle
            const lastCandle = m5Candles[m5Candles.length - 1];
            const bodyRatio = Math.abs(lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low);
            if (bodyRatio < 0.6) return null; // Weak body = reject
            
            signal.factors.push('✓ Ultra mode: Confirmed support + strong reversal');
        }

        // QUALITY mode (2): Good setups only
        if (this.qualityMode === 2) {
            // Prefer confirmed support levels
            if (signal.testCount < 2) return null;
            
            signal.factors.push('✓ Quality mode: Multi-tested support');
        }

        // BALANCED mode (1): Standard filters
        if (this.qualityMode === 1) {
            // At least one test of the level
            if (signal.testCount < 1) return null;
            
            signal.factors.push('✓ Balanced mode: Support identified');
        }

        // Update last signal time
        this.lastSignalTime = now;

        // Add metadata
        signal.qualityMode = this.qualityMode;
        signal.mode = ['Quantity', 'Balanced', 'Quality', 'Ultra'][this.qualityMode];
        
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
        if (outcome === 'TP' || pnl > 0) {
            this.performance[key].wins++;
        } else {
            this.performance[key].losses++;
        }

        this.detector.recordTrade('jump75', outcome, pnl);
    }

    /**
     * Check if signal should be closed (advanced exit logic)
     */
    checkClose(m5Candle, openSignal) {
        if (!openSignal || !m5Candle) return null;

        const { entry, sl, tp, type, supportLevel, resistanceLevel } = openSignal;

        // Standard TP/SL checks
        if (type === 'BUY') {
            if (m5Candle.high >= tp) return { action: 'CLOSE', reason: 'TP' };
            if (m5Candle.low <= sl) return { action: 'CLOSE', reason: 'SL' };
            
            // New SL: Move to breakeven + 0.1 ATR after 1R profit
            const profit = m5Candle.close - entry;
            const riskDistance = entry - sl;
            if (profit >= riskDistance) {
                const newSL = entry - (riskDistance * 0.1);
                if (m5Candle.low <= newSL) return { action: 'CLOSE', reason: 'SL (breakeven)' };
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        } else {
            // SELL
            if (m5Candle.low <= tp) return { action: 'CLOSE', reason: 'TP' };
            if (m5Candle.high >= sl) return { action: 'CLOSE', reason: 'SL' };
            
            // New SL: Move to breakeven + 0.1 ATR after 1R profit
            const profit = entry - m5Candle.close;
            const riskDistance = sl - entry;
            if (profit >= riskDistance) {
                const newSL = entry + (riskDistance * 0.1);
                if (m5Candle.high >= newSL) return { action: 'CLOSE', reason: 'SL (breakeven)' };
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        }

        return null;
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
            qualityMode: ['Quantity', 'Balanced', 'Quality', 'Ultra'][this.qualityMode]
        };
    }

    /**
     * Reset for new session
     */
    reset() {
        this.performance = {
            supportBounce: { wins: 0, losses: 0, trades: 0 },
            resistanceBreakdown: { wins: 0, losses: 0, trades: 0 }
        };
        this.lastSignalTime = 0;
        this.detector.resetSession('jump75');
    }
}

// Create singleton
const Jump75Strategy = new Jump75StrategyV21();

export { Jump75Strategy, Jump75StrategyV21 };