export const DataLogger = {
    _buffer: [],

    _getFilename(symbol) {
        const safe = symbol.replace(/[^a-zA-Z0-9]/g, '_');
        return `training_${safe}.csv`;
    },

    logSignal(type, bar, atr, rsi, ema8, ema21, isTrending, isVolatile, bullScore, bearScore, symbol, timeframe) {
        const record = {
            timestamp:    new Date(bar.time * 1000).toISOString(),
            unix:         bar.time,
            symbol,
            timeframe,
            type,
            entry:        bar.close,
            open:         bar.open,
            high:         bar.high,
            low:          bar.low,
            atr:          atr   ? parseFloat(atr.toFixed(5))   : null,
            rsi:          rsi   ? parseFloat(rsi.toFixed(2))   : null,
            ema8:         ema8  ? parseFloat(ema8.toFixed(5))  : null,
            ema21:        ema21 ? parseFloat(ema21.toFixed(5)) : null,
            ema_diff:     (ema8 && ema21) ? parseFloat((ema8 - ema21).toFixed(5)) : null,
            is_trending:  isTrending ? 1 : 0,
            is_volatile:  isVolatile ? 1 : 0,
            bull_score:   bullScore,
            bear_score:   bearScore,
            outcome:      null,
            pnl:          null,
            sl:           null,
            tp:           null,
            hold_candles: null,
            _filename:    this._getFilename(symbol)
        };

        this._buffer.push(record);
        console.log(`[DataLogger] Signal logged → ${symbol} ${type} @ ${bar.close}`);
        return record;
    },

    logOutcome(outcome, entry, sl, tp, barTime) {
        const record = this._buffer[this._buffer.length - 1];
        if (!record || record.outcome !== null) return;

        const pnl = outcome === 'TP'
            ? (record.type === 'BUY' ? tp - entry : entry - tp)
            : (record.type === 'BUY' ? sl - entry : entry - sl);

        record.outcome      = outcome;
        record.pnl          = parseFloat(pnl.toFixed(5));
        record.sl           = parseFloat(sl.toFixed(5));
        record.tp           = parseFloat(tp.toFixed(5));
        record.hold_candles = barTime ? Math.abs(barTime - record.unix) : null;

        console.log(`[DataLogger] Outcome → ${record.symbol} ${record.type} ${outcome} P&L: ${record.pnl} held: ${record.hold_candles}s`);
        this._flushToServer(record);
    },

    async _flushToServer(record) {
        try {
            await fetch('/api/log', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(record)
            });
        } catch(e) {
            console.warn('[DataLogger] Failed to flush:', e);
        }
    },

    getBuffer() { return this._buffer; }
};