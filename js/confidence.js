// js/confidence.js
// Signal Confidence Scoring Engine
// Scores a signal 0-100 based on confluence of indicators and overlays.
// Higher score = more factors aligning with the signal direction.

export const ConfidenceEngine = {

    // Main entry — call at signal fire time
    // Returns { score: 0-100, grade: 'A'|'B'|'C'|'D', factors: string[], color: string }
    score({ type, candles, h4Candles, rsi, atr, overlayState }) {
        const factors  = [];
        let   total    = 0;
        const dir      = type === 'BUY' ? 1 : -1;
        const last     = candles[candles.length - 1];
        const prev     = candles[candles.length - 2];
        if (!last || !prev) return _result(0, []);

        // ── TREND ALIGNMENT (20pts) ───────────────────────────
        const ema8  = _ema(candles, 8);
        const ema21 = _ema(candles, 21);
        const ema50 = _ema(candles, 50);

        if (ema8 && ema21) {
            const emaAligned = dir === 1
                ? (ema8 > ema21 && last.close > ema21)
                : (ema8 < ema21 && last.close < ema21);
            if (emaAligned) { total += 15; factors.push('EMA trend aligned'); }
        }
        if (ema50) {
            const above50 = last.close > ema50;
            if ((dir === 1 && above50) || (dir === -1 && !above50)) {
                total += 5; factors.push('Price above/below EMA50');
            }
        }

        // ── RSI CONFLUENCE (20pts) ────────────────────────────
        if (rsi) {
            if (dir === 1 && rsi >= 40 && rsi <= 60) { total += 15; factors.push(`RSI neutral pullback (${rsi.toFixed(1)})`); }
            else if (dir === 1 && rsi < 40)           { total += 20; factors.push(`RSI oversold (${rsi.toFixed(1)})`); }
            else if (dir === -1 && rsi >= 40 && rsi <= 60) { total += 15; factors.push(`RSI neutral pullback (${rsi.toFixed(1)})`); }
            else if (dir === -1 && rsi > 60)           { total += 20; factors.push(`RSI overbought (${rsi.toFixed(1)})`); }
            else                                        { total +=  5; factors.push(`RSI present (${rsi.toFixed(1)})`); }
        }

        // ── H4 TREND ALIGNMENT (15pts) ────────────────────────
        if (h4Candles && h4Candles.length >= 21) {
            const h4ema21 = _ema(h4Candles, 21);
            const h4Last  = h4Candles[h4Candles.length - 1];
            if (h4ema21 && h4Last) {
                const h4Aligned = dir === 1
                    ? h4Last.close > h4ema21
                    : h4Last.close < h4ema21;
                if (h4Aligned) { total += 15; factors.push('H4 trend aligned'); }
            }
        }

        // ── CANDLE STRUCTURE (15pts) ──────────────────────────
        if (atr) {
            const bodySize = Math.abs(last.close - last.open);
            const isBigBody = bodySize > atr * 0.6;
            const isBullCandle = last.close > last.open;
            const isBearCandle = last.close < last.open;

            if (dir === 1 && isBullCandle && isBigBody) { total += 10; factors.push('Strong bull candle'); }
            if (dir === -1 && isBearCandle && isBigBody) { total += 10; factors.push('Strong bear candle'); }

            // Engulfing
            if (dir === 1 && last.close > prev.open && last.open < prev.close && prev.close < prev.open) {
                total += 5; factors.push('Bullish engulfing');
            }
            if (dir === -1 && last.close < prev.open && last.open > prev.close && prev.close > prev.open) {
                total += 5; factors.push('Bearish engulfing');
            }
        }

        // ── OVERLAY CONFLUENCES (30pts, 6pts each) ────────────
        if (overlayState) {
            // Near Order Block
            if (overlayState['show-ob']) {
                total += 6; factors.push('Order Block zone active');
            }

            // FVG in direction
            if (overlayState['show-fvg']) {
                total += 6; factors.push('FVG zone present');
            }

            // H4 Kiss level nearby
            if (overlayState['show-h4'] && h4Candles?.length >= 21) {
                const h4ema = _ema(h4Candles, 21);
                if (h4ema && atr && Math.abs(last.close - h4ema) < atr * 1.5) {
                    total += 6; factors.push('Near H4 EMA21 Kiss level');
                }
            }

            // Asian range boundary
            if (overlayState['show-asian']) {
                total += 4; factors.push('Asian range reference active');
            }

            // BOS confirmation
            if (overlayState['show-bos']) {
                total += 4; factors.push('Structure break confirmed');
            }

            // Major S/R nearby
            if (overlayState['show-major'] && atr) {
                total += 4; factors.push('Near key S/R level');
            }
        }

        // Cap at 100
        total = Math.min(total, 100);
        return _result(total, factors);
    },
};

function _result(score, factors) {
    const grade = score >= 75 ? 'A' : score >= 55 ? 'B' : score >= 35 ? 'C' : 'D';
    const color = score >= 75 ? '#10b981' : score >= 55 ? '#f59e0b' : score >= 35 ? '#f97316' : '#ef4444';
    return { score, grade, factors, color };
}

function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) e = candles[i].close * k + e * (1 - k);
    return e;
}