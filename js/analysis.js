// js/analysis.js
// ═══════════════════════════════════════════════════════════════════════
// Single source of truth for "what is the market doing right now."
// Strategies READ from this — they never compute their own structure.
// Recomputes only on new candle close (not every tick) for speed;
// uses full historical lookback each time for accuracy.
// ═══════════════════════════════════════════════════════════════════════

class MarketAnalysis {
    constructor(symbol, timeframe, lookbackBars = 200) {
        this.symbol = symbol;
        this.timeframe = timeframe;
        this.lookbackBars = lookbackBars;
        this.cache = null;          // last computed structure
        this.lastCandleTime = null; // used to detect "new candle closed"
    }

    // Call this on every tick. It's cheap unless a new candle just closed.
    update(candles) {
        const latestCandleTime = candles[candles.length - 1].time;
        if (latestCandleTime === this.lastCandleTime && this.cache) {
            return this.cache; // nothing new — return cached structure instantly
        }
        this.lastCandleTime = latestCandleTime;
        this.cache = this._computeStructure(candles.slice(-this.lookbackBars));
        return this.cache;
    }

    _computeStructure(candles) {
        const support = this._findSupportLevels(candles);
        const resistance = this._findResistanceLevels(candles);
        return {
            symbol: this.symbol,
            timeframe: this.timeframe,
            trend: this._detectTrend(candles),
            support,
            resistance,
            // Check every level for an active break-in-progress or a confirmed break
            breaks: this._checkBreaks(candles, [...support, ...resistance]),
            volatility: this._measureVolatility(candles),
            currentPrice: candles[candles.length - 1].close,
            computedAt: Date.now()
        };
    }

    // ── 2-candle-close confirmation rule ──
    // A level is "broken" only when 2 consecutive candles CLOSE beyond it
    // in the same direction. A close back inside = failed break; the level
    // itself is left unchanged (still valid, still tradeable).
    _checkBreaks(candles, levels) {
        const results = [];
        for (const level of levels) {
            const status = this._evaluateLevelBreak(candles, level);
            if (status.state !== 'intact') results.push(status);
        }
        return results;
    }

    _evaluateLevelBreak(candles, level) {
        // Look at the last 3 closed candles: [breakCandle, confirm1, confirm2]
        const recent = candles.slice(-3);
        if (recent.length < 3) return { level: level.price, state: 'intact' };

        const [breakCandle, confirm1, confirm2] = recent;
        const direction = level.type === 'resistance' ? 'up' : 'down';

        const closedBeyond = (candle) => direction === 'up'
            ? candle.close > level.price
            : candle.close < level.price;

        const initialBreak = closedBeyond(breakCandle);
        if (!initialBreak) return { level: level.price, state: 'intact' };

        const bothConfirm = closedBeyond(confirm1) && closedBeyond(confirm2);
        if (bothConfirm) {
            return {
                level: level.price,
                type: level.type,
                state: 'confirmed_break',
                direction,
                confirmedAt: confirm2.time
            };
        }

        // Broke but didn't get 2-candle confirmation — failed break.
        // Level stays as-is per your rule; just flag it for strategies
        // that want to be aware a fakeout just happened here.
        return {
            level: level.price,
            type: level.type,
            state: 'failed_break',
            direction
        };
    }

    // ── Swing point detection ──
    // A swing high/low is a candle whose high/low is more extreme than
    // `swingStrength` candles on either side of it.
    _findSwingPoints(candles, swingStrength = 2) {
        const highs = [];
        const lows = [];
        for (let i = swingStrength; i < candles.length - swingStrength; i++) {
            const c = candles[i];
            let isSwingHigh = true;
            let isSwingLow = true;
            for (let j = i - swingStrength; j <= i + swingStrength; j++) {
                if (j === i) continue;
                if (candles[j].high >= c.high) isSwingHigh = false;
                if (candles[j].low <= c.low) isSwingLow = false;
            }
            if (isSwingHigh) highs.push({ price: c.high, time: c.time, index: i });
            if (isSwingLow) lows.push({ price: c.low, time: c.time, index: i });
        }
        return { highs, lows };
    }

    // ── Cluster nearby swing points into levels ──
    // Tolerance is ATR-based so it adapts per-symbol instead of a fixed
    // pip value (a fixed tolerance would be wrong for e.g. Volatility 75
    // vs EURUSD, which move on completely different scales).
    _clusterLevels(points, atr, type) {
        if (points.length === 0) return [];
        const tolerance = atr * 0.5; // half an ATR — adjust if too loose/tight
        const sorted = [...points].sort((a, b) => a.price - b.price);
        const clusters = [];
        let current = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].price - current[current.length - 1].price <= tolerance) {
                current.push(sorted[i]);
            } else {
                clusters.push(current);
                current = [sorted[i]];
            }
        }
        clusters.push(current);

        return clusters.map(cluster => ({
            price: cluster.reduce((s, p) => s + p.price, 0) / cluster.length, // avg price of cluster
            type,
            touches: cluster.length,
            strength: cluster.length >= 3 ? 'strong' : cluster.length === 2 ? 'moderate' : 'weak',
            lastTouch: Math.max(...cluster.map(p => p.time))
        })).sort((a, b) => b.touches - a.touches); // strongest levels first
    }

    // ── ATR (Average True Range) — used for tolerance + volatility ──
    _calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return 0;
        const trueRanges = [];
        for (let i = 1; i < candles.length; i++) {
            const curr = candles[i];
            const prev = candles[i - 1];
            const tr = Math.max(
                curr.high - curr.low,
                Math.abs(curr.high - prev.close),
                Math.abs(curr.low - prev.close)
            );
            trueRanges.push(tr);
        }
        const recent = trueRanges.slice(-period);
        return recent.reduce((s, tr) => s + tr, 0) / recent.length;
    }

    _detectTrend(candles, lookback = 20) {
        const { highs, lows } = this._findSwingPoints(candles.slice(-lookback - 4));
        if (highs.length < 2 || lows.length < 2) return 'ranging';

        const recentHighs = highs.slice(-2);
        const recentLows = lows.slice(-2);
        const higherHighs = recentHighs[1].price > recentHighs[0].price;
        const higherLows = recentLows[1].price > recentLows[0].price;
        const lowerHighs = recentHighs[1].price < recentHighs[0].price;
        const lowerLows = recentLows[1].price < recentLows[0].price;

        if (higherHighs && higherLows) return 'up';
        if (lowerHighs && lowerLows) return 'down';
        return 'ranging';
    }

    _findSupportLevels(candles) {
        const atr = this._calculateATR(candles);
        const { lows } = this._findSwingPoints(candles);
        return this._clusterLevels(lows, atr, 'support');
    }

    _findResistanceLevels(candles) {
        const atr = this._calculateATR(candles);
        const { highs } = this._findSwingPoints(candles);
        return this._clusterLevels(highs, atr, 'resistance');
    }

    _measureVolatility(candles) {
        const atr = this._calculateATR(candles);
        const avgPrice = candles.slice(-14).reduce((s, c) => s + c.close, 0) / 14;
        const atrPercent = (atr / avgPrice) * 100;
        let classification = 'normal';
        if (atrPercent < 0.05) classification = 'low';
        if (atrPercent > 0.2) classification = 'high';
        return { atr, atrPercent: atrPercent.toFixed(3), classification };
    }
}

module.exports = MarketAnalysis;

// ═══════════════════════════════════════════════════════════════════════
// USAGE (in signal-bot.js or wherever the loop lives):
//
//   const MarketAnalysis = require('./js/analysis.js');
//   const analysis = new MarketAnalysis('EURUSD', 'M15', 200);
//
//   // on each tick / candle update:
//   const structure = analysis.update(candles);
//   // structure = { trend, support, resistance, breaks, volatility, currentPrice }
//   // structure.breaks = [{ level, type, state: 'confirmed_break'|'failed_break', direction }]
//
//   // strategies just read `structure` — they never touch raw candles
//   // e.g. only act on breaks where state === 'confirmed_break'
//   const signal = myStrategy(structure);
// ═══════════════════════════════════════════════════════════════════════
