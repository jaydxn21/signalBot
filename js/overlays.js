// js/overlays.js
// All chart overlay drawings for NEXUS.
// Each function takes a LightweightCharts candleSeries and candle array.
// Call OverlayManager.clearAll(series) before redrawing.

// Jamaica is UTC-5 (no DST). All session times are expressed in UTC
// but derived from Jamaica local time by adding 5 hours.
const JA_OFFSET = 5 * 3600; // seconds to add to get UTC from Jamaica time

// Returns the UTC timestamp for midnight Jamaica time on the day of `unixTs`
function _jaMidnightUTC(unixTs) {
    const jaTime  = unixTs - JA_OFFSET;          // shift to Jamaica time
    const jaMid   = jaTime - (jaTime % 86400);   // midnight in Jamaica
    return jaMid + JA_OFFSET;                    // back to UTC
}

export const OverlayManager = {

    _lines: [],   // tracks all active price lines for cleanup

    clearAll(series) {
        this._lines.forEach(line => {
            try { series.removePriceLine(line); } catch(e) {}
        });
        this._lines = [];
    },

    _addLine(series, price, title, color, style = 1, width = 1) {
        if (!price || isNaN(price)) return;
        try {
            const line = series.createPriceLine({
                price,
                color,
                lineWidth:        width,
                lineStyle:        style, // 0=solid 1=dotted 2=dashed 3=large dashed
                axisLabelVisible: true,
                title,
            });
            this._lines.push(line);
        } catch(e) {}
    },

    // ── ASIAN SESSION RANGE ────────────────────────────────────
    // Asian session: 00:00–08:00 Tokyo (19:00–03:00 EST / 00:00–08:00 UTC+9)
    // In Jamaica time: 11:00 PM prior day – 07:00 AM
    // In UTC: 04:00 – 12:00 UTC
    drawAsianRange(series, candles) {
        if (!candles?.length) return;

        const now       = candles[candles.length - 1].time;
        const jaMidUTC  = _jaMidnightUTC(now);
        const asianStart = jaMidUTC - JA_OFFSET + 4 * 3600; // 04:00 UTC (prev midnight + offsets)
        const asianEnd   = asianStart + 8 * 3600;             // 12:00 UTC = 07:00 Jamaica

        const session = candles.filter(c =>
            c.time >= asianStart && c.time < asianEnd
        );
        if (session.length < 3) return;

        const high = Math.max(...session.map(c => c.high));
        const low  = Math.min(...session.map(c => c.low));

        this._addLine(series, high, 'Asia H', 'rgba(168,85,247,0.7)',  2, 1);
        this._addLine(series, low,  'Asia L', 'rgba(168,85,247,0.7)',  2, 1);
    },

    // ── PREVIOUS DAY HIGH / LOW ────────────────────────────────
    drawPDHPDL(series, h4Candles) {
        if (!h4Candles?.length) return;

        const now       = h4Candles[h4Candles.length - 1].time;
        const today     = _jaMidnightUTC(now);
        const yesterday = today - 86400;

        const prevDay = h4Candles.filter(c =>
            c.time >= yesterday && c.time < today
        );
        if (prevDay.length < 2) return;

        const pdh = Math.max(...prevDay.map(c => c.high));
        const pdl = Math.min(...prevDay.map(c => c.low));

        this._addLine(series, pdh, 'PDH', 'rgba(251,146,60,0.8)',  3, 1);
        this._addLine(series, pdl, 'PDL', 'rgba(251,146,60,0.8)',  3, 1);
    },

    // ── FAIR VALUE GAPS (FVG) ──────────────────────────────────
    // A 3-candle pattern where candle 1 high < candle 3 low (bull FVG)
    // or candle 1 low > candle 3 high (bear FVG)
    drawFVG(series, candles) {
        if (!candles || candles.length < 3) return;

        const recent = candles.slice(-60); // scan last 60 bars
        const found  = [];

        for (let i = 1; i < recent.length - 1; i++) {
            const c1 = recent[i - 1];
            const c2 = recent[i];
            const c3 = recent[i + 1];

            // Bullish FVG: gap between c1 high and c3 low
            if (c3.low > c1.high) {
                found.push({ mid: (c1.high + c3.low) / 2, type: 'bull' });
            }
            // Bearish FVG: gap between c1 low and c3 high
            if (c3.high < c1.low) {
                found.push({ mid: (c1.low + c3.high) / 2, type: 'bear' });
            }
        }

        // Only draw the 3 most recent FVGs to avoid clutter
        found.slice(-3).forEach(({ mid, type }) => {
            const color = type === 'bull'
                ? 'rgba(16,185,129,0.6)'
                : 'rgba(239,68,68,0.6)';
            this._addLine(series, mid, type === 'bull' ? 'FVG ↑' : 'FVG ↓', color, 2, 1);
        });
    },

    // ── H4 KISS LEVEL ──────────────────────────────────────────
    // The H4 EMA21 level — price often "kisses" it before continuing
    drawH4Kiss(series, h4Candles) {
        if (!h4Candles || h4Candles.length < 21) return;

        const period = 21;
        const k      = 2 / (period + 1);
        let ema = h4Candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < h4Candles.length; i++) {
            ema = h4Candles[i].close * k + ema * (1 - k);
        }

        this._addLine(series, ema, 'H4 EMA21', 'rgba(37,99,235,0.65)', 2, 1);
    },

    // ── MAJOR SUPPORT & RESISTANCE ─────────────────────────────
    // Finds swing highs/lows with at least 3 touches
    drawMajorSR(series, candles) {
        if (!candles || candles.length < 20) return;

        const lookback = Math.min(candles.length, 200);
        const slice    = candles.slice(-lookback);
        const atr      = _calcATR(slice, 14) || 0.001;
        const tolerance = atr * 0.5;

        const levels = [];

        // Find swing highs and lows
        for (let i = 2; i < slice.length - 2; i++) {
            const c = slice[i];
            const isSwingHigh = c.high > slice[i-1].high && c.high > slice[i-2].high
                             && c.high > slice[i+1].high && c.high > slice[i+2].high;
            const isSwingLow  = c.low  < slice[i-1].low  && c.low  < slice[i-2].low
                             && c.low  < slice[i+1].low  && c.low  < slice[i+2].low;

            if (isSwingHigh) levels.push({ price: c.high, type: 'R' });
            if (isSwingLow)  levels.push({ price: c.low,  type: 'S' });
        }

        // Cluster nearby levels and keep those with 2+ touches
        const clusters = [];
        levels.forEach(l => {
            const existing = clusters.find(c =>
                Math.abs(c.price - l.price) < tolerance
            );
            if (existing) {
                existing.count++;
                existing.price = (existing.price + l.price) / 2; // average
            } else {
                clusters.push({ ...l, count: 1 });
            }
        });

        // Draw top 4 most-tested levels
        clusters
            .filter(c => c.count >= 2)
            .sort((a, b) => b.count - a.count)
            .slice(0, 4)
            .forEach(({ price, type, count }) => {
                const color = type === 'R'
                    ? 'rgba(239,68,68,0.55)'
                    : 'rgba(16,185,129,0.55)';
                this._addLine(series, price, `${type}${count}`, color, 2, 1);
            });
    },

    // ── ORB — OPENING RANGE BREAKOUT ───────────────────────────
    // ORB = NY open 09:30–10:00 EST = 14:30–15:00 UTC
    // Jamaica is EST so 09:30–10:00 Jamaica = 14:30–15:00 UTC
    drawORBRange(series, candles) {
        if (!candles?.length) return;

        const now       = candles[candles.length - 1].time;
        const jaMidUTC  = _jaMidnightUTC(now);
        const orbStart  = jaMidUTC + 9 * 3600 + 1800;  // 09:30 Jamaica = 14:30 UTC
        const orbEnd    = orbStart + 1800;               // 10:00 Jamaica = 15:00 UTC

        const orbCandles = candles.filter(c =>
            c.time >= orbStart && c.time < orbEnd
        );
        if (orbCandles.length < 2) return;

        const high = Math.max(...orbCandles.map(c => c.high));
        const low  = Math.min(...orbCandles.map(c => c.low));

        this._addLine(series, high, 'ORB H', 'rgba(234,179,8,0.75)',  3, 1);
        this._addLine(series, low,  'ORB L', 'rgba(234,179,8,0.75)',  3, 1);
    },

    // ── ORDER BLOCKS ───────────────────────────────────────────
    // Last bearish candle before a strong bull move (bull OB)
    // Last bullish candle before a strong bear move (bear OB)
    drawOrderBlocks(series, candles) {
        if (!candles || candles.length < 10) return;

        const atr     = _calcATR(candles, 14) || 0.001;
        const recent  = candles.slice(-80);
        const obs     = [];

        for (let i = 1; i < recent.length - 2; i++) {
            const c  = recent[i];
            const n1 = recent[i + 1];
            const n2 = recent[i + 2];

            // Bullish OB: bearish candle followed by 2 strong bullish candles
            const isBearCandle = c.close < c.open;
            const strongBullMove = n1.close > n1.open && n2.close > n2.open
                && (n2.close - c.low) > atr * 1.5;

            if (isBearCandle && strongBullMove) {
                obs.push({ price: (c.open + c.close) / 2, type: 'bull' });
            }

            // Bearish OB: bullish candle followed by 2 strong bearish candles
            const isBullCandle = c.close > c.open;
            const strongBearMove = n1.close < n1.open && n2.close < n2.open
                && (c.high - n2.close) > atr * 1.5;

            if (isBullCandle && strongBearMove) {
                obs.push({ price: (c.open + c.close) / 2, type: 'bear' });
            }
        }

        // Draw most recent 2 of each
        const bulls = obs.filter(o => o.type === 'bull').slice(-2);
        const bears = obs.filter(o => o.type === 'bear').slice(-2);

        bulls.forEach(({ price }) =>
            this._addLine(series, price, 'Bull OB', 'rgba(16,185,129,0.7)', 2, 1)
        );
        bears.forEach(({ price }) =>
            this._addLine(series, price, 'Bear OB', 'rgba(239,68,68,0.7)',  2, 1)
        );
    },

    // ── BREAK OF STRUCTURE ─────────────────────────────────────
    // Marks the most recent BOS — when price breaks a prior swing high/low
    drawBreakOfStructure(series, candles) {
        if (!candles || candles.length < 20) return;

        const recent = candles.slice(-50);
        const last   = recent[recent.length - 1];

        // Find most recent swing high broken to upside (BOS up)
        let swingHigh = null;
        for (let i = recent.length - 10; i >= 5; i--) {
            const c = recent[i];
            if (c.high > recent[i-1].high && c.high > recent[i-2].high
             && c.high > recent[i+1].high && c.high > recent[i+2].high) {
                swingHigh = c.high;
                break;
            }
        }

        // Find most recent swing low broken to downside (BOS down)
        let swingLow = null;
        for (let i = recent.length - 10; i >= 5; i--) {
            const c = recent[i];
            if (c.low < recent[i-1].low && c.low < recent[i-2].low
             && c.low < recent[i+1].low && c.low < recent[i+2].low) {
                swingLow = c.low;
                break;
            }
        }

        if (swingHigh && last.close > swingHigh) {
            this._addLine(series, swingHigh, 'BOS ↑', 'rgba(16,185,129,0.8)', 3, 2);
        }
        if (swingLow && last.close < swingLow) {
            this._addLine(series, swingLow, 'BOS ↓', 'rgba(239,68,68,0.8)',   3, 2);
        }
    },
};

// ── HELPERS ───────────────────────────────────────────────────
function _calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = candles.slice(1).map((c, i) => {
        const prev = candles[i];
        return Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low  - prev.close)
        );
    });
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}