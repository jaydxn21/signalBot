export class ChartEngine {
    constructor(containerId) {
        this.container = document.getElementById(containerId);

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
                timezone:       'UTC',
                borderColor:    'rgba(148,163,184,0.2)',
            },
            rightPriceScale: {
                borderColor: 'rgba(148,163,184,0.2)',
            },
            handleScroll: true,
            handleScale:  true,
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor:       '#10b981',
            downColor:     '#ef4444',
            borderVisible: false,
            wickUpColor:   '#10b981',
            wickDownColor: '#ef4444',
        });

        this.priceLines = [];
        this.markers    = [];
        this._setupResizeHandler();
    }

    getCandleSeries() { return this.candleSeries; }

    setData(data) {
        this.candleSeries.setData(data);
        this.chart.timeScale().fitContent();
        const ph = document.getElementById('chart-placeholder');
        if (ph) ph.style.display = 'none';
    }

    update(bar) { this.candleSeries.update(bar); }

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
        this.priceLines.forEach(l => { try { this.candleSeries.removePriceLine(l); } catch(e) {} });
        this.priceLines = [];
    }

    clearAll() {
        this.clearMarkers();
        this.clearPriceLines();
        this.candleSeries.setData([]);
        const ph = document.getElementById('chart-placeholder');
        if (ph) ph.style.display = 'flex';
    }

    _setupResizeHandler() {
        new ResizeObserver(() => {
            if (!this.container) return;
            this.chart.applyOptions({
                width:  this.container.clientWidth,
                height: this.container.clientHeight,
            });
        }).observe(this.container);
    }
}