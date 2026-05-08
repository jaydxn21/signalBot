/**
 * SupportBounceDetector v1.0
 * 
 * Detects H4 swing low support levels and confirms reversals on M5.
 * Replaces Fibonacci retracement with real support/resistance trading.
 * 
 * Pattern: Downtrend → Price tests support → M5 reversal candle → BUY/SELL
 * 
 * Usage:
 * const detector = new SupportBounceDetector();
 * const signal = detector.checkEntry(m5Candles, h4Candles, currentPrice, atr);
 */

class SupportBounceDetector {
    constructor() {
        this.minSwingSize = 50;     // Minimum points between swing high/low
        this.testThreshold = 3;     // Number of times a level should be tested to be "confirmed"
        this.sessionState = {};     // Track state per bot/session
    }

    /**
     * Find H4 swing LOW levels (potential support)
     * Looks for local minima in H4 candles
     */
    findSupportLevels(h4Candles, lookback = 14) {
        if (!h4Candles || h4Candles.length < 7) return [];

        const supports = [];
        const slice = h4Candles.slice(-lookback);

        // Find local minima (swing lows)
        for (let i = 1; i < slice.length - 1; i++) {
            const prev = slice[i - 1];
            const curr = slice[i];
            const next = slice[i + 1];

            // Local minimum: current low < previous low AND current low < next low
            const isSwingLow = curr.low < prev.low && curr.low < next.low;

            if (isSwingLow) {
                const support = {
                    level: curr.low,
                    time: curr.time,
                    barIndex: i,
                    testCount: 1  // How many times this level was tested
                };

                // Check if this level is already in our list (consolidation area)
                const existing = supports.find(s => 
                    Math.abs(s.level - support.level) < this.minSwingSize
                );

                if (existing) {
                    existing.testCount++;
                    existing.time = curr.time; // Update to most recent test
                } else {
                    supports.push(support);
                }
            }
        }

        // Sort by level (descending) — closest support first
        return supports.sort((a, b) => b.level - a.level);
    }

    /**
     * Find H4 swing HIGH levels (potential resistance)
     * Looks for local maxima in H4 candles
     */
    findResistanceLevels(h4Candles, lookback = 14) {
        if (!h4Candles || h4Candles.length < 7) return [];

        const resistances = [];
        const slice = h4Candles.slice(-lookback);

        // Find local maxima (swing highs)
        for (let i = 1; i < slice.length - 1; i++) {
            const prev = slice[i - 1];
            const curr = slice[i];
            const next = slice[i + 1];

            // Local maximum: current high > previous high AND current high > next high
            const isSwingHigh = curr.high > prev.high && curr.high > next.high;

            if (isSwingHigh) {
                const resistance = {
                    level: curr.high,
                    time: curr.time,
                    barIndex: i,
                    testCount: 1
                };

                // Check for consolidation
                const existing = resistances.find(r => 
                    Math.abs(r.level - resistance.level) < this.minSwingSize
                );

                if (existing) {
                    existing.testCount++;
                    existing.time = curr.time;
                } else {
                    resistances.push(resistance);
                }
            }
        }

        // Sort by level (ascending) — closest resistance first
        return resistances.sort((a, b) => a.level - b.level);
    }

    /**
     * Detect if price is in a DOWNTREND on M5
     * Downtrend = making lower lows consistently
     */
    isInDowntrend(m5Candles, lookback = 5) {
        if (!m5Candles || m5Candles.length < lookback + 1) return false;

        const slice = m5Candles.slice(-lookback);
        
        // Check if each bar's low is lower than or equal to previous
        let lowerLows = true;
        for (let i = 1; i < slice.length; i++) {
            if (slice[i].low > slice[i - 1].low) {
                lowerLows = false;
                break;
            }
        }

        return lowerLows;
    }

    /**
     * Detect if price is in an UPTREND on M5
     * Uptrend = making higher highs consistently
     */
    isInUptrend(m5Candles, lookback = 5) {
        if (!m5Candles || m5Candles.length < lookback + 1) return false;

        const slice = m5Candles.slice(-lookback);
        
        // Check if each bar's high is higher than or equal to previous
        let higherHighs = true;
        for (let i = 1; i < slice.length; i++) {
            if (slice[i].high < slice[i - 1].high) {
                higherHighs = false;
                break;
            }
        }

        return higherHighs;
    }

    /**
     * Detect BOUNCE SIGNAL (support tested + reversal candle)
     * Returns true if: previous candle tested support, current candle reversed UP
     */
    isBounceSignal(m5Candles, supportLevel, tolerance = 150) {
        if (!m5Candles || m5Candles.length < 2) return false;

        const lastCandle = m5Candles[m5Candles.length - 1];
        const prevCandle = m5Candles[m5Candles.length - 2];

        // 1. Previous candle tested support (low near support level)
        const testedSupport = prevCandle.low <= (supportLevel + tolerance) &&
                             prevCandle.low >= (supportLevel - tolerance);

        // 2. Current candle is bullish (close > open)
        const reversalCandle = lastCandle.close > lastCandle.open;

        // 3. Current candle closed above support
        const closedAbove = lastCandle.close > supportLevel;

        // 4. Body size is reasonable (not a tiny doji)
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const hasBody = bodySize > (tolerance * 0.1);

        return testedSupport && reversalCandle && closedAbove && hasBody;
    }

    /**
     * Detect BREAKDOWN SIGNAL (resistance tested + reversal candle)
     * Returns true if: previous candle tested resistance, current candle reversed DOWN
     */
    isBreakdownSignal(m5Candles, resistanceLevel, tolerance = 150) {
        if (!m5Candles || m5Candles.length < 2) return false;

        const lastCandle = m5Candles[m5Candles.length - 1];
        const prevCandle = m5Candles[m5Candles.length - 2];

        // 1. Previous candle tested resistance (high near resistance level)
        const testedResistance = prevCandle.high <= (resistanceLevel + tolerance) &&
                                prevCandle.high >= (resistanceLevel - tolerance);

        // 2. Current candle is bearish (close < open)
        const reversalCandle = lastCandle.close < lastCandle.open;

        // 3. Current candle closed below resistance
        const closedBelow = lastCandle.close < resistanceLevel;

        // 4. Body size is reasonable
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const hasBody = bodySize > (tolerance * 0.1);

        return testedResistance && reversalCandle && closedBelow && hasBody;
    }

    /**
     * Calculate intelligent TP/SL based on support level
     * TP = 2x the distance from support to entry (your pattern)
     * SL = Below support by a buffer (0.5-1x ATR)
     */
    calculateTPSL(entryPrice, supportLevel, resistanceLevel, atr, direction) {
        if (direction === 'BUY') {
            // Distance from support to entry
            const distance = entryPrice - supportLevel;

            // TP: 2x the bounce distance
            const tp = entryPrice + (distance * 2.0);

            // SL: Below support by ATR buffer
            const sl = supportLevel - (atr * 0.5);

            return { tp, sl, distance };
        } else {
            // SELL
            const distance = resistanceLevel - entryPrice;

            // TP: 2x the breakdown distance
            const tp = entryPrice - (distance * 2.0);

            // SL: Above resistance by ATR buffer
            const sl = resistanceLevel + (atr * 0.5);

            return { tp, sl, distance };
        }
    }

