// js/strategies/breakout_trend.js
// ═══════════════════════════════════════════════════════════════════════
// Breakout-with-trend strategy - IMPROVED VERSION
// ═══════════════════════════════════════════════════════════════════════

export class BreakoutTrendStrategy {
    constructor(options = {}) {
        this.riskRewardRatio = options.riskRewardRatio || 2;
        this.allowRangingTrend = options.allowRangingTrend ?? false; // Changed to false by default
        this.minTouchesForLevel = options.minTouchesForLevel || 2;
        this.minBreakoutSize = options.minBreakoutSize || 0.3; // Minimum breakout size as % of range
        this.stopLossMultiplier = options.stopLossMultiplier || 1.2;
        this.useATRStop = options.useATRStop ?? true;
        this.confirmationCandles = options.confirmationCandles || 2; // Number of candles to confirm breakout (2 = require breakout to hold, filters single-bar fakeouts)
        this.requireTrendFilter = options.requireTrendFilter ?? true;
        this.emaShortPeriod = options.emaShortPeriod || 20;
        this.emaLongPeriod = options.emaLongPeriod || 50;
        this.minVolatilityFilter = options.minVolatilityFilter || 0.7;
        this.maxConsecutiveLosses = options.maxConsecutiveLosses || 3;
        this.consecutiveLosses = 0;
    }

    // Helper: Calculate EMA
    static calculateEMA(candles, period) {
        if (candles.length < period) return null;
        
        const prices = candles.map(c => c.close);
        const multiplier = 2 / (period + 1);
        let ema = prices[0];
        
        for (let i = 1; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }
        
        return ema;
    }

    // Helper: Calculate Average Range
    static calculateAverageRange(candles, period = 10) {
        if (candles.length < period) return 0;
        
        const ranges = candles.slice(-period).map(c => c.high - c.low);
        return ranges.reduce((a, b) => a + b, 0) / ranges.length;
    }

    // Helper: Calculate ATR
    static calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return null;
        
        let atr = 0;
        const trueRanges = [];
        
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            
            const tr1 = high - low;
            const tr2 = Math.abs(high - prevClose);
            const tr3 = Math.abs(low - prevClose);
            const tr = Math.max(tr1, tr2, tr3);
            
            trueRanges.push(tr);
        }
        
        // Simple moving average of true ranges
        const recentTR = trueRanges.slice(-period);
        atr = recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
        
        return atr;
    }

    // Helper: Detect Trend
    // atr (optional): scales the UP/DOWN threshold to the instrument's own
    // volatility. A fixed 0.5% EMA-gap threshold works for higher-volatility
    // instruments but is nearly unreachable on low-volatility ones (Vol10,
    // Vol25), which classified as RANGING on almost every bar and got every
    // breakout rejected by the trend filter. Expressing the threshold as a
    // multiple of ATR (relative to price) scales correctly across instruments.
    static detectTrend(candles, shortPeriod = 20, longPeriod = 50, atr = null) {
        if (candles.length < longPeriod) return 'NEUTRAL';
        
        const emaShort = this.calculateEMA(candles, shortPeriod);
        const emaLong = this.calculateEMA(candles, longPeriod);
        
        if (emaShort === null || emaLong === null) return 'NEUTRAL';
        
        const diff = emaShort - emaLong;
        const diffPercent = (diff / emaLong) * 100;

        // ATR-relative threshold: require the EMA gap to exceed roughly
        // 0.5 ATR (converted to a percentage of price) instead of a flat
        // 0.5%. Falls back to the fixed 0.5% if ATR is unavailable.
        const thresholdPercent = atr ? (atr * 0.5 / emaLong) * 100 : 0.5;

        if (diffPercent > thresholdPercent) return 'UP';
        if (diffPercent < -thresholdPercent) return 'DOWN';
        return 'RANGING';
    }

    // Helper: Count Consecutive Losses (needs to be tracked per symbol)
    static getConsecutiveLosses(symbol) {
        // This would need to be stored externally
        // For now, we'll use a static Map
        if (!this._lossTracker) {
            this._lossTracker = new Map();
        }
        return this._lossTracker.get(symbol) || 0;
    }

    static incrementConsecutiveLosses(symbol) {
        if (!this._lossTracker) {
            this._lossTracker = new Map();
        }
        const current = this._lossTracker.get(symbol) || 0;
        this._lossTracker.set(symbol, current + 1);
    }

    static resetConsecutiveLosses(symbol) {
        if (!this._lossTracker) {
            this._lossTracker = new Map();
        }
        this._lossTracker.set(symbol, 0);
    }

    // Main entry check method
    // options lets callers configure behavior since this is called statically
    // (no instance is created, so constructor options were previously ignored).
    static checkEntry(candles, atr, symbol, options = {}) {
        const confirmationCandles = options.confirmationCandles ?? 2;
        const minBreakoutSize     = options.minBreakoutSize     ?? 0.3;
        const stopLossMultiplier  = options.stopLossMultiplier  ?? 1.2;
        const useATRStop          = options.useATRStop          ?? true;
        const requireTrendFilter  = options.requireTrendFilter  ?? true;
        const minVolatilityFilter = options.minVolatilityFilter ?? 0.7;
        const maxConsecutiveLosses= options.maxConsecutiveLosses ?? 3;

        if (candles.length < 21) {
            console.log(`[${symbol}] Waiting for more candles (${candles.length}/21)`);
            return null;
        }

        // Check for consecutive losses
        const losses = this.getConsecutiveLosses(symbol);
        if (losses >= maxConsecutiveLosses) {
            console.log(`[${symbol}] ⚠️ PAUSING: ${losses} consecutive losses reached (max: ${maxConsecutiveLosses})`);
            return null;
        }

        // FIX: Exclude current candle from level calculation
        const recentCandles = candles.slice(-21, -1);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const high = Math.max(...highs);
        const low = Math.min(...lows);

        // STABLE LEVEL for 2-candle confirmation: excludes the last 2 candles
        // so the resistance/support being tested doesn't shift as the breakout
        // itself rolls into the rolling window (previously made 2-candle
        // confirmation almost impossible to satisfy — the level chased the price).
        const stableCandles = candles.slice(-22, -2);
        const stableHigh = stableCandles.length ? Math.max(...stableCandles.map(c => c.high)) : high;
        const stableLow  = stableCandles.length ? Math.min(...stableCandles.map(c => c.low))  : low;
        
        const currentCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        const secondPrevCandle = candles[candles.length - 3];
        
        if (!currentCandle || !prevCandle) return null;
        
        const close = currentCandle.close;
        const prevClose = prevCandle.close;
        const currentHigh = currentCandle.high;
        const currentLow = currentCandle.low;

        // Calculate range and volatility
        const range = high - low;
        if (range === 0) return null;
        
        const avgRange = this.calculateAverageRange(candles.slice(-10));
        const volatilityFilter = minVolatilityFilter;
        
        // Don't trade in low volatility
        if (range < avgRange * volatilityFilter) {
            console.log(`[${symbol}] 📊 Low volatility: range=${range.toFixed(5)}, avgRange=${avgRange.toFixed(5)}`);
            return null;
        }

        // Detect trend
        const trend = this.detectTrend(candles, 20, 50, atr);
        console.log(`[${symbol}] 📈 Trend: ${trend} | Range: ${low.toFixed(5)} - ${high.toFixed(5)} | Current: ${close.toFixed(5)}`);

        const resistance = high;
        const support = low;
        const stableResistance = stableHigh;
        const stableSupport    = stableLow;

        // Calculate breakout sizes
        const breakoutUpSize = close - resistance;
        const breakoutDownSize = support - close;
        // Scale the breakout-size threshold off ATR instead of the 20-bar
        // range. Range-based scaling made this threshold nearly impossible
        // to clear on low-volatility instruments (Vol10/Vol25), since their
        // entire 20-bar range is tiny — but ATR-based scaling reflects each
        // instrument's actual typical bar movement, so it scales correctly
        // across both fast and slow synthetic indices.
        const minSizeThreshold = atr ? atr * minBreakoutSize : range * minBreakoutSize;

        // --- BUY SIGNAL ---
        // Check breakout up with confirmation
        let isBreakoutUp = false;
        
        if (confirmationCandles === 1) {
            // Simple breakout: current candle breaks resistance
            isBreakoutUp = close > resistance && prevClose <= resistance;
        } else if (confirmationCandles === 2) {
            // Two-candle confirmation: use the STABLE level (calculated before
            // the breakout began) so the level doesn't shift as the breakout
            // candles themselves roll into the resistance window.
            isBreakoutUp = close > stableResistance && prevClose > stableResistance && secondPrevCandle && secondPrevCandle.close <= stableResistance;
        } else {
            // Default to simple breakout
            isBreakoutUp = close > resistance && prevClose <= resistance;
        }

        // Check if breakout is significant enough
        if (isBreakoutUp && breakoutUpSize < minSizeThreshold) {
            console.log(`[${symbol}] ⚠️ Breakout up too small: ${breakoutUpSize.toFixed(5)} < ${minSizeThreshold.toFixed(5)}`);
            isBreakoutUp = false;
        }

        // Apply trend filter
        if (isBreakoutUp && requireTrendFilter && trend !== 'UP') {
            console.log(`[${symbol}] 🚫 Breakout up rejected: Downtrend detected`);
            isBreakoutUp = false;
        }

        if (isBreakoutUp) {
            console.log(`[${symbol}] 🔥 BREAKOUT UP detected! Resistance: ${resistance.toFixed(5)} → Current: ${close.toFixed(5)}`);
            
            // Calculate stop loss distance
            let slDistance;
            if (useATRStop && atr) {
                slDistance = Math.max(range * 0.6, atr * 1.2);
            } else {
                slDistance = range * 0.6;
            }
            
            // Apply stop loss multiplier
            slDistance *= stopLossMultiplier;
            
            return {
                type: 'BUY',
                entry: close,
                sl: close - slDistance,
                tp: close + slDistance * 2,
                score: 80,
                label: 'Breakout Up (Trend Confirmed)',
                factors: [
                    `Resistance breakout at ${resistance.toFixed(5)}`,
                    `Trend: ${trend}`,
                    `Breakout size: ${(breakoutUpSize / range * 100).toFixed(1)}% of range`
                ],
                tpMultiplier: 2,
                slMultiplier: stopLossMultiplier,
                reason: `Resistance breakout above ${resistance.toFixed(5)} with ${trend} trend`,
                // Metadata for tracking
                _meta: {
                    trend: trend,
                    support: support,
                    resistance: resistance,
                    range: range,
                    breakoutSize: breakoutUpSize
                }
            };
        }

        // --- SELL SIGNAL ---
        // Check breakout down with confirmation
        let isBreakoutDown = false;
        
        if (confirmationCandles === 1) {
            isBreakoutDown = close < support && prevClose >= support;
        } else if (confirmationCandles === 2) {
            isBreakoutDown = close < stableSupport && prevClose < stableSupport && secondPrevCandle && secondPrevCandle.close >= stableSupport;
        } else {
            isBreakoutDown = close < support && prevClose >= support;
        }

        if (isBreakoutDown && breakoutDownSize < minSizeThreshold) {
            console.log(`[${symbol}] ⚠️ Breakout down too small: ${breakoutDownSize.toFixed(5)} < ${minSizeThreshold.toFixed(5)}`);
            isBreakoutDown = false;
        }

        if (isBreakoutDown && requireTrendFilter && trend !== 'DOWN') {
            console.log(`[${symbol}] 🚫 Breakout down rejected: Uptrend detected`);
            isBreakoutDown = false;
        }

        if (isBreakoutDown) {
            console.log(`[${symbol}] 🔥 BREAKOUT DOWN detected! Support: ${support.toFixed(5)} → Current: ${close.toFixed(5)}`);
            
            let slDistance;
            if (useATRStop && atr) {
                slDistance = Math.max(range * 0.6, atr * 1.2);
            } else {
                slDistance = range * 0.6;
            }
            
            slDistance *= stopLossMultiplier;
            
            return {
                type: 'SELL',
                entry: close,
                sl: close + slDistance,
                tp: close - slDistance * 2,
                score: 80,
                label: 'Breakout Down (Trend Confirmed)',
                factors: [
                    `Support breakdown at ${support.toFixed(5)}`,
                    `Trend: ${trend}`,
                    `Breakout size: ${(breakoutDownSize / range * 100).toFixed(1)}% of range`
                ],
                tpMultiplier: 2,
                slMultiplier: stopLossMultiplier,
                reason: `Support breakdown below ${support.toFixed(5)} with ${trend} trend`,
                _meta: {
                    trend: trend,
                    support: support,
                    resistance: resistance,
                    range: range,
                    breakoutSize: breakoutDownSize
                }
            };
        }

        // Log current position in range
        const upDistance = ((resistance - close) / range * 100);
        const downDistance = ((close - support) / range * 100);
        console.log(`[${symbol}] 📊 Position in range: ↑${upDistance.toFixed(1)}% to breakout | ↓${downDistance.toFixed(1)}% to breakdown`);

        return null;
    }

    // Original evaluate method for compatibility with analysis.js
    evaluate(structure) {
        const { trend, breaks, volatility, currentPrice } = structure;

        if (volatility.classification === 'low') {
            return null;
        }

        const confirmedBreaks = breaks.filter(b => b.state === 'confirmed_break');
        if (confirmedBreaks.length === 0) return null;

        for (const brk of confirmedBreaks) {
            const signal = this._evaluateBreak(brk, trend, currentPrice);
            if (signal) return signal;
        }

        return null;
    }

    _evaluateBreak(brk, trend, currentPrice) {
        // Enhanced trend filtering
        let trendAllows = false;
        
        if (brk.direction === 'up') {
            trendAllows = trend === 'UP' || (trend === 'RANGING' && this.allowRangingTrend);
        } else if (brk.direction === 'down') {
            trendAllows = trend === 'DOWN' || (trend === 'RANGING' && this.allowRangingTrend);
        }

        if (!trendAllows) return null;
        if (trend === 'RANGING' && !this.allowRangingTrend) return null;

        const side = brk.direction === 'up' ? 'buy' : 'sell';

        // Use ATR-based stops if available
        const buffer = Math.abs(currentPrice - brk.level) * 0.15;
        const stopLoss = brk.direction === 'up'
            ? brk.level - buffer
            : brk.level + buffer;

        const riskDistance = Math.abs(currentPrice - stopLoss);
        const takeProfit = brk.direction === 'up'
            ? currentPrice + riskDistance * this.riskRewardRatio
            : currentPrice - riskDistance * this.riskRewardRatio;

        return {
            side,
            entry: currentPrice,
            stopLoss,
            takeProfit,
            reason: `confirmed_break of ${brk.type} @ ${brk.level.toFixed(5)}, trend=${trend}`,
            level: brk.level,
            levelType: brk.type,
            confirmedAt: brk.confirmedAt
        };
    }

    // Method to reset loss counter (call this when a trade wins)
    resetLossCounter(symbol) {
        BreakoutTrendStrategy.resetConsecutiveLosses(symbol);
    }

    // Method to record trade outcome
    recordTradeOutcome(symbol, outcome) {
        if (outcome === 'win') {
            this.resetLossCounter(symbol);
        } else if (outcome === 'loss') {
            BreakoutTrendStrategy.incrementConsecutiveLosses(symbol);
        }
    }
}

// Default export for compatibility
export default BreakoutTrendStrategy;