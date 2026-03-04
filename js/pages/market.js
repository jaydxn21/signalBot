import { SessionState } from '../nav.js';

const STATIC_MARKETS = [
    { symbol: 'BTC/USD',    price: 68412.50, change: +2.18, bars: [55,70,45,80,65,90,60,100] },
    { symbol: 'XAU/USD',    price: 2318.75,  change: -0.41, bars: [80,60,50,65,40,35,55,45]  },
    { symbol: 'EUR/USD',    price: 1.08412,  change: -0.12, bars: [65,72,55,48,60,52,44,40]  },
    { symbol: 'V100 Index', price: 9847.32,  change: +0.67, bars: [50,68,75,62,80,88,92,100] },
    { symbol: 'ETH/USD',    price: 3621.80,  change: +1.54, bars: [55,70,78,84,72,90,95,100] },
    { symbol: 'GBP/USD',    price: 1.26840,  change: +0.31, bars: [60,65,70,58,74,80,85,90]  },
    { symbol: 'V25 Index',  price: 4210.44,  change: -0.08, bars: [70,65,60,55,50,48,52,45]  },
    { symbol: 'V10 Index',  price: 1842.16,  change: +0.12, bars: [45,50,55,60,58,65,68,72]  },
    { symbol: 'V75 Index',  price: 6734.90,  change: +0.24, bars: [40,55,62,70,68,75,80,88]  },
];

let _liveData = {};

export const Market = {
    init() {
        _render();
        setInterval(_pollAndRender, 2000);
    },
};

function _pollAndRender() {
    const state = SessionState.get();
    if (state.livePrices && Object.keys(state.livePrices).length > 0) {
        _liveData = state.livePrices;
    }
    _render();
}

function _render() {
    const grid = document.getElementById('market-grid');
    if (!grid) return;

    const connected = SessionState.get().connected;
    const hasLive   = Object.keys(_liveData).length > 0;

    const banner = document.getElementById('market-status-banner');
    if (banner) {
        banner.textContent = connected
            ? '● Live prices — updating every 2s'
            : '○ Static prices — connect a bot on the Terminal for live data';
        banner.style.color = connected ? 'var(--accent2)' : 'var(--text-muted)';
    }

    const cards = hasLive ? _buildLiveCards() : STATIC_MARKETS;
    grid.innerHTML = cards.map(_cardHTML).join('');
}

function _buildLiveCards() {
    return Object.entries(_liveData).map(([symbol, data]) => ({
        symbol,
        price:  data.price,
        change: data.change || 0,
        bars:   data.bars || _fakeBars(data.change || 0),
    }));
}

function _fakeBars(change) {
    const up = change >= 0;
    return Array.from({ length: 8 }, (_, i) => {
        const base = up ? 40 + i * 8 : 80 - i * 8;
        return Math.max(15, Math.min(100, base + (Math.random() * 20 - 10)));
    });
}

function _cardHTML(c) {
    const up       = c.change >= 0;
    const badgeCls = up ? 'badge-up' : 'badge-down';
    const barCls   = up ? 'up' : 'down';
    const bars     = (c.bars || _fakeBars(c.change))
        .map(h => `<div class="mini-bar ${barCls}" style="height:${Math.round(h)}%"></div>`)
        .join('');
    const price    = c.price > 1000
        ? c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : c.price < 10 ? c.price.toFixed(5) : c.price.toFixed(2);

    return `
    <div class="market-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="mono" style="font-weight:500;font-size:0.78rem;color:var(--text-dark);">${c.symbol}</span>
            <span class="analytics-badge ${badgeCls}">${up ? '+' : ''}${c.change.toFixed(2)}%</span>
        </div>
        <div class="mono" style="font-size:1.35rem;font-weight:500;color:var(--text-dark);margin:4px 0 2px;">${price}</div>
        <div class="mini-bars" style="margin-top:8px;">${bars}</div>
    </div>`;
}