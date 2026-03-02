export const OverlayManager = {
    _lines:    [],
    _markers:  [],
    _series:   null,

    clearAll(series) {
        this._lines.forEach(l => { try { series.removePriceLine(l); } catch(e) {} });
        this._lines = [];
        this._markers = [];
        if (series) series.setMarkers([]);
    },

    _addLine(series, price, color, label, style = 0, width = 1) {
        const line = series.createPriceLine({
            price,
            color,
            lineWidth: width,
            lineStyle: style,
            axisLabelVisible: true,
            title: label
        });
        this._lines.push(line);
        return line;
    },

    // ── Asian Range ──────────────────────────────────────────────────────────
    drawAsianRange(series, candles) {
        if (!candles || candles.length < 2) return;
        const now        = new Date();
        const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
        const asianEnd   = todayStart + 6 * 3600;
        const asian      = candles.filter(c => c.time >= todayStart && c.time < asianEnd);
        if (!asian.length) return;
        const high = Math.max(...asian.map(c => c.high));
        const low  = Math.min(...asian.map(c => c.low));
        this._addLine(series, high, '#f59e0b88', 'Asian H', 1, 1);
        this._addLine(series, low,  '#f59e0b88', 'Asian L', 1, 1);
    },

    // ── PDH / PDL ────────────────────────────────────────────────────────────
    drawPDHPDL(series, h4Candles) {
        if (!h4Candles || h4Candles.length < 2) return;
        const prev = h4Candles[h4Candles.length - 2];
        this._addLine(series, prev.high, '#38bdf888', 'PDH', 2, 1);
        this._addLine(series, prev.low,  '#f4728488', 'PDL', 2, 1);
    },

    // ── Fair Value Gaps — BOXES ──────────────────────────────────────────────
    // FVG = 3-candle pattern where candle[1] leaves a gap between candle[0] high
    // and candle[2] low (bullish) or candle[0] low and candle[2] high (bearish)
    drawFVG(series, candles) {
        if (!candles || candles.length < 3) return;
        const recent   = candles.slice(-30);
        const markers  = [];

        for (let i = 1; i < recent.length - 1; i++) {
            const prev = recent[i - 1];
            const curr = recent[i];
            const next = recent[i + 1];

            // Bullish FVG — gap between prev.high and next.low
            if (next.low > prev.high) {
                markers.push({
                    time:     curr.time,
                    position: 'belowBar',
                    color:    '#22c55e',
                    shape:    'square',
                    text:     `▣ FVG ${prev.high.toFixed(2)}-${next.low.toFixed(2)}`
                });
                // Draw box boundaries
                this._addLine(series, prev.high, '#22c55e44', 'FVG↑ bot', 1, 1);
                this._addLine(series, next.low,  '#22c55e44', 'FVG↑ top', 1, 1);
            }

            // Bearish FVG — gap between next.high and prev.low
            if (next.high < prev.low) {
                markers.push({
                    time:     curr.time,
                    position: 'aboveBar',
                    color:    '#ef4444',
                    shape:    'square',
                    text:     `▣ FVG ${next.high.toFixed(2)}-${prev.low.toFixed(2)}`
                });
                this._addLine(series, prev.low,  '#ef444444', 'FVG↓ top', 1, 1);
                this._addLine(series, next.high, '#ef444444', 'FVG↓ bot', 1, 1);
            }
        }

        if (markers.length) series.setMarkers(markers);
    },

    // ── Order Blocks ─────────────────────────────────────────────────────────
    // Order Block = last bearish candle before a bullish impulse (bull OB)
    // or last bullish candle before a bearish impulse (bear OB)
    // These are institutional accumulation/distribution zones
    drawOrderBlocks(series, candles) {
        if (!candles || candles.length < 10) return;
        const recent  = candles.slice(-50);
        const markers = [];

        for (let i = 2; i < recent.length - 3; i++) {
            const c    = recent[i];
            const next = recent[i + 1];
            const n2   = recent[i + 2];
            const n3   = recent[i + 3];

            // Bullish Order Block — bearish candle followed by 3 bullish candles
            // (institution sold, then bought aggressively — OB is demand zone)
            const isBearOB  = c.close  < c.open;
            const impulseUp = next.close > next.open &&
                              n2.close   > n2.open   &&
                              n3.close   > n3.open   &&
                              n3.close   > c.high;

            if (isBearOB && impulseUp) {
                this._addLine(series, c.high, '#3b82f688', '⬛ Bull OB', 1, 2);
                this._addLine(series, c.low,  '#3b82f644', '',          1, 1);
                markers.push({
                    time:     c.time,
                    position: 'belowBar',
                    color:    '#3b82f6',
                    shape:    'square',
                    text:     `OB↑ ${c.low.toFixed(2)}-${c.high.toFixed(2)}`
                });
            }

            // Bearish Order Block — bullish candle followed by 3 bearish candles
            const isBullOB   = c.close   > c.open;
            const impulseDown = next.close < next.open &&
                                n2.close   < n2.open   &&
                                n3.close   < n3.open   &&
                                n3.close   < c.low;

            if (isBullOB && impulseDown) {
                this._addLine(series, c.high, '#f9731644', '',           1, 1);
                this._addLine(series, c.low,  '#f9731688', '⬛ Bear OB', 1, 2);
                markers.push({
                    time:     c.time,
                    position: 'aboveBar',
                    color:    '#f97316',
                    shape:    'square',
                    text:     `OB↓ ${c.low.toFixed(2)}-${c.high.toFixed(2)}`
                });
            }
        }

        if (markers.length) {
            const existing = series.markers ? series.markers() : [];
            series.setMarkers([...existing, ...markers]);
        }
    },

    // ── Break of Structure ───────────────────────────────────────────────────
    // BOS = price closes above a significant swing high (bullish BOS)
    // or below a significant swing low (bearish BOS)
    // Identifies trend changes and continuation signals
    drawBreakOfStructure(series, candles) {
        if (!candles || candles.length < 20) return;
        const recent  = candles.slice(-60);
        const markers = [];

        for (let i = 10; i < recent.length - 2; i++) {
            // Find swing high — candle higher than 5 candles each side
            const window = 5;
            const slice  = recent.slice(Math.max(0, i - window), i + window + 1);
            const swingHigh = Math.max(...slice.map(c => c.high));
            const swingLow  = Math.min(...slice.map(c => c.low));
            const isSwingHigh = recent[i].high === swingHigh;
            const isSwingLow  = recent[i].low  === swingLow;

            // Check if a subsequent candle broke this level
            for (let j = i + 1; j < Math.min(i + 10, recent.length); j++) {
                // Bullish BOS — close above swing high
                if (isSwingHigh && recent[j].close > recent[i].high) {
                    this._addLine(series, recent[i].high, '#22c55eaa', '⚡ BOS↑', 0, 2);
                    markers.push({
                        time:     recent[j].time,
                        position: 'aboveBar',
                        color:    '#22c55e',
                        shape:    'arrowUp',
                        text:     'BOS↑'
                    });
                    break;
                }
                // Bearish BOS — close below swing low
                if (isSwingLow && recent[j].close < recent[i].low) {
                    this._addLine(series, recent[i].low, '#ef4444aa', '⚡ BOS↓', 0, 2);
                    markers.push({
                        time:     recent[j].time,
                        position: 'belowBar',
                        color:    '#ef4444',
                        shape:    'arrowDown',
                        text:     'BOS↓'
                    });
                    break;
                }
            }
        }

        if (markers.length) {
            const existing = series.markers ? series.markers() : [];
            series.setMarkers([...existing, ...markers]);
        }
    },

    // ── H4 KISS ──────────────────────────────────────────────────────────────
    drawH4Kiss(series, h4Candles) {
        if (!h4Candles || h4Candles.length < 5) return;
        const last = h4Candles[h4Candles.length - 1];
        this._addLine(series, last.high, '#a78bfa88', 'H4 Hi', 0, 1);
        this._addLine(series, last.low,  '#a78bfa88', 'H4 Lo', 0, 1);
    },

    // ── Major S/R ────────────────────────────────────────────────────────────
    drawMajorSR(series, candles) {
        if (!candles || candles.length < 50) return;
        const recent  = candles.slice(-100);
        const levels  = [];

        for (let i = 5; i < recent.length - 5; i++) {
            const c = recent[i];
            const isHigh = recent.slice(i - 5, i + 6).every(x => x.high <= c.high);
            const isLow  = recent.slice(i - 5, i + 6).every(x => x.low  >= c.low);
            if (isHigh) levels.push({ price: c.high, type: 'R' });
            if (isLow)  levels.push({ price: c.low,  type: 'S' });
        }

        // Deduplicate close levels
        const deduped = levels.filter((l, i) =>
            !levels.slice(0, i).some(x => Math.abs(x.price - l.price) < (candles[0]?.close || 1) * 0.001)
        ).slice(-6);

        deduped.forEach(l => {
            this._addLine(
                series, l.price,
                l.type === 'R' ? '#f4728455' : '#22c55e55',
                l.type, 2, 1
            );
        });
    },

    // ── ORB Range ────────────────────────────────────────────────────────────
    drawORBRange(series, candles) {
        if (!candles || candles.length < 2) return;
        const now       = new Date();
        const todayUTC  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
        const orbEnd    = todayUTC + 15 * 60;
        const orb       = candles.filter(c => c.time >= todayUTC && c.time < orbEnd);
        if (!orb.length) return;
        const high = Math.max(...orb.map(c => c.high));
        const low  = Math.min(...orb.map(c => c.low));
        this._addLine(series, high, '#f59e0bcc', 'ORB Hi', 0, 2);
        this._addLine(series, low,  '#f59e0bcc', 'ORB Lo', 0, 2);
    }
};