// js/pages/journal.js
// Owns everything on the Journal page.
// Reads trade history from SessionState (written by signal-bot.js).
// Handles: render table, filter by symbol/strategy/outcome, CSV export.

import { SessionState } from '../session-state.js';

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const filters = {
    symbol:   'all',
    strategy: 'all',
    outcome:  'all',
};

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
export const Journal = {

    async init() {
        // Pull trades recorded on other devices before the first render.
        await SessionState.hydrateFromCloud();

        _buildFilters();
        _wireFilters();
        _wireExport();
        _wireClear();
        _render();

        // Re-render every 5 seconds to pick up new trades from the terminal
        setInterval(_render, 5000);
    },
};

// ─────────────────────────────────────────────────────────────
// FILTERS
// ─────────────────────────────────────────────────────────────
function _buildFilters() {
    const trades = SessionState.get().trades;

    // Collect unique symbols and strategies from actual trades
    const symbols    = ['all', ...new Set(trades.map(t => t.symbol).filter(Boolean))];
    const strategies = ['all', ...new Set(trades.map(t => t.strategy).filter(Boolean))];

    _populateSelect('filter-symbol',   symbols,    s => s === 'all' ? 'All Symbols'    : s);
    _populateSelect('filter-strategy', strategies, s => s === 'all' ? 'All Strategies' : s);
}

function _populateSelect(id, values, labelFn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = values.map(v =>
        `<option value="${v}">${labelFn(v)}</option>`
    ).join('');
}

function _wireFilters() {
    document.getElementById('filter-symbol')?.addEventListener('change', e => {
        filters.symbol = e.target.value;
        _render();
    });
    document.getElementById('filter-strategy')?.addEventListener('change', e => {
        filters.strategy = e.target.value;
        _render();
    });
    document.getElementById('filter-outcome')?.addEventListener('change', e => {
        filters.outcome = e.target.value;
        _render();
    });
    document.getElementById('filter-clear')?.addEventListener('click', () => {
        filters.symbol = filters.strategy = filters.outcome = 'all';
        document.getElementById('filter-symbol').value   = 'all';
        document.getElementById('filter-strategy').value = 'all';
        document.getElementById('filter-outcome').value  = 'all';
        _render();
    });
}

// ─────────────────────────────────────────────────────────────
// RENDER TABLE
// ─────────────────────────────────────────────────────────────
function _render() {
    const allTrades = SessionState.get().trades;

    // Apply filters
    const trades = allTrades.filter(t => {
        if (filters.symbol   !== 'all' && t.symbol   !== filters.symbol)   return false;
        if (filters.strategy !== 'all' && t.strategy !== filters.strategy) return false;
        if (filters.outcome  !== 'all' && t.outcome  !== filters.outcome)  return false;
        return true;
    });

    // Update count
    const countEl = document.getElementById('journal-count');
    if (countEl) countEl.textContent = `${trades.length} trade${trades.length !== 1 ? 's' : ''}`;

    // Summary row
    _renderSummary(trades);

    // Table body
    const tbody = document.getElementById('trade-history-body');
    if (!tbody) return;

    if (trades.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.72rem;letter-spacing:0.06em;">
                    NO TRADES YET — START A BOT ON THE TERMINAL
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = trades.map(t => {
        const time   = new Date(t.time).toLocaleTimeString('en-GB', { hour12: false });
        const date   = new Date(t.time).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        const pnlPos = t.outcome === 'TP';
        const pnlVal = pnlPos ? `+${t.pnl.toFixed(2)}` : `-${t.pnl.toFixed(2)}`;
        const pnlCol = pnlPos ? 'var(--accent2)' : 'var(--accent3)';

        return `
        <tr>
            <td><span style="color:var(--text-muted)">${date}</span> ${time}</td>
            <td class="mono">${t.symbol || '—'}</td>
            <td style="color:var(--text-sub)">${_stratLabel(t.strategy)}${t.source === 'backtest' ? ' <span style="font-size:0.50rem;background:rgba(139,92,246,0.2);color:#a78bfa;padding:1px 5px;border-radius:3px;font-weight:600;vertical-align:middle;">BT</span>' : ''}</td>
            <td><span class="trade-badge trade-${(t.type||'').toLowerCase()}">${t.type || '—'}</span></td>
            <td class="mono">${_fmt(t.entry)}</td>
            <td class="mono">${_fmt(t.exit || null)}</td>
            <td class="mono" style="color:var(--accent3)">${_fmt(t.sl)}</td>
            <td class="mono" style="color:var(--accent2)">${_fmt(t.tp)}</td>
            <td><span class="trade-badge trade-${(t.outcome||'').toLowerCase()}">${t.outcome || '—'}</span></td>
            <td class="mono" style="color:${pnlCol};font-weight:600">${pnlVal}</td>
        </tr>`;
    }).join('');

    // Rebuild filter dropdowns with any new symbols/strategies
    _buildFilters();
}

function _renderSummary(trades) {
    if (!trades.length) {
        _set('jnl-total',    '0');
        _set('jnl-wins',     '0');
        _set('jnl-losses',   '0');
        _set('jnl-winrate',  '—');
        _set('jnl-total-pnl','0.00');
        return;
    }

    const wins   = trades.filter(t => t.outcome === 'TP').length;
    const losses = trades.filter(t => t.outcome === 'SL').length;
    const wr     = Math.round((wins / trades.length) * 100);
    const pnl    = trades.reduce((s, t) => s + (t.outcome === 'TP' ? t.pnl : -t.pnl), 0);
    const pnlPos = pnl >= 0;

    _set('jnl-total',   trades.length);
    _set('jnl-wins',    wins);
    _set('jnl-losses',  losses);
    _set('jnl-winrate', `${wr}%`);
    _set('jnl-total-pnl', `${pnlPos ? '+' : ''}${pnl.toFixed(2)}`);

    const pnlEl = document.getElementById('jnl-total-pnl');
    if (pnlEl) pnlEl.style.color = pnlPos ? 'var(--accent2)' : 'var(--accent3)';

    const wrEl = document.getElementById('jnl-winrate');
    if (wrEl) wrEl.style.color = wr >= 50 ? 'var(--accent2)' : 'var(--accent3)';
}

// ─────────────────────────────────────────────────────────────
// CLEAR SESSION
// ─────────────────────────────────────────────────────────────
function _wireClear() {
    document.getElementById('btn-clear-journal')?.addEventListener('click', () => {
        if (!confirm('Clear all trades from this session? This cannot be undone.')) return;
        SessionState.set({ trades: [], wins: 0, losses: 0, sessionPnL: 0, winRate: 0 });
        _render();
    });
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────
function _wireExport() {
    document.getElementById('btn-export-csv')?.addEventListener('click', () => {
        const trades = SessionState.get().trades;
        if (!trades.length) return;

        const headers = ['Date','Time','Symbol','Strategy','Direction','Entry','Exit','SL','TP','Outcome','PnL'];
        const rows    = trades.map(t => {
            const d = new Date(t.time);
            return [
                d.toLocaleDateString('en-GB'),
                d.toLocaleTimeString('en-GB', { hour12: false }),
                t.symbol   || '',
                t.strategy || '',
                t.type     || '',
                _fmt(t.entry),
                _fmt(t.exit || null),
                _fmt(t.sl),
                _fmt(t.tp),
                t.outcome  || '',
                t.outcome === 'TP' ? t.pnl.toFixed(5) : (-t.pnl).toFixed(5),
            ].join(',');
        });

        const csv  = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `nexus_trades_${_dateStamp()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _fmt(val) {
    if (val === null || val === undefined) return '—';
    return parseFloat(val).toFixed(5);
}

function _dateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function _stratLabel(key) {
    const map = {
        momentum:        'Momentum',
        h4_kiss:         'KISS H4',
        synthetic_scalp: 'BB+RSI',
        crypto_scalp:    'Crypto',
        rsi_fade:        'RSI Fade',
        range_boundary:  'Range',
        vwap_reversion:  'VWAP',
        candle_speed:    'Speed',
        london_breakout: 'London',
        news_fade:       'News Fade',
        ultra_scalp:     'Ultra',
        scalp:           'Scalp',
        swing:           'Swing',
        trend:           'Trend',
        orb:             'ORB',
    };
    return map[key] || key || '—';
}