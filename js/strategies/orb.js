export const ORBStrategy = {
    _orbHigh: null,
    _orbLow: null,
    _orbBuilt: false,
    _lastSignalDate: null,

    _buildORB(candles) {
        // Find candles between 00:00 and 00:15 UTC
        const orbCandles = candles.filter(c => {
            const date = new Date(c.time * 1000);
            const hours = date.getUTCHours();
            const mins  = date.getUTCMinutes();
            return hours === 0 && mins < 15;
        });

        if (orbCandles.length === 0) return false;

        this._orbHigh = Math.max(...orbCandles.map(c => c.high));
        this._orbLow  = Math.min(...orbCandles.map(c => c.low));
        this._orbBuilt = true;
        return true;
    },

    checkEntry(candles) {
        if (candles.length < 3) return null;

        // Rebuild ORB every new day
        const lastCandle = candles[candles.length - 1];
        const lastDate   = new Date(lastCandle.time * 1000).toISOString().slice(0, 10);

        if (this._lastSignalDate !== lastDate) {
            this._orbBuilt = false;
            this._orbHigh  = null;
            this._orbLow   = null;
        }

        if (!this._orbBuilt) {
            const built = this._buildORB(candles);
            if (!built) return null;
        }

        if (!this._orbHigh || !this._orbLow) return null;

        // Use closed candle for confirmation
        const closed = candles[candles.length - 2];
        const prev   = candles[candles.length - 3];

        // Make sure we are past the opening range window (after 00:15 UTC)
        const closedDate = new Date(closed.time * 1000);
        const isPastORB  = closedDate.getUTCHours() > 0 || closedDate.getUTCMinutes() >= 15;
        if (!isPastORB) return null;

        // BUY: closed candle breaks above ORB high with bullish body
        if (closed.close > this._orbHigh && closed.close > closed.open && prev.close <= this._orbHigh) {
            this._lastSignalDate = lastDate;
            return { type: 'BUY', label: 'ORB Breakout' };
        }

        // SELL: closed candle breaks below ORB low with bearish body
        if (closed.close < this._orbLow && closed.close < closed.open && prev.close >= this._orbLow) {
            this._lastSignalDate = lastDate;
            return { type: 'SELL', label: 'ORB Breakdown' };
        }

        return null;
    }
};