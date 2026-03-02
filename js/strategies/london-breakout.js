// London Breakout — Forex / Gold
// The Asian session (00:00-06:00 UTC) consolidates price into a tight range.
// When London opens at 08:00 UTC, institutional flow drives price decisively
// out of that range. Gold and GBP/USD make some of their largest daily moves
// in the first 2 hours of London. This strategy marks the Asian range and
// fires on breakout confirmation at London open.

export const LondonBreakout = {
    _cooldownCandles: 0,
    _firedToday: false,
    _lastFireDate: null,
    ASIAN_START_UTC: 0,  // 00:00 UTC
    ASIAN_END_UTC:   6,  // 06:00 UTC
    LONDON_START:    8,  // 08:00 UTC
    LONDON_END:      11, // 11:00 UTC — only trade first 3 hours

    _getAsianRange(candles) {
        // Find all candles within today's Asian session (00:00-06:00 UTC)
        const now   = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const asianStart = today.getTime() / 1000;
        const asianEnd   = asianStart + 6 * 3600;

        const asianCandles = candles.filter(c =>
            c.time >= asianStart && c.time < asianEnd
        );

        if (asianCandles.length < 3) return null;

        const high = Math.max(...asianCandles.map(c => c.high));
        const low  = Math.min(...asianCandles.map(c => c.low));
        return { high, low, mid: (high + low) / 2 };
    },

    _isLondonSession(candle) {
        const hour = new Date(candle.time * 1000).getUTCHours();
        return hour >= this.LONDON_START && hour < this.LONDON_END;
    },

    registerLoss() { this._cooldownCandles = 5; },

    checkEntry(candles, atr) {
        if (!atr || candles.length < 20) return null;
        if (this._cooldownCandles > 0) { this._cooldownCandles--; return null; }

        const c = candles[candles.length - 2];

        if (!this._isLondonSession(c)) return null;

        // Only one trade per day
        const today = new Date(c.time * 1000).toDateString();
        if (this._lastFireDate === today) return null;

        const range = this._getAsianRange(candles);
        if (!range) return null;

        const body         = Math.abs(c.close - c.open);
        const isStrongBreak = body > atr * 0.6;

        const bullBreak = c.close > range.high && c.close > c.open && isStrongBreak;
        const bearBreak = c.close < range.low  && c.close < c.open && isStrongBreak;

        // Live candle confirming
        const live = candles[candles.length - 1];
        if (bullBreak && live.close > c.close) {
            console.log(`[LondonBreakout] BUY breakout above Asian high: ${range.high.toFixed(4)}`);
            this._lastFireDate = today;
            return { type: 'BUY', label: `London Breakout Buy` };
        }

        if (bearBreak && live.close < c.close) {
            console.log(`[LondonBreakout] SELL breakout below Asian low: ${range.low.toFixed(4)}`);
            this._lastFireDate = today;
            return { type: 'SELL', label: `London Breakout Sell` };
        }

        return null;
    }
};