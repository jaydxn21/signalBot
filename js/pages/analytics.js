// js/pages/analytics.js
// On the terminal page: recordTrade() writes to SessionState.
// On analytics.html: init() reads from SessionState automatically.
// Data persists across page navigation within the same browser tab.

import { SessionState } from '../session-state.js';

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
export const Analytics = {

    init() {
        _render();
        // Re-render every 5s to pick up new trades written by the terminal
        setInterval(_render, 5000);
    },

    // Called from signal-bot.js on every TP/SL — writes to SessionState
    recordTrade({ symbol, strategy, type, entry, sl, tp, outcome, pnl }) {
        // SessionState.pushTrade is already called in signal-bot.js checkOutcome
        // so here we just re-render if we're on the terminal page
        _render();
    },

    reset() {
        SessionState.set({ trades: [], wins: 0, losses: 0, sessionPnL: 0, winRate: 0 });
        _render();
    },
};

// ─────────────────────────────────────────────────────────────
// DERIVED STATS — reads from SessionState
// ─────────────────────────────────────────────────────────────
function _stats() {
    const trades = SessionState.get().trades || [];
    const total  = trades.length;
    if (total === 0) return _empty();

    const wins   = trades.filter(t => t.outcome === 'TP');
    const losses = trades.filter(t => t.outcome === 'SL');
    const winRate = Math.round((wins.length / total) * 100);

    const totalPnL = wins.reduce((s, t) => s + t.pnl, 0)
                   - losses.reduce((s, t) => s + t.pnl, 0);

    const maxDrawdown = _calcMaxDrawdown(trades);

    const rrValues = trades
        .filter(t => t.sl && t.tp && t.entry)
        .map(t => {
            const slDist = Math.abs(t.entry - t.sl);
            const tpDist = Math.abs(t.entry - t.tp);
            return slDist > 0 ? tpDist / slDist : 0;
        })
        .filter(r => r > 0);
    const avgRR = rrValues.length
        ? (rrValues.reduce((a, b) => a + b, 0) / rrValues.length).toFixed(2)
        : '—';

    // Best strategy by win rate (min 3 trades)
    const byStrategy = {};
    trades.forEach(t => {
        if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { w: 0, l: 0 };
        t.outcome === 'TP' ? byStrategy[t.strategy].w++ : byStrategy[t.strategy].l++;
    });
    let bestStrategy = '—', bestWR = 0;
    Object.entries(byStrategy).forEach(([name, { w, l }]) => {
        if (w + l < 3) return;
        const wr = w / (w + l);
        if (wr > bestWR) { bestWR = wr; bestStrategy = name; }
    });

    // Worst symbol by win rate (min 3 trades)
    const bySymbol = {};
    trades.forEach(t => {
        if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { w: 0, l: 0 };
        t.outcome === 'TP' ? bySymbol[t.symbol].w++ : bySymbol[t.symbol].l++;
    });
    let worstSymbol = '—', worstWR = 1;
    Object.entries(bySymbol).forEach(([name, { w, l }]) => {
        if (w + l < 3) return;
        const wr = w / (w + l);
        if (wr < worstWR) { worstWR = wr; worstSymbol = name; }
    });

    const barData = trades.slice(-12).map(t => t.outcome === 'TP' ? 'up' : 'down');

    return {
        total, wins: wins.length, losses: losses.length, winRate,
        totalPnL, maxDrawdown, avgRR,
        bestStrategy, bestWR: Math.round(bestWR * 100),
        worstSymbol,  worstWR: Math.round(worstWR * 100),
        barData,
    };
}

function _empty() {
    return {
        total: 0, wins: 0, losses: 0, winRate: 0,
        totalPnL: 0, maxDrawdown: 0, avgRR: '—',
        bestStrategy: '—', bestWR: 0,
        worstSymbol:  '—', worstWR: 0,
        barData: [],
    };
}

function _calcMaxDrawdown(trades) {
    let peak = 0, equity = 0, maxDD = 0;
    trades.forEach(t => {
        equity += t.outcome === 'TP' ? t.pnl : -t.pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
    });
    return maxDD;
}

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────
function _render() {
    const s   = _stats();
    const pos = s.totalPnL >= 0;

    _set('an-total-trades', s.total);
    _set('an-win-rate',     s.total === 0 ? '—'      : `${s.winRate}%`);
    _set('an-avg-rr',       s.avgRR);
    _set('an-total-pnl',    s.total === 0 ? '+$0.00' : `${pos ? '+' : '-'}$${Math.abs(s.totalPnL).toFixed(2)}`);
    _set('an-max-drawdown', s.total === 0 ? '$0.00'  : `-$${s.maxDrawdown.toFixed(2)}`);
    _set('an-best-strategy',s.bestStrategy);
    _set('an-best-wr',      s.bestWR ? `${s.bestWR}% WR` : '—');
    _set('an-worst-symbol', s.worstSymbol);
    _set('an-worst-wr',     s.worstWR ? `${s.worstWR}% WR` : '—');

    const pnlEl = document.getElementById('an-total-pnl');
    if (pnlEl) pnlEl.style.color = pos ? 'var(--accent2)' : 'var(--accent3)';

    const wrEl = document.getElementById('an-win-rate');
    if (wrEl && s.total > 0) {
        wrEl.style.color = s.winRate >= 50 ? 'var(--accent2)' : 'var(--accent3)';
    }

    _renderBars('an-pnl-bars', s.barData);

    // Show/hide empty notice
    const notice = document.getElementById('an-empty-notice');
    if (notice) notice.style.display = s.total === 0 ? '' : 'none';

    _setBadge('an-wr-badge',   s.winRate >= 50, s.total > 0 ? `${s.wins}W / ${s.losses}L` : '0W / 0L');
    _setBadge('an-pnl-badge',  pos,             s.total > 0 ? `${s.total} trades` : '+0');
    _setBadge('an-dd-badge',   false,           s.maxDrawdown > 0 ? `${((s.maxDrawdown / (Math.abs(s.totalPnL) + s.maxDrawdown || 1)) * 100).toFixed(1)}%` : '0%');
    _setBadge('an-best-badge', true,            s.bestWR ? `${s.bestWR}% WR` : '—');
    _setBadge('an-worst-badge',false,           s.worstWR ? `${s.worstWR}% WR` : '—');
}

function _set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _setBadge(id, isUp, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = `analytics-badge ${isUp ? 'badge-up' : 'badge-down'}`;
}

function _renderBars(id, barData) {
    const el = document.getElementById(id);
    if (!el || !barData.length) return;
    el.innerHTML = barData.map((dir, i) => {
        const h = 35 + ((i * 7 + barData.length * 3) % 60);
        return `<div class="mini-bar ${dir}" style="height:${h}%"></div>`;
    }).join('');
}