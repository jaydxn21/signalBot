// js/overlays.js — NEXUS chart overlays
// Uses LightweightCharts v4 price lines for lines.
// Uses transparent area series bands for boxes (FVG, Order Blocks).
// Each draw function returns cleanup handles stored in _state.

const JA_OFFSET = 5 * 3600;

function _jaMidnightUTC(ts) {
    const ja  = ts - JA_OFFSET;
    const mid = ja - (ja % 86400);
    return mid + JA_OFFSET;
}

function _calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = candles.slice(1).map((c, i) =>
        Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
    );
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─────────────────────────────────────────────────────────────
// STATE — per chart instance
// We store cleanup refs keyed by series object
// ─────────────────────────────────────────────────────────────
// Keyed by chartEngine instance — stable across redraws
const _engineState = new WeakMap();

function _getState(engineOrSeries) {
    if (!_engineState.has(engineOrSeries)) {
        _engineState.set(engineOrSeries, { lines: [], bands: [] });
    }
    return _engineState.get(engineOrSeries);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _line(series, price, title, color, style = 2, width = 1, engineKey) {
    if (!price || isNaN(price)) return;
    try {
        const l = series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
        _getState(engineKey || series).lines.push(l);
    } catch(e) {}
}

// Draw a transparent box between topPrice and bottomPrice.
// Uses a BaselineSeries which natively fills between two price levels.
function _box(chart, topPrice, bottomPrice, fillColor, borderColor) {
    if (!chart || !topPrice || !bottomPrice) return null;
    try {
        const t1 = 1000000000;
        const t2 = 2000000000;

        // Baseline series: fills between baseValue (bottom) and line (top)
        const baseline = chart.addBaselineSeries({
            baseValue:              { type: 'price', price: bottomPrice },
            topLineColor:           borderColor,
            topFillColor1:          fillColor,
            topFillColor2:          fillColor,
            bottomLineColor:        'transparent',
            bottomFillColor1:       'transparent',
            bottomFillColor2:       'transparent',
            lineWidth:              1,
            priceLineVisible:       false,
            lastValueVisible:       false,
            crosshairMarkerVisible: false,
        });
        baseline.setData([
            { time: t1, value: topPrice },
            { time: t2, value: topPrice },
        ]);

        // Bottom border line
        const bot = chart.addLineSeries({
            color:                  borderColor,
            lineWidth:              1,
            lineStyle:              0,
            priceLineVisible:       false,
            lastValueVisible:       false,
            crosshairMarkerVisible: false,
        });
        bot.setData([
            { time: t1, value: bottomPrice },
            { time: t2, value: bottomPrice },
        ]);

        return [baseline, bot];
    } catch(e) {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
export const OverlayManager = {

    // chartEngine = the ChartEngine instance (has .chart and .getCandleSeries())
    clearAll(series, chartEngine) {
        // Use chartEngine as the stable key if available, else series
        const key = chartEngine || series;
        const st  = _getState(key);
        st.lines.forEach(l => { try { series.removePriceLine(l); } catch(e) {} });
        st.lines = [];
        if (chartEngine) {
            st.bands.forEach(s => { try { chartEngine.chart.removeSeries(s); } catch(e) {} });
        }
        st.bands = [];
    },

    // ── ASIAN RANGE ────────────────────────────────────────────
    drawAsianRange(series, candles) {
        if (!candles?.length) return;
        const now        = candles[candles.length - 1].time;
        const jaMid      = _jaMidnightUTC(now);
        const asianStart = jaMid - JA_OFFSET + 4 * 3600;
        const asianEnd   = asianStart + 8 * 3600;
        const sess       = candles.filter(c => c.time >= asianStart && c.time < asianEnd);
        if (sess.length < 3) return;
        const h = Math.max(...sess.map(c => c.high));
        const l = Math.min(...sess.map(c => c.low));
        _line(series, h, 'Asia H', 'rgba(168,85,247,0.75)', 2, 1);
        _line(series, l, 'Asia L', 'rgba(168,85,247,0.75)', 2, 1);
    },

    // ── PDH / PDL ──────────────────────────────────────────────
    drawPDHPDL(series, h4Candles) {
        if (!h4Candles?.length) return;
        const now   = h4Candles[h4Candles.length - 1].time;
        const today = _jaMidnightUTC(now);
        const prev  = h4Candles.filter(c => c.time >= today - 86400 && c.time < today);
        if (prev.length < 2) return;
        _line(series, Math.max(...prev.map(c => c.high)), 'PDH', 'rgba(251,146,60,0.85)', 3, 1);
        _line(series, Math.min(...prev.map(c => c.low)),  'PDL', 'rgba(251,146,60,0.85)', 3, 1);
    },

    // ── FAIR VALUE GAPS — drawn as transparent BOXES ───────────
    drawFVG(series, candles, chartEngine) {
        if (!candles || candles.length < 3 || !chartEngine) return;
        const recent = candles.slice(-80);
        const found  = [];

        for (let i = 1; i < recent.length - 1; i++) {
            const c1 = recent[i - 1], c3 = recent[i + 1];
            if (c3.low > c1.high) {
                found.push({ top: c3.low, bot: c1.high, type: 'bull' });
            }
            if (c3.high < c1.low) {
                found.push({ top: c1.low, bot: c3.high, type: 'bear' });
            }
        }

        const last = candles[candles.length - 1];

        // Keep only most recent unfilled FVG of each type (1 bull, 1 bear)
        const bullFVG = found.filter(f => f.type === 'bull' && last.low <= f.top && last.high >= f.bot).slice(-1)[0];
        const bearFVG = found.filter(f => f.type === 'bear' && last.high >= f.bot && last.low <= f.top).slice(-1)[0];

        [bullFVG, bearFVG].filter(Boolean).forEach(({ top, bot, type }) => {
            const fill   = type === 'bull' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
            const border = type === 'bull' ? 'rgba(16,185,129,0.6)'  : 'rgba(239,68,68,0.6)';
            const label  = type === 'bull' ? 'FVG ↑' : 'FVG ↓';

            _line(series, top, label, border, 0, 1);
            _line(series, bot, '',    border, 0, 1);

            const refs = _box(chartEngine.chart, top, bot, fill, border);
            if (refs) _getState(chartEngine || series).bands.push(...refs);
        });
    },

    // ── H4 KISS ────────────────────────────────────────────────
    drawH4Kiss(series, h4Candles) {
        if (!h4Candles || h4Candles.length < 21) return;
        const k = 2 / 22;
        let ema = h4Candles.slice(0, 21).reduce((s, c) => s + c.close, 0) / 21;
        for (let i = 21; i < h4Candles.length; i++) ema = h4Candles[i].close * k + ema * (1 - k);
        _line(series, ema, 'H4 EMA21', 'rgba(37,99,235,0.7)', 2, 1);
    },

    // ── SUPPLY & DEMAND (multi-timeframe S/R) ──────────────────
    // Draws 3 types:
    //   • Recent swing S/R from last 50 bars (closest levels to price)
    //   • Key daily levels (highest-tested swings from last 200 bars)
    //   • EMA8 and EMA21 dynamic levels on the current TF
    drawMajorSR(series, candles) {
        if (!candles || candles.length < 20) return;

        const atr       = _calcATR(candles, 14) || 0.001;
        const tolerance = atr * 0.4;
        const last      = candles[candles.length - 1];

        // ── EMA8 and EMA21 dynamic S/R ────────────────────────
        if (candles.length >= 21) {
            const ema8  = _ema(candles, 8);
            const ema21 = _ema(candles, 21);
            _line(series, ema8,  'EMA8',  'rgba(234,179,8,0.7)',   0, 1);
            _line(series, ema21, 'EMA21', 'rgba(249,115,22,0.7)',  0, 1);
        }

        // ── Swing highs/lows from last 200 bars ───────────────
        const lookback = Math.min(candles.length, 200);
        const slice    = candles.slice(-lookback);
        const levels   = [];

        for (let i = 3; i < slice.length - 3; i++) {
            const c = slice[i];
            const isH = [1,2,3].every(d => c.high >= slice[i-d].high && c.high >= slice[i+d].high);
            const isL = [1,2,3].every(d => c.low  <= slice[i-d].low  && c.low  <= slice[i+d].low);
            if (isH) levels.push({ price: c.high, type: 'R', idx: i });
            if (isL) levels.push({ price: c.low,  type: 'S', idx: i });
        }

        // Cluster nearby levels
        const clusters = [];
        levels.forEach(l => {
            const ex = clusters.find(c => Math.abs(c.price - l.price) < tolerance);
            if (ex) { ex.count++; ex.price = (ex.price + l.price) / 2; }
            else clusters.push({ ...l, count: 1 });
        });

        // Draw closest levels above and below current price (max 3 each)
        const above = clusters.filter(c => c.price > last.close).sort((a, b) => a.price - b.price).slice(0, 3);
        const below = clusters.filter(c => c.price < last.close).sort((a, b) => b.price - a.price).slice(0, 3);

        [...above, ...below].forEach(({ price, type, count }) => {
            const color = type === 'R' ? 'rgba(239,68,68,0.6)' : 'rgba(16,185,129,0.6)';
            const label = `${type}${count > 1 ? count : ''}`;
            _line(series, price, label, color, count >= 3 ? 0 : 2, count >= 3 ? 2 : 1);
        });
    },

    // ── ORB ────────────────────────────────────────────────────
    drawORBRange(series, candles) {
        if (!candles?.length) return;
        const now      = candles[candles.length - 1].time;
        const jaMid    = _jaMidnightUTC(now);
        const orbStart = jaMid + 9 * 3600 + 1800;
        const orbEnd   = orbStart + 1800;
        const orb      = candles.filter(c => c.time >= orbStart && c.time < orbEnd);
        if (orb.length < 2) return;
        _line(series, Math.max(...orb.map(c => c.high)), 'ORB H', 'rgba(234,179,8,0.8)', 3, 1);
        _line(series, Math.min(...orb.map(c => c.low)),  'ORB L', 'rgba(234,179,8,0.8)', 3, 1);
    },

    // ── ORDER BLOCKS — drawn as transparent BOXES ──────────────
    // Bullish OB: last bearish candle before a strong 3-candle bull impulse
    // Bearish OB: last bullish candle before a strong 3-candle bear impulse
    // Hard cap: 1 most recent unmitigated bull OB, 1 bear OB
    drawOrderBlocks(series, candles, chartEngine) {
        if (!candles || candles.length < 15 || !chartEngine) return;

        const atr    = _calcATR(candles, 14) || 0.001;
        const recent = candles.slice(-120);
        const bullOBs = [];
        const bearOBs = [];

        for (let i = 1; i < recent.length - 4; i++) {
            const c  = recent[i];
            const n1 = recent[i + 1];
            const n2 = recent[i + 2];
            const n3 = recent[i + 3];

            // Bullish OB: clearly bearish body + strong 3-bar bull follow-through
            const isClearBear  = (c.open - c.close) > atr * 0.3;
            const bullThrust   = n1.close > n1.open && n2.close > n2.open
                              && (n2.close - c.low) > atr * 2.5;
            if (isClearBear && bullThrust) {
                bullOBs.push({
                    top:     Math.max(c.open, c.close),
                    bot:     c.low,   // use wick low as zone bottom
                    type:    'bull',
                });
            }

            // Bearish OB: clearly bullish body + strong 3-bar bear follow-through
            const isClearBull  = (c.close - c.open) > atr * 0.3;
            const bearThrust   = n1.close < n1.open && n2.close < n2.open
                              && (c.high - n2.close) > atr * 2.5;
            if (isClearBull && bearThrust) {
                bearOBs.push({
                    top:     c.high,  // use wick high as zone top
                    bot:     Math.min(c.open, c.close),
                    type:    'bear',
                });
            }
        }

        const last = candles[candles.length - 1];

        // Only most recent UNMITIGATED block of each type (price hasn't closed inside it)
        const bullOB = bullOBs.filter(o => last.close > o.top).slice(-1)[0];
        const bearOB = bearOBs.filter(o => last.close < o.bot).slice(-1)[0];

        if (bullOB) {
            _line(series, bullOB.top, 'Bull OB', 'rgba(16,185,129,0.9)', 0, 1);
            _line(series, bullOB.bot, '',         'rgba(16,185,129,0.5)', 2, 1);
            const refs = _box(chartEngine.chart, bullOB.top, bullOB.bot,
                'rgba(16,185,129,0.10)', 'rgba(16,185,129,0.6)');
            if (refs) _getState(chartEngine || series).bands.push(...refs);
        }

        if (bearOB) {
            _line(series, bearOB.top, '',         'rgba(239,68,68,0.5)', 2, 1);
            _line(series, bearOB.bot, 'Bear OB',  'rgba(239,68,68,0.9)', 0, 1);
            const refs = _box(chartEngine.chart, bearOB.top, bearOB.bot,
                'rgba(239,68,68,0.10)', 'rgba(239,68,68,0.6)');
            if (refs) _getState(chartEngine || series).bands.push(...refs);
        }
    },

    // ── LIQUIDITY SWEEPS (stop hunt lines) ─────────────────────
    // Detects when price wicks above a prior swing high then closes back below (bear sweep)
    // or below a prior swing low then closes back above (bull sweep)
    drawBreakOfStructure(series, candles) {
        if (!candles || candles.length < 20) return;

        const recent = candles.slice(-60);
        const atr    = _calcATR(candles, 14) || 0.001;
        const sweeps = [];

        for (let i = 4; i < recent.length - 1; i++) {
            const c = recent[i];

            // Find highest high in the 10 bars before this candle
            const priorHighs = recent.slice(Math.max(0, i - 10), i);
            const priorLows  = recent.slice(Math.max(0, i - 10), i);
            const swHigh = Math.max(...priorHighs.map(x => x.high));
            const swLow  = Math.min(...priorLows.map(x => x.low));

            // Bull sweep: wick below prior low, closes back above
            if (c.low < swLow - atr * 0.1 && c.close > swLow) {
                sweeps.push({ price: swLow, type: 'bull', label: 'Liq ↑' });
            }
            // Bear sweep: wick above prior high, closes back below
            if (c.high > swHigh + atr * 0.1 && c.close < swHigh) {
                sweeps.push({ price: swHigh, type: 'bear', label: 'Liq ↓' });
            }
        }

        // Draw 3 most recent sweeps as solid lines
        sweeps.slice(-3).forEach(({ price, type, label }) => {
            const color = type === 'bull' ? 'rgba(16,185,129,0.9)' : 'rgba(239,68,68,0.9)';
            _line(series, price, label, color, 0, 2);
        });

        // Also draw current BOS level — the last broken structure point
        const last = recent[recent.length - 1];
        let bosHigh = null, bosLow = null;

        for (let i = recent.length - 5; i >= 3; i--) {
            const c = recent[i];
            if (!bosHigh && c.high > recent[i-1].high && c.high > recent[i-2].high
                         && c.high > recent[i+1]?.high && c.high > recent[i+2]?.high) {
                bosHigh = c.high;
            }
            if (!bosLow && c.low < recent[i-1].low && c.low < recent[i-2].low
                        && c.low < recent[i+1]?.low && c.low < recent[i+2]?.low) {
                bosLow = c.low;
            }
            if (bosHigh && bosLow) break;
        }

        if (bosHigh && last.close > bosHigh) {
            _line(series, bosHigh, 'BOS ↑', 'rgba(16,185,129,1.0)', 0, 2);
        }
        if (bosLow && last.close < bosLow) {
            _line(series, bosLow, 'BOS ↓', 'rgba(239,68,68,1.0)', 0, 2);
        }
    },
};

// ── EMA helper ────────────────────────────────────────────────
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) e = candles[i].close * k + e * (1 - k);
    return e;
}