    /**
     * Main entry detection
     * Looks for support bounces OR resistance breakdowns
     */
    checkEntry(m5Candles, h4Candles, currentPrice, atr, botId = 'default') {
        if (!m5Candles || !h4Candles || m5Candles.length < 5 || h4Candles.length < 7) {
            return null;
        }

        // Initialize session state for this bot
        if (!this.sessionState[botId]) {
            this.sessionState[botId] = {
                lastSignalTime: 0,
                lastSignalType: null,
                consecutiveWins: 0,
                consecutiveLosses: 0,
                totalTrades: 0
            };
        }

        const state = this.sessionState[botId];

        // Get support and resistance levels
        const supports = this.findSupportLevels(h4Candles, 14);
        const resistances = this.findResistanceLevels(h4Candles, 14);

        if (supports.length === 0 && resistances.length === 0) {
            return null;
        }

        // ─────────────────────────────────────────────────────────
        // LONG SIGNAL: Downtrend + Support Bounce
        // ─────────────────────────────────────────────────────────
        if (this.isInDowntrend(m5Candles)) {
            // Find nearest support below current price
            const activeSupport = supports.find(s => s.level < currentPrice);

            if (activeSupport && this.isBounceSignal(m5Candles, activeSupport.level, atr)) {
                const { tp, sl, distance } = this.calculateTPSL(
                    currentPrice, 
                    activeSupport.level, 
                    null, 
                    atr, 
                    'BUY'
                );

                // Score based on support confirmation level
                let score = 70;
                if (activeSupport.testCount >= this.testThreshold) score += 10; // Confirmed support
                if (distance > atr * 2) score += 5; // Good bounce distance
                if (m5Candles.length > 20) score += 5; // Enough history

                return {
                    type: 'BUY',
                    direction: 'LONG',
                    entry: currentPrice,
                    sl: sl,
                    tp: tp,
                    supportLevel: activeSupport.level,
                    distance: distance,
                    testCount: activeSupport.testCount,
                    tpMultiplier: 2.0,
                    slMultiplier: 0.5,
                    score: Math.min(score, 95),
                    factors: [
                        `Support bounce at ${activeSupport.level.toFixed(2)}`,
                        `Downtrend confirmed (5-bar lower lows)`,
                        `Reversal candle formed (close > open)`,
                        `Support tested ${activeSupport.testCount}x`,
                        `R:R = ${((tp - currentPrice) / (currentPrice - sl)).toFixed(2)}:1`
                    ],
                    isSupportBounce: true
                };
            }
        }

        // ─────────────────────────────────────────────────────────
        // SHORT SIGNAL: Uptrend + Resistance Breakdown
        // ─────────────────────────────────────────────────────────
        if (this.isInUptrend(m5Candles)) {
            // Find nearest resistance above current price
            const activeResistance = resistances.find(r => r.level > currentPrice);

            if (activeResistance && this.isBreakdownSignal(m5Candles, activeResistance.level, atr)) {
                const { tp, sl, distance } = this.calculateTPSL(
                    currentPrice, 
                    null, 
                    activeResistance.level, 
                    atr, 
                    'SELL'
                );

                // Score based on resistance confirmation level
                let score = 70;
                if (activeResistance.testCount >= this.testThreshold) score += 10; // Confirmed resistance
                if (distance > atr * 2) score += 5; // Good breakdown distance
                if (m5Candles.length > 20) score += 5; // Enough history

                return {
                    type: 'SELL',
                    direction: 'SHORT',
                    entry: currentPrice,
                    sl: sl,
                    tp: tp,
                    resistanceLevel: activeResistance.level,
                    distance: distance,
                    testCount: activeResistance.testCount,
                    tpMultiplier: 2.0,
                    slMultiplier: 0.5,
                    score: Math.min(score, 95),
                    factors: [
                        `Resistance breakdown at ${activeResistance.level.toFixed(2)}`,
                        `Uptrend confirmed (5-bar higher highs)`,
                        `Reversal candle formed (close < open)`,
                        `Resistance tested ${activeResistance.testCount}x`,
                        `R:R = ${(Math.abs(tp - currentPrice) / Math.abs(currentPrice - sl)).toFixed(2)}:1`
                    ],
                    isResistanceBreakdown: true
                };
            }
        }

        return null;
    }

    /**
     * Track trade outcomes for learning
     */
    recordTrade(botId, outcome, pnl) {
        if (!this.sessionState[botId]) return;

        const state = this.sessionState[botId];
        state.totalTrades++;

        if (outcome === 'TP' || pnl > 0) {
            state.consecutiveWins++;
            state.consecutiveLosses = 0;
        } else {
            state.consecutiveLosses++;
            state.consecutiveWins = 0;
        }
    }

    /**
     * Get session summary for logging
     */
    getSessionSummary(botId = 'default') {
        return this.sessionState[botId] || null;
    }

    /**
     * Reset session (new trading day)
     */
    resetSession(botId = 'default') {
        this.sessionState[botId] = {
            lastSignalTime: 0,
            lastSignalType: null,
            consecutiveWins: 0,
            consecutiveLosses: 0,
            totalTrades: 0
        };
    }
}

// Export for use in signal-bot.js
export { SupportBounceDetector };