export class ChartEngine {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.chart = LightweightCharts.createChart(this.container, {
            layout: { background: { color: '#020617' }, textColor: '#94a3b8' },
            grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255, 255, 255, 0.05)' } },
            timeScale: { 
                timeVisible: true, 
                secondsVisible: true,
                timezone: 'UTC'
            }
        });
        
        this.candleSeries = this.chart.addCandlestickSeries({ 
            upColor: '#10b981', 
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981', 
            wickDownColor: '#ef4444'
        });

        this.priceLines = [];
        this.markers = [];
        
        this.setupResizeHandler();
    }

    getCandleSeries() {
        return this.candleSeries;
    }

    drawTradeLevels(sl, tp) {
        this.clearPriceLines();
        this.addPriceLine(sl, 'SL', '#ef4444');
        this.addPriceLine(tp, 'TP', '#10b981');
    }

    setupResizeHandler() {
        new ResizeObserver(() => {
            this.chart.applyOptions({ 
                width: this.container.clientWidth, 
                height: this.container.clientHeight 
            });
        }).observe(this.container);
    }

    setData(data) {
        this.candleSeries.setData(data);
        this.chart.timeScale().fitContent();
    }

    update(bar) {
        this.candleSeries.update(bar);
    }

    addMarker(time, type, label) {
        const marker = {
            time: time,
            position: type === 'BUY' ? 'belowBar' : 'aboveBar',
            color: type === 'BUY' ? '#10b981' : '#ef4444',
            shape: type === 'BUY' ? 'arrowUp' : 'arrowDown',
            text: label
        };
        this.markers.push(marker);
        this.candleSeries.setMarkers(this.markers);
    }

    clearMarkers() {
        this.markers = [];
        this.candleSeries.setMarkers(this.markers);
    }

    addPriceLine(price, label, color = '#ffffff') {
        const priceLine = this.candleSeries.createPriceLine({
            price: price,
            color: color,
            lineWidth: 2,
            axisLabelVisible: true,
            title: label
        });
        this.priceLines.push(priceLine);
    }

    clearPriceLines() {
        this.priceLines.forEach(priceLine => this.candleSeries.removePriceLine(priceLine));
        this.priceLines = [];
    }
}