// js/strategies/vwap_reversion.js
// ═══════════════════════════════════════════════════════════════════════
// VWAP Reversion strategy
// Mean-reversion hypothesis: price extended away from VWAP tends to
// revert, especially when confirmed by an RSI extreme and a real-bodied
// candle (not just noise). Structurally different from breakout (which
// bets on continuation) — a genuinely new hypothesis to test.
// ═══════════════════════════════════════════════════════════════════════

export class VwapReversionStrategy {

    // Helper: Calculate ATR (same formula as breakout_trend.js for consistency)
    static calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const trueRanges = [];
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trueRanges.push(tr);
        }
        const recentTR = trueRanges.slice(-period);
        return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
    }

    // Helper: Calculate RSI
    static calculateRSI(candles, period = 14) {
        if (candles.length < period + 1) return 50;
        const closes = candles.slice(-(period + 1)).map(c => c.close);
        let gains = 0, losses = 0;
        for (let i = 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses += -diff;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // Helper: Calculate VWAP over the given window
    // Synthetic indices often lack real volume data; falls back to a
    // typical-price simple average when volume is unavailable/uniform.
    static calculateVWAP(candles) {
        let totalVol = 0, totalPV = 0;
        for (const c of candles) {
            const vol = c.volume || 1;
            const typicalPrice = (c.high + c.low + c.close) / 3;
            totalVol += vol;
            totalPV += typicalPrice * vol;
        }
        return totalVol > 0 ? totalPV / totalVol : candles[candles.length - 1].close;
    }

    // Main entry check method
    static checkEntry(candles, atr, symbol, options = {}) {
        const rsiOversold      = options.rsiOversold      ?? 40;
        const rsiOverbought    = options.rsiOverbought    ?? 60;
        const minBodyATRRatio  = options.minBodyATRRatio  ?? 0.3;
        const vwapWindow       = options.vwapWindow       ?? 50;
        const stopLossMultiplier = options.stopLossMultiplier ?? 1.2;
        const takeProfitMultiplier = options.takeProfitMultiplier ?? 1.8;
        const useATRStop       = options.useATRStop       ?? true;

        const warmup = Math.max(vwapWindow, 20);
        if (candles.length < warmup + 1) {
            return null;
        }

        // Exclude current forming candle from VWAP/RSI calc window, same
        // pattern as breakout_trend.js — avoid look-ahead on the live bar.
        const closed = candles.slice(0, -1);
        const currentCandle = candles[candles.length - 1];
        if (!currentCandle) return null;

        const vwapCandles = closed.slice(-vwapWindow);
        const vwap = this.calculateVWAP(vwapCandles);
        const rsi  = this.calculateRSI(closed, 14);

        const close = currentCandle.close;
        const candleBody = Math.abs(currentCandle.close - currentCandle.open);
        const atrValue = atr || this.calculateATR(candles, 14);
        if (!atrValue) return null;

        const bodyRatio = candleBody / atrValue;
        const priceBelowVWAP = close < vwap;
        const priceAboveVWAP = close > vwap;

        // --- BUY: price extended below VWAP, oversold, real-bodied candle ---
        if (priceBelowVWAP && rsi < rsiOversold && bodyRatio > minBodyATRRatio) {
            let slDistance = useATRStop ? atrValue * 1.2 : Math.abs(close - vwap) * 0.6;
            slDistance *= stopLossMultiplier;

            return {
                type: 'BUY',
                entry: close,
                sl: close - slDistance,
                tp: close + slDistance * (takeProfitMultiplier / stopLossMultiplier),
                score: 75,
                label: 'VWAP Reversion Buy',
                tpMultiplier: takeProfitMultiplier,
                slMultiplier: stopLossMultiplier,
                reason: `Price ${close.toFixed(5)} below VWAP ${vwap.toFixed(5)}, RSI ${rsi.toFixed(1)} oversold`,
                _meta: { vwap, rsi, bodyRatio },
            };
        }

        // --- SELL: price extended above VWAP, overbought, real-bodied candle ---
        if (priceAboveVWAP && rsi > rsiOverbought && bodyRatio > minBodyATRRatio) {
            let slDistance = useATRStop ? atrValue * 1.2 : Math.abs(close - vwap) * 0.6;
            slDistance *= stopLossMultiplier;

            return {
                type: 'SELL',
                entry: close,
                sl: close + slDistance,
                tp: close - slDistance * (takeProfitMultiplier / stopLossMultiplier),
                score: 75,
                label: 'VWAP Reversion Sell',
                tpMultiplier: takeProfitMultiplier,
                slMultiplier: stopLossMultiplier,
                reason: `Price ${close.toFixed(5)} above VWAP ${vwap.toFixed(5)}, RSI ${rsi.toFixed(1)} overbought`,
                _meta: { vwap, rsi, bodyRatio },
            };
        }

        return null;
    }
}

export default VwapReversionStrategy;
