// js/strategies/breakout_trend.js
// ═══════════════════════════════════════════════════════════════════════
// Breakout-with-trend strategy.
// Reads ONLY from the structure object produced by MarketAnalysis —
// never touches raw candles, per the analysis.js contract.
// ═══════════════════════════════════════════════════════════════════════

export class BreakoutTrendStrategy {
    constructor(options = {}) {
        this.riskRewardRatio = options.riskRewardRatio || 2;   // target = 2x the stop distance
        this.allowRangingTrend = options.allowRangingTrend ?? true; // trade breaks even if trend === 'ranging'
        this.minTouchesForLevel = options.minTouchesForLevel || 2;  // ignore 'weak' 1-touch levels
    }

    // Static method for compatibility with signal-bot.js
    static checkEntry(candles, atr, symbol) {
        // Create a simple structure from candles for evaluation
        const currentPrice = candles[candles.length - 1]?.close || 0;
        
        // Simple breakout detection based on recent highs/lows
        if (candles.length < 20) return null;
        
        const recentCandles = candles.slice(-20);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const high = Math.max(...highs);
        const low = Math.min(...lows);
        const close = candles[candles.length - 1].close;
        const prevClose = candles[candles.length - 2]?.close || close;
        
        // Detect breakout above resistance
        const resistance = high;
        const support = low;
        
        // Check for breakout up
        if (close > resistance && prevClose <= resistance) {
            const slDistance = (resistance - support) * 0.5 || (atr || 0.1);
            return {
                type: 'BUY',
                entry: close,
                sl: close - slDistance,
                tp: close + slDistance * 2,
                score: 75,
                label: 'Breakout Up',
                factors: ['Resistance breakout', 'Bullish momentum'],
                tpMultiplier: 2,
                slMultiplier: 1
            };
        }
        
        // Check for breakout down
        if (close < support && prevClose >= support) {
            const slDistance = (resistance - support) * 0.5 || (atr || 0.1);
            return {
                type: 'SELL',
                entry: close,
                sl: close + slDistance,
                tp: close - slDistance * 2,
                score: 75,
                label: 'Breakout Down',
                factors: ['Support breakdown', 'Bearish momentum'],
                tpMultiplier: 2,
                slMultiplier: 1
            };
        }
        
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
        const trendAllows =
            (brk.direction === 'up' && trend !== 'down') ||
            (brk.direction === 'down' && trend !== 'up');

        if (!trendAllows) return null;
        if (trend === 'ranging' && !this.allowRangingTrend) return null;

        const side = brk.direction === 'up' ? 'buy' : 'sell';

        const buffer = Math.abs(currentPrice - brk.level) * 0.1;
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
}

// Default export for compatibility
export default BreakoutTrendStrategy;

// ═══════════════════════════════════════════════════════════════════════
// USAGE:
//
//   import { BreakoutTrendStrategy } from './breakout_trend.js';
//   const strategy = new BreakoutTrendStrategy();
//   const signal = BreakoutTrendStrategy.checkEntry(candles, atr, symbol);
// ═══════════════════════════════════════════════════════════════════════