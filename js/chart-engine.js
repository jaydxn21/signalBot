/**
 * Enhanced Chart Engine v2.0
 * 
 * Features:
 * - Real-time candlestick charting
 * - 4-hour high/low levels visualization
 * - Multiple analysis overlays (SMA, EMA, ATR, Bollinger Bands, etc.)
 * - Trade entry/exit markers
 * - Price level visualization
 * - Responsive resizing
 * 
 * Usage:
 *   const engine = new ChartEngine('chart-container');
 *   engine.setData(candleData);
 *   engine.drawH4Levels(h4Candles);
 *   engine.drawAnalysis({ sma: true, ema: true, atr: true });
 */

export class ChartEngine {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`Chart container "${containerId}" not found`);
            return;
        }

        this.chart = LightweightCharts.createChart(this.container, {
            layout: {
                background: { color: 'transparent' },
                textColor:  '#64748b',
                fontSize:   11,
                fontFamily: "'DM Mono', monospace",
            },
            grid: {
                vertLines: { color: 'rgba(148,163,184,0.12)' },
                horzLines: { color: 'rgba(148,163,184,0.12)' },
            },
            crosshair: {
                vertLine: { color: 'rgba(37,99,235,0.4)', labelBackgroundColor: '#2563eb' },
                horzLine: { color: 'rgba(37,99,235,0.4)', labelBackgroundColor: '#2563eb' },
            },
            timeScale: {
                timeVisible:    true,
                secondsVisible: false,
                timezone:       'America/Jamaica',
                borderColor:    'rgba(148,163,184,0.2)',
            },
            rightPriceScale: {
                borderColor: 'rgba(148,163,184,0.2)',
            },
            handleScroll: true,
            handleScale:  true,
        });

        // Primary candle series
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor:       '#10b981',
            downColor:     '#ef4444',
            borderVisible: false,
            wickUpColor:   '#10b981',
            wickDownColor: '#ef4444',
        });

        // Analysis series (lazily created)
        this.analysisSeries = {};
        
        // Visual elements
        this.priceLines = [];
        this._h4Lines   = [];
        this.markers    = [];
        this.h4Levels   = { high: null, low: null };  // Track current H4 levels
        this.analysisState = {};  // Track which overlays are active

        this._setupResizeHandler();
    }

    // ─────────────────────────────────────────────────────────────
    // CORE METHODS (Original API)
    // ─────────────────────────────────────────────────────────────

    getCandleSeries() { 
        return this.candleSeries; 
    }

    setData(data) {
        if (!data || !Array.isArray(data) || data.length === 0) {
            console.warn('[ChartEngine] Invalid or empty data passed to setData');
            return;
        }

        // 1. Sanitize & convert timestamps to UNIX Seconds
        const formatted = data.map(c => {
            let rawTime = c.time || c.epoch;
            if (typeof rawTime === 'string') rawTime = Math.floor(Date.parse(rawTime) / 1000);
            if (rawTime > 10000000000) rawTime = Math.floor(rawTime / 1000); // ms to sec

            return {
                time:  rawTime,
                open:  parseFloat(c.open),
                high:  parseFloat(c.high),
                low:   parseFloat(c.low),
                close: parseFloat(c.close)
            };
        });

        // 2. Sort ascending (oldest -> newest)
        formatted.sort((a, b) => a.time - b.time);

        // 3. Remove duplicate timestamps
        const cleanData = formatted.filter((candle, index, self) =>
            index === 0 || candle.time > self[index - 1].time
        );

        // 4. Pass clean array to Lightweight Charts
        this.candleSeries.setData(cleanData);
        this.chart.timeScale().fitContent();

        const ph = document.getElementById('chart-placeholder');
        if (ph) ph.style.display = 'none';

        console.log(`[ChartEngine] Rendered ${cleanData.length} valid candles.`);
    }

    update(bar) { 
        if (bar) {
            this.candleSeries.update(bar);
        }
    }

    addMarker(time, type, label) {
        this.markers.push({
            time,
            position: type === 'BUY' ? 'belowBar'  : 'aboveBar',
            color:    type === 'BUY' ? '#10b981'   : '#ef4444',
            shape:    type === 'BUY' ? 'arrowUp'   : 'arrowDown',
            text:     label,
        });
        this.candleSeries.setMarkers(this.markers);
    }

    clearMarkers() {
        this.markers = [];
        this.candleSeries.setMarkers([]);
    }

    addPriceLine(price, label, color = '#2563eb') {
        const line = this.candleSeries.createPriceLine({
            price,
            color,
            lineWidth:        2,
            lineStyle:        LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title:            label,
        });
        this.priceLines.push(line);
        return line;
    }

    drawTradeLevels(sl, tp) {
        this.clearPriceLines();
        this.addPriceLine(sl, 'SL', '#ef4444');
        this.addPriceLine(tp, 'TP', '#10b981');
    }

    clearPriceLines() {
        this.priceLines.forEach(l => { 
            try { this.candleSeries.removePriceLine(l); } 
            catch(e) {} 
        });
        this.priceLines = [];
    }

    clearAll() {
        this.clearMarkers();
        this.clearPriceLines();
        this._clearH4Levels();
        this.clearAnalysis();
        this.candleSeries.setData([]);
        const ph = document.getElementById('chart-placeholder');
        if (ph) ph.style.display = 'flex';
    }

    // ─────────────────────────────────────────────────────────────
    // 4-HOUR HIGH/LOW LEVELS
    // ─────────────────────────────────────────────────────────────

    /**
     * Draw 4-hour high/low levels as horizontal lines with labels
     * @param {Array} h4Candles - Array of 4-hour candles with {time, open, high, low, close}
     */
    drawH4Levels(h4Candles) {
        if (!h4Candles || h4Candles.length === 0) {
            console.warn('No 4-hour candles provided');
            return;
        }

        // Get the most recent 4-hour candle
        const latestH4 = h4Candles[h4Candles.length - 1];
        if (!latestH4) return;

        // Calculate the high/low from the entire 4-hour candle
        const h4High = latestH4.high;
        const h4Low  = latestH4.low;

        // Clear previous H4 levels
        this._clearH4Levels();

        // Draw as solid lines (not dashed like trade levels)
        const highLine = this.candleSeries.createPriceLine({
            price:              h4High,
            color:              '#8b5cf6',  // Purple
            lineWidth:          2,
            lineStyle:          LightweightCharts.LineStyle.Solid,
            axisLabelVisible:   true,
            title:              '4H High',
        });

        const lowLine = this.candleSeries.createPriceLine({
            price:              h4Low,
            color:              '#f59e0b',  // Amber
            lineWidth:          2,
            lineStyle:          LightweightCharts.LineStyle.Solid,
            axisLabelVisible:   true,
            title:              '4H Low',
        });

        // Store for cleanup
        this._h4Lines = [highLine, lowLine];
        this.h4Levels = { high: h4High, low: h4Low, time: latestH4.time };
        this.analysisState.h4Levels = true;

        console.log(`[Chart] H4 Levels: High=${h4High.toFixed(4)}, Low=${h4Low.toFixed(4)}`);
    }

    _clearH4Levels() {
        (this._h4Lines || []).forEach(l => {
            try { this.candleSeries.removePriceLine(l); }
            catch(e) {}
        });
        this._h4Lines = [];
        this.analysisState.h4Levels = false;
    }

    // ─────────────────────────────────────────────────────────────
    // TECHNICAL ANALYSIS OVERLAYS
    // ─────────────────────────────────────────────────────────────

    /**
     * Draw multiple analysis overlays on the chart
     * @param {Object} options - Configuration for which overlays to show
     * @example
     *   engine.drawAnalysis({
     *     sma: { periods: 20, color: '#2563eb' },
     *     ema: { periods: 9, color: '#059669' },
     *     atr: true,
     *     bollingerBands: { periods: 20, stdDev: 2 },
     *     rsi: true
     *   });
     */
    drawAnalysis(options = {}) {
        const candles = this.candleSeries.data() || [];
        if (candles.length === 0) {
            console.warn('No candle data available for analysis');
            return;
        }

        // SMA (Simple Moving Average)
        if (options.sma) {
            const smaConfig = typeof options.sma === 'object' ? options.sma : { periods: 20 };
            this._drawSMA(candles, smaConfig);
        }

        // EMA (Exponential Moving Average)
        if (options.ema) {
            const emaConfig = typeof options.ema === 'object' ? options.ema : { periods: 9 };
            this._drawEMA(candles, emaConfig);
        }

        // ATR (Average True Range) - drawn as a volatility band
        if (options.atr) {
            const atrConfig = typeof options.atr === 'object' ? options.atr : { periods: 14 };
            this._drawATR(candles, atrConfig);
        }

        // Bollinger Bands
        if (options.bollingerBands) {
            const bbConfig = typeof options.bollingerBands === 'object' 
                ? options.bollingerBands 
                : { periods: 20, stdDev: 2 };
            this._drawBollingerBands(candles, bbConfig);
        }

        // Volume Profile (simple version)
        if (options.volumeProfile) {
            this._drawVolumeProfile(candles);
        }
    }

    /**
     * Draw Simple Moving Average
     */
    _drawSMA(candles, config) {
        const { periods = 20, color = '#2563eb' } = config;
        const smaData = this._calculateSMA(candles, periods);

        if (!this.analysisSeries.sma) {
            this.analysisSeries.sma = this.chart.addLineSeries({
                color,
                lineWidth: 2,
                title: `SMA${periods}`,
            });
        }

        this.analysisSeries.sma.setData(smaData);
        this.analysisState.sma = true;
    }

    /**
     * Draw Exponential Moving Average
     */
    _drawEMA(candles, config) {
        const { periods = 9, color = '#059669' } = config;
        const emaData = this._calculateEMA(candles, periods);

        if (!this.analysisSeries.ema) {
            this.analysisSeries.ema = this.chart.addLineSeries({
                color,
                lineWidth: 2,
                title: `EMA${periods}`,
            });
        }

        this.analysisSeries.ema.setData(emaData);
        this.analysisState.ema = true;
    }

    /**
     * Draw Average True Range as a volatility indicator
     */
    _drawATR(candles, config) {
        const { periods = 14, color = '#f59e0b' } = config;
        const atrData = this._calculateATR(candles, periods);

        if (!this.analysisSeries.atr) {
            this.analysisSeries.atr = this.chart.addAreaSeries({
                lineColor:           color,
                topColor:            color + '33',  // 20% opacity
                bottomColor:         color + '11',  // 7% opacity
                lineWidth:           1,
                title:               `ATR${periods}`,
            });
        }

        this.analysisSeries.atr.setData(atrData);
        this.analysisState.atr = true;
    }

    /**
     * Draw Bollinger Bands
     */
    _drawBollingerBands(candles, config) {
        const { periods = 20, stdDev = 2 } = config;
        const { upper, middle, lower } = this._calculateBollingerBands(candles, periods, stdDev);

        // Upper band
        if (!this.analysisSeries.bbUpper) {
            this.analysisSeries.bbUpper = this.chart.addLineSeries({
                color: '#8b5cf6',
                lineWidth: 1,
                title: 'BB Upper',
            });
        }
        this.analysisSeries.bbUpper.setData(upper);

        // Middle band (SMA)
        if (!this.analysisSeries.bbMiddle) {
            this.analysisSeries.bbMiddle = this.chart.addLineSeries({
                color: '#8b5cf6',
                lineWidth: 2,
                title: 'BB Middle',
            });
        }
        this.analysisSeries.bbMiddle.setData(middle);

        // Lower band
        if (!this.analysisSeries.bbLower) {
            this.analysisSeries.bbLower = this.chart.addLineSeries({
                color: '#8b5cf6',
                lineWidth: 1,
                title: 'BB Lower',
            });
        }
        this.analysisSeries.bbLower.setData(lower);

        this.analysisState.bollingerBands = true;
    }

    /**
     * Draw simple volume profile
     */
    _drawVolumeProfile(candles) {
        // This is a simplified version - a full volume profile would be more complex
        const profileData = candles.map(c => ({
            time: c.time,
            value: (c.high - c.low) * 1000  // Proxy for activity
        }));

        if (!this.analysisSeries.volume) {
            this.analysisSeries.volume = this.chart.addHistogramSeries({
                color: '#3b82f633',
                title: 'Volume Profile',
            });
        }

        this.analysisSeries.volume.setData(profileData);
        this.analysisState.volumeProfile = true;
    }

    /**
     * Clear all analysis overlays
     */
    clearAnalysis() {
        Object.values(this.analysisSeries).forEach(series => {
            try { this.chart.removeSeries(series); } 
            catch(e) {}
        });
        this.analysisSeries = {};
        this.analysisState = {};
    }

    // ─────────────────────────────────────────────────────────────
    // CALCULATION HELPERS
    // ─────────────────────────────────────────────────────────────

    _calculateSMA(candles, periods) {
        const result = [];
        for (let i = 0; i < candles.length; i++) {
            if (i < periods - 1) continue;
            const slice = candles.slice(i - periods + 1, i + 1);
            const avg = slice.reduce((sum, c) => sum + c.close, 0) / periods;
            result.push({ time: candles[i].time, value: avg });
        }
        return result;
    }

    _calculateEMA(candles, periods) {
        const result = [];
        const k = 2 / (periods + 1);
        let ema = null;

        for (let i = 0; i < candles.length; i++) {
            if (ema === null) {
                if (i === periods - 1) {
                    const slice = candles.slice(0, periods);
                    ema = slice.reduce((sum, c) => sum + c.close, 0) / periods;
                } else {
                    continue;
                }
            } else {
                ema = candles[i].close * k + ema * (1 - k);
            }
            result.push({ time: candles[i].time, value: ema });
        }
        return result;
    }

    _calculateATR(candles, periods) {
        const result = [];
        const trues = [];

        for (let i = 0; i < candles.length; i++) {
            const current = candles[i];
            const previous = i > 0 ? candles[i - 1] : null;

            let tr;
            if (!previous) {
                tr = current.high - current.low;
            } else {
                tr = Math.max(
                    current.high - current.low,
                    Math.abs(current.high - previous.close),
                    Math.abs(current.low - previous.close)
                );
            }

            trues.push(tr);

            if (trues.length < periods) continue;

            if (trues.length === periods) {
                const atr = trues.reduce((a, b) => a + b) / periods;
                result.push({ time: current.time, value: atr });
            } else {
                const prevATR = result[result.length - 1].value;
                const atr = (prevATR * (periods - 1) + tr) / periods;
                result.push({ time: current.time, value: atr });
            }
        }
        return result;
    }

    _calculateBollingerBands(candles, periods, stdDev) {
        const sma = this._calculateSMA(candles, periods);
        const upper = [];
        const middle = [];
        const lower = [];

        for (let i = 0; i < sma.length; i++) {
            const smaPoint = sma[i];

            // Fix: Compare explicit numerical value instead of raw object references
            const candleIndex = candles.findIndex(c => Number(c.time) === Number(smaPoint.time));
            
            if (candleIndex === -1) continue;

            const slice = candles.slice(Math.max(0, candleIndex - periods + 1), candleIndex + 1);
            const mean = slice.reduce((sum, c) => sum + c.close, 0) / slice.length;
            const variance = slice.reduce((sum, c) => sum + Math.pow(c.close - mean, 2), 0) / slice.length;
            const std = Math.sqrt(variance);

            const centerValue = smaPoint.value;
            const offset = std * stdDev;

            upper.push({ time: smaPoint.time, value: centerValue + offset });
            middle.push({ time: smaPoint.time, value: centerValue });
            lower.push({ time: smaPoint.time, value: centerValue - offset });
        }

        return { upper, middle, lower };
    }

    // ─────────────────────────────────────────────────────────────
    // UTILITIES
    // ─────────────────────────────────────────────────────────────

    _setupResizeHandler() {
        new ResizeObserver(() => {
            if (!this.container) return;
            this.chart.applyOptions({
                width:  this.container.clientWidth,
                height: this.container.clientHeight,
            });
        }).observe(this.container);
    }

    /**
     * Get current analysis state
     */
    getAnalysisState() {
        return { ...this.analysisState };
    }

    /**
     * Get current H4 levels
     */
    getH4Levels() {
        return { ...this.h4Levels };
    }

    /**
     * Fit chart to content
     */
    fitContent() {
        this.chart.timeScale().fitContent();
    }

    /**
     * Get raw chart instance for advanced operations
     */
    getChart() {
        return this.chart;
    }
}