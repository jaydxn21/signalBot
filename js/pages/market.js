// js/pages/market.js
// Live market watchlist — connects to Deriv WebSocket for real-time ticks.
// Handles: symbol categories, price feed, detail panel, "Open on Terminal" link.

// ─────────────────────────────────────────────────────────────────────────────
// SYMBOL CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORIES = {
    synthetic: [
        { sym: 'R_100',    name: 'Volatility 100',    dp: 2 },
        { sym: 'R_75',     name: 'Volatility 75',     dp: 2 },
        { sym: 'R_50',     name: 'Volatility 50',     dp: 2 },
        { sym: 'R_25',     name: 'Volatility 25',     dp: 3 },
        { sym: 'R_10',     name: 'Volatility 10',     dp: 3 },
        { sym: '1HZ100V',  name: 'Vol 100 (1s)',      dp: 2 },
        { sym: '1HZ75V',   name: 'Vol 75 (1s)',       dp: 2 },
        { sym: '1HZ50V',   name: 'Vol 50 (1s)',       dp: 2 },
        { sym: 'JD100',    name: 'Jump 100',          dp: 2 },
        { sym: 'JD75',     name: 'Jump 75',           dp: 2 },
        { sym: 'JD50',     name: 'Jump 50',           dp: 2 },
    ],
    forex: [
        { sym: 'frxEURUSD', name: 'EUR/USD', dp: 5 },
        { sym: 'frxGBPUSD', name: 'GBP/USD', dp: 5 },
        { sym: 'frxUSDJPY', name: 'USD/JPY', dp: 3 },
        { sym: 'frxAUDUSD', name: 'AUD/USD', dp: 5 },
        { sym: 'frxUSDCAD', name: 'USD/CAD', dp: 5 },
        { sym: 'frxUSDCHF', name: 'USD/CHF', dp: 5 },
        { sym: 'frxEURGBP', name: 'EUR/GBP', dp: 5 },
        { sym: 'frxGBPJPY', name: 'GBP/JPY', dp: 3 },
    ],
    crypto: [
        { sym: 'cryBTCUSD', name: 'BTC/USD', dp: 2 },
        { sym: 'cryETHUSD', name: 'ETH/USD', dp: 2 },
        { sym: 'cryLTCUSD', name: 'LTC/USD', dp: 2 },
        { sym: 'cryXRPUSD', name: 'XRP/USD', dp: 5 },
    ],
    metals: [
        { sym: 'frxXAUUSD', name: 'Gold (XAU/USD)',   dp: 2 },
        { sym: 'frxXAGUSD', name: 'Silver (XAG/USD)', dp: 3 },
    ],
};

// Symbols shown in the ticker bar (top picks across categories)
const TICKER_SYMS = ['R_100', 'R_75', 'frxEURUSD', 'frxGBPUSD', 'cryBTCUSD', 'frxXAUUSD'];

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let _ws         = null;
let _wsReady    = false;
let _activeCat  = 'synthetic';
let _focusSym   = null;
let _subIds     = {};   // sym → subscription_id
let _prices     = {};   // sym → { price, prevPrice, open, high, low, bid, ask, ticks:[] }
let _tickCounts = {};   // sym → count this minute
let _reconnectT = null;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────────────────────────────────────
export const Market = {
    init() {
        _buildTicker();
        _buildWatchlist();
        _wireCatTabs();
        _wireDetail();
        _connect();
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// DERIV WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
function _connect() {
    if (_ws) { try { _ws.close(); } catch(_) {} }
    _ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

    _ws.onopen = () => {
        _wsReady = true;
        _setBadge(true);
        _subscribeAll();
    };

    _ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        _handleMessage(msg);
    };

    _ws.onerror = () => { _setBadge(false); };

    _ws.onclose = () => {
        _wsReady = false;
        _setBadge(false);
        // Reconnect after 3s
        clearTimeout(_reconnectT);
        _reconnectT = setTimeout(_connect, 3000);
    };
}

function _subscribeAll() {
    // Subscribe to all symbols in current category + ticker symbols
    const allSyms = new Set(TICKER_SYMS);
    (CATEGORIES[_activeCat] || []).forEach(s => allSyms.add(s.sym));
    allSyms.forEach(sym => _subscribeSym(sym));
}

function _subscribeSym(sym) {
    if (!_wsReady || _subIds[sym]) return;
    _ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
}

function _unsubscribeOthers(keepSyms) {
    Object.entries(_subIds).forEach(([sym, id]) => {
        if (!keepSyms.has(sym)) {
            _ws.send(JSON.stringify({ forget: id }));
            delete _subIds[sym];
        }
    });
}

function _handleMessage(msg) {
    if (msg.error) return;

    if (msg.msg_type === 'tick') {
        const t = msg.tick;
        if (!t) return;
        const sym = t.symbol;

        // Store subscription id for cleanup
        if (msg.subscription?.id) _subIds[sym] = msg.subscription.id;

        const prev   = _prices[sym];
        const cat    = _allSymInfo(sym);
        const dp     = cat?.dp ?? 5;
        const price  = parseFloat(t.quote);
        const now    = Date.now();

        if (!prev) {
            _prices[sym] = {
                price, prevPrice: price,
                open: price, high: price, low: price,
                bid: price, ask: price,
                ticks: [], lastUpdate: now, dp,
            };
        } else {
            _prices[sym] = {
                ...prev,
                prevPrice: prev.price,
                price,
                high: Math.max(prev.high, price),
                low:  Math.min(prev.low,  price),
                bid: price - (price * 0.0001),
                ask: price + (price * 0.0001),
                ticks: [{ price, time: now }, ...prev.ticks].slice(0, 30),
                lastUpdate: now,
            };
        }

        // Track tick count per minute
        if (!_tickCounts[sym]) _tickCounts[sym] = { count: 0, reset: now + 60000 };
        if (now > _tickCounts[sym].reset) _tickCounts[sym] = { count: 1, reset: now + 60000 };
        else _tickCounts[sym].count++;

        // Update ticker bar if in ticker list
        if (TICKER_SYMS.includes(sym)) _updateTickerItem(sym);

        // Update watchlist row if visible
        _updateWatchRow(sym);

        // Update detail panel if focused
        if (_focusSym === sym) _updateDetail(sym);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKER BAR
// ─────────────────────────────────────────────────────────────────────────────
function _buildTicker() {
    const container = document.getElementById('ticker-items');
    if (!container) return;
    container.innerHTML = TICKER_SYMS.map((sym, i) => {
        const info = _allSymInfo(sym);
        return `
        ${i > 0 ? '<span class="ticker-sep">│</span>' : ''}
        <div class="ticker-item" id="ticker-${sym}">
            <span class="ticker-sym">${info?.name?.replace(' Index','') || sym}</span>
            <span class="ticker-price" id="tp-${sym}">—</span>
            <span class="ticker-chg" id="tc-${sym}">—</span>
        </div>`;
    }).join('');
}

function _updateTickerItem(sym) {
    const d = _prices[sym];
    if (!d) return;
    const priceEl = document.getElementById(`tp-${sym}`);
    const chgEl   = document.getElementById(`tc-${sym}`);
    if (priceEl) priceEl.textContent = d.price.toFixed(d.dp);
    if (chgEl) {
        const chg = ((d.price - d.open) / d.open * 100);
        chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
        chgEl.className = `ticker-chg ${chg >= 0 ? 'pos' : 'neg'}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────────────────────────────────────────
function _buildWatchlist() {
    const body = document.getElementById('watchlist-body');
    if (!body) return;
    const syms = CATEGORIES[_activeCat] || [];
    body.innerHTML = syms.map(({ sym, name }) => `
        <div class="watch-row" id="wr-${sym}" data-sym="${sym}" onclick="window._mktFocus('${sym}')">
            <div>
                <div class="watch-sym">${name}</div>
                <div class="watch-name">${sym}</div>
            </div>
            <div class="watch-price mono" id="wp-${sym}">—</div>
            <div class="watch-change" id="wc-${sym}">—</div>
            <div class="watch-spread" id="wsp-${sym}">—</div>
        </div>`).join('');

    // Subscribe new symbols
    const needed = new Set([...TICKER_SYMS, ...syms.map(s => s.sym)]);
    if (_wsReady) {
        _unsubscribeOthers(needed);
        syms.forEach(({ sym }) => _subscribeSym(sym));
    }

    // Focus first by default
    if (syms.length && !_focusSym) _setFocus(syms[0].sym);
}

function _updateWatchRow(sym) {
    const d = _prices[sym];
    if (!d) return;
    const priceEl  = document.getElementById(`wp-${sym}`);
    const chgEl    = document.getElementById(`wc-${sym}`);
    const spreadEl = document.getElementById(`wsp-${sym}`);
    const row      = document.getElementById(`wr-${sym}`);
    if (!row) return;

    const chg    = ((d.price - d.open) / d.open * 100);
    const spread = ((d.ask - d.bid) / d.price * 10000).toFixed(1);

    if (priceEl) {
        const dir = d.price > d.prevPrice ? 'up' : d.price < d.prevPrice ? 'down' : '';
        priceEl.textContent = d.price.toFixed(d.dp);
        if (dir) {
            priceEl.classList.remove('flash-up', 'flash-down');
            // force reflow
            void priceEl.offsetWidth;
            priceEl.classList.add(`flash-${dir}`);
        }
    }
    if (chgEl) {
        chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
        chgEl.className = `watch-change ${chg >= 0 ? 'pos' : 'neg'}`;
    }
    if (spreadEl) spreadEl.textContent = `${spread}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY TABS
// ─────────────────────────────────────────────────────────────────────────────
function _wireCatTabs() {
    document.getElementById('cat-tabs')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.cat-tab');
        if (!btn) return;
        document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeCat = btn.dataset.cat;
        _focusSym  = null;
        _buildWatchlist();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL PANEL
// ─────────────────────────────────────────────────────────────────────────────
function _wireDetail() {
    document.getElementById('btn-trade-this')?.addEventListener('click', () => {
        if (_focusSym) {
            // Pass symbol via sessionStorage so terminal can pre-select it
            sessionStorage.setItem('nexus_quick_sym', _focusSym);
            window.location.href = 'index.html';
        }
    });
}

function _setFocus(sym) {
    _focusSym = sym;
    // Highlight row
    document.querySelectorAll('.watch-row').forEach(r => r.classList.remove('active'));
    document.getElementById(`wr-${sym}`)?.classList.add('active');
    // Subscribe if not already
    _subscribeSym(sym);
    _updateDetail(sym);
}

window._mktFocus = _setFocus;

function _updateDetail(sym) {
    const d    = _prices[sym];
    const info = _allSymInfo(sym);
    const name = info?.name || sym;

    _set('detail-title', name);

    if (!d) {
        ['d-price','d-bidask','d-high','d-low','d-open','d-change','d-spread','d-ticks'].forEach(
            id => _set(id, '—')
        );
        return;
    }

    const chg    = ((d.price - d.open) / d.open * 100);
    const spread = ((d.ask - d.bid) / d.price * 10000).toFixed(1);
    const ticks  = _tickCounts[sym]?.count ?? 0;

    _set('d-price',  d.price.toFixed(d.dp));
    _set('d-bidask', `${d.bid.toFixed(d.dp)} / ${d.ask.toFixed(d.dp)}`);
    _set('d-high',   d.high.toFixed(d.dp));
    _set('d-low',    d.low.toFixed(d.dp));
    _set('d-open',   d.open.toFixed(d.dp));
    _set('d-spread', `${spread} pts`);
    _set('d-ticks',  `${ticks}/min`);

    const chgEl = document.getElementById('d-change');
    if (chgEl) {
        chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(4)}%`;
        chgEl.style.color = chg >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }

    // Tick tape
    const tape = document.getElementById('tick-tape');
    if (tape && d.ticks.length) {
        tape.innerHTML = d.ticks.map(t => {
            const time = new Date(t.time).toLocaleTimeString('en-GB', { hour12: false });
            return `<div style="color:var(--text-sub)">${time} <span style="color:var(--text-primary);font-weight:600">${t.price.toFixed(d.dp)}</span></div>`;
        }).join('');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _allSymInfo(sym) {
    for (const cat of Object.values(CATEGORIES)) {
        const found = cat.find(s => s.sym === sym);
        if (found) return found;
    }
    return null;
}

function _set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function _setBadge(live) {
    const badge = document.getElementById('ws-badge');
    const label = document.getElementById('ws-label');
    if (badge) badge.className = `ws-badge${live ? ' live' : ''}`;
    if (label) label.textContent = live ? 'Live' : 'Reconnecting…';
}