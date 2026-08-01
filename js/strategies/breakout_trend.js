// js/strategies/breakout_trend.js
// ═══════════════════════════════════════════════════════════════════════
// Breakout-with-trend strategy.
// ═══════════════════════════════════════════════════════════════════════

export class BreakoutTrendStrategy {
    constructor(options = {}) {
        this.riskRewardRatio = options.riskRewardRatio || 2;
        this.allowRangingTrend = options.allowRangingTrend ?? true;
        this.minTouchesForLevel = options.minTouchesForLevel || 2;
    }

    // Static method for compatibility with signal-bot.js
    static checkEntry(candles, atr, symbol) {
        if (candles.length < 21) {
            console.log(`[${symbol}] Waiting for more candles (${candles.length}/21)`);
            return null;
        }

        // FIX (reapplied): the window used to compute resistance/support
        // must exclude the CURRENT candle. Using slice(-20) here includes
        // it, which means `resistance` is always >= the current candle's
        // own high — so `close > resistance` can almost never be true,
        // since a candle's close can't exceed its own high. That's why
        // this fired zero times across 8 hours of a clearly trending
        // chart: the check was structurally unreachable, not just
        // "waiting for a big enough move." slice(-21, -1) takes the 20
        // candles BEFORE the current one instead, so the level being
        // tested is independent of the candle testing it.
        const recentCandles = candles.slice(-21, -1);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const high = Math.max(...highs);
        const low = Math.min(...lows);
        const close = candles[candles.length - 1].close;
        const prevClose = candles[candles.length - 2]?.close ?? close;

        console.log(`[${symbol}] Monitoring range: ${low.toFixed(2)} - ${high.toFixed(2)} | Current: ${close.toFixed(2)}`);

        const resistance = high;
        const support = low;

        // Check breakout up
        if (close > resistance && prevClose <= resistance) {
            console.log(`[${symbol}] 🔥 BREAKOUT UP detected! Resistance: ${resistance.toFixed(2)} → Current: ${close.toFixed(2)}`);
            const slDistance = (resistance - support) * 0.5 || (atr || 0.1);
            return {
                type: 'BUY',
                entry: close,
                sl: close - slDistance,
                tp: close + slDistance * 2,
                score: 75,
                label: 'Breakout Up',
                factors: [`Resistance breakout at ${resistance.toFixed(2)}`, 'Bullish momentum'],
                tpMultiplier: 2,
                slMultiplier: 1,
                reason: `Resistance breakout above ${resistance.toFixed(2)}`
            };
        }

        // Check breakout down
        if (close < support && prevClose >= support) {
            console.log(`[${symbol}] 🔥 BREAKOUT DOWN detected! Support: ${support.toFixed(2)} → Current: ${close.toFixed(2)}`);
            const slDistance = (resistance - support) * 0.5 || (atr || 0.1);
            return {
                type: 'SELL',
                entry: close,
                sl: close + slDistance,
                tp: close - slDistance * 2,
                score: 75,
                label: 'Breakout Down',
                factors: [`Support breakdown at ${support.toFixed(2)}`, 'Bearish momentum'],
                tpMultiplier: 2,
                slMultiplier: 1,
                reason: `Support breakdown below ${support.toFixed(2)}`
            };
        }

        // Log current status
        const breakoutUpDistance = ((resistance - close) / (resistance - support) * 100).toFixed(1);
        const breakoutDownDistance = ((close - support) / (resistance - support) * 100).toFixed(1);
        console.log(`[${symbol}] 📊 Range: ${support.toFixed(2)} - ${resistance.toFixed(2)} | Price: ${close.toFixed(2)} | % to breakout: ↑${breakoutUpDistance}% ↓${breakoutDownDistance}%`);

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