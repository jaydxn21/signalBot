// Ultra Scalper — All Symbols
// The fastest firing strategy in the bot. Designed to fire within seconds
// on any symbol. Uses tick-level analysis on M1 candles — no higher timeframe
// confirmation, no session filter, no cooldown delay.
//
// LOGIC — fires when ALL THREE align simultaneously:
// 1. Current candle body direction (up/down)
// 2. Previous candle same direction (micro momentum)
// 3. Live candle already moving in same direction (instant confirmation)
//
// This is aggressive. It will fire often. Use on demo only for testing
// signal speed and execution pipeline. NOT recommended for live trading
// without further filtering. Treat as a pipeline stress test.
//
// TP: 0.5x ATR (very tight — takes profit fast)
// SL: 0.5x ATR (equal risk — relies on high win rate from frequency)

export const UltraScalper = {
    _lastSignalMs: 0,
    MIN_GAP_MS: 8000, // Minimum 8 seconds between signals

    _getBodyDirection(candle) {
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
        return null;
    },

    // Body must be at least 30% of the candle range — not a doji
    _hasMeaningfulBody(candle) {
        const range = candle.high - candle.low;
        if (range === 0) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > 0.3;
    },

    checkEntry(candles, atr) {
        if (!atr || candles.length < 5) return null;

        const now = Date.now();
        if (now - this._lastSignalMs < this.MIN_GAP_MS) return null;

        const c1   = candles[candles.length - 3]; // 3rd last closed
        const c2   = candles[candles.length - 2]; // last closed
        const live = candles[candles.length - 1]; // forming now

        const dir1 = this._getBodyDirection(c1);
        const dir2 = this._getBodyDirection(c2);
        const liveDir = live.close > c2.close ? 'BUY' : live.close < c2.close ? 'SELL' : null;

        if (!dir1 || !dir2 || !liveDir) return null;
        if (!this._hasMeaningfulBody(c1)) return null;
        if (!this._hasMeaningfulBody(c2)) return null;

        // All three must agree
        if (dir1 === dir2 && dir2 === liveDir) {
            this._lastSignalMs = now;
            console.log(`[UltraScalper] FIRE ${dir1} | c1: ${c1.close} c2: ${c2.close} live: ${live.close}`);
            return {
                type:  dir1,
                label: `Ultra ${dir1 === 'BUY' ? 'Buy' : 'Sell'} ⚡`,
                tpMultiplier: 0.5, // Override TP to 0.5x ATR
                slMultiplier: 0.5  // Override SL to 0.5x ATR
            };
        }

        return null;
    }
};