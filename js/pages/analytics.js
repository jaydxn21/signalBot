// js/pages/analytics.js - COMPLETE UPDATED VERSION
import { SessionState } from '../session-state.js';

const JA_OFFSET = 5 * 3600 * 1000; // ms
const BRIDGE_URL = 'http://localhost:8080';

let mt5Trades = [];
let mt5Stats = { total_trades: 0, wins: 0, net_pnl: 0, win_rate: 0, profit_factor: 0 };

function _jaMidnight() {
    const now = Date.now() - JA_OFFSET;
    return now - (now % 86400000) + JA_OFFSET;
}

export const Analytics = {

    async init() {
        // Pull trades recorded on other devices before the first render, so
        // stats reflect the full account history, not just this browser.
        await SessionState.hydrateFromCloud();

        _render();
        _fetchMT5Trades();
        _fetchMT5Stats();
        setInterval(_fetchMT5Trades, 10000);
        setInterval(_fetchMT5Stats, 30000);
        setInterval(_render, 5000);
        _scheduleMidnightReset();

        // Listen for storage updates from other tabs
        window.addEventListener('storage', (e) => {
            if (e.key === 'nexus_session_state') {
                _render();
            }
        });
    },

    recordTrade() { _render(); },

    refreshMT5() {
        _fetchMT5Trades();
        _fetchMT5Stats();
    },

    reset() {
        SessionState.set({ trades: [], wins: 0, losses: 0, sessionPnL: 0, winRate: 0 });
        _render();
    },
};

// ─────────────────────────────────────────────────────────────
// MT5 TRADE FETCHING
// ─────────────────────────────────────────────────────────────
async function _fetchMT5Trades() {
    try {
        const r = await fetch(`${BRIDGE_URL}/api/trade-results?limit=200`);
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data)) {
            mt5Trades = data;
            _renderMT5(mt5Trades);
        }
    } catch(e) {
        console.warn('[Analytics] Failed to fetch MT5 trades:', e.message);
    }
}

async function _fetchMT5Stats() {
    try {
        const r = await fetch(`${BRIDGE_URL}/api/trade-stats`);
        if (!r.ok) return;
        const data = await r.json();
        mt5Stats = data;
        _updateMT5StatsDisplay();
    } catch(e) {
        console.warn('[Analytics] Failed to fetch MT5 stats:', e.message);
    }
}

function _updateMT5StatsDisplay() {
    const badge = document.getElementById('an-mt5-badge');
    if (badge) {
        if (mt5Stats.total_trades === 0) {
            badge.textContent = 'WAITING FOR EA';
            badge.className = 'mt5-badge';
        } else {
            badge.textContent = `LIVE · ${mt5Stats.total_trades} trades`;
            badge.className = 'mt5-badge live';
        }
    }

    // Update profit factor display
    const pfEl = document.getElementById('an-mt5-pf');
    if (pfEl && mt5Stats.profit_factor) {
        pfEl.textContent = mt5Stats.profit_factor.toFixed(2);
        pfEl.style.color = mt5Stats.profit_factor >= 1 ? 'var(--accent2)' : 'var(--accent3)';
    }

    // Update drift display
    const driftEl = document.getElementById('an-mt5-drift');
    if (driftEl && mt5Stats.total_trades > 0) {
        const simPnL = SessionState.get().sessionPnL || 0;
        const drift = mt5Stats.net_pnl - simPnL;
        driftEl.innerHTML = `<span style="color:${drift >= 0 ? 'var(--accent2)' : 'var(--accent3)'}">${drift >= 0 ? '+' : ''}${drift.toFixed(2)}</span> vs simulation`;
    }
}

// ─────────────────────────────────────────────────────────────
// MIDNIGHT RESET
// ─────────────────────────────────────────────────────────────
function _scheduleMidnightReset() {
    const now      = Date.now();
    const nextMid  = _jaMidnight() + 86400000;
    const msUntil  = nextMid - now;
    setTimeout(() => {
        _archiveDayStats();
        Analytics.reset();
        _scheduleMidnightReset();
    }, msUntil);
}

function _archiveDayStats() {
    const s     = _stats();
    const days  = SessionState.get().dailyHistory || [];
    days.push({
        date:    new Date(_jaMidnight()).toLocaleDateString('en-JM'),
        pnl:     s.totalPnL,
        trades:  s.total,
        winRate: s.winRate,
    });
    SessionState.set({ dailyHistory: days.slice(-30) });
}

// ─────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────
function _stats() {
    const trades = SessionState.get().trades || [];
    const total  = trades.length;
    if (total === 0) return _empty();

    const wins    = trades.filter(t => t.outcome === 'TP');
    const losses  = trades.filter(t => t.outcome === 'SL');
    const winRate = Math.round((wins.length / total) * 100);

    const totalPnL = wins.reduce((s, t) => s + t.pnl, 0)
                   - losses.reduce((s, t) => s + t.pnl, 0);

    const maxDrawdown = _calcMaxDrawdown(trades);

    const rrValues = trades
        .filter(t => t.sl && t.tp && t.entry)
        .map(t => {
            const sl = Math.abs(t.entry - t.sl);
            const tp = Math.abs(t.entry - t.tp);
            return sl > 0 ? tp / sl : 0;
        }).filter(r => r > 0);
    const avgRR = rrValues.length
        ? (rrValues.reduce((a, b) => a + b, 0) / rrValues.length).toFixed(2) : '—';

    // Best strategy (min 3 trades)
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

    // Worst symbol
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

    // Avg confidence score
    const withConf = trades.filter(t => t.confidence?.score);
    const avgConf  = withConf.length
        ? Math.round(withConf.reduce((s, t) => s + t.confidence.score, 0) / withConf.length) : null;

    // Conf score vs win rate correlation
    const highConf = trades.filter(t => t.confidence?.score >= 65);
    const highConfWR = highConf.length
        ? Math.round(highConf.filter(t => t.outcome === 'TP').length / highConf.length * 100) : null;

    // Win by hour (Jamaica time)
    const byHour = Array(24).fill(null).map(() => ({ w: 0, l: 0 }));
    trades.forEach(t => {
        const jaHour = new Date(t.time - JA_OFFSET).getUTCHours();
        t.outcome === 'TP' ? byHour[jaHour].w++ : byHour[jaHour].l++;
    });

    // Equity curve
    const equity = [];
    let running = 0;
    trades.forEach(t => {
        running += t.outcome === 'TP' ? t.pnl : -t.pnl;
        equity.push(running);
    });

    // Avg duration (simple approximation)
    let avgDuration = '—';
    if (trades.length > 0) {
        const durations = trades.filter(t => t.time && t.close_time).map(t => {
            const closeTime = t.close_time || (t.time + 3600000);
            return closeTime - t.time;
        }).filter(d => d > 0 && d < 86400000);
        if (durations.length) {
            const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
            const minutes = Math.round(avgMs / 60000);
            avgDuration = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        }
    }

    return {
        total, wins: wins.length, losses: losses.length, winRate,
        totalPnL, maxDrawdown, avgRR,
        bestStrategy, bestWR: Math.round(bestWR * 100),
        worstSymbol, worstWR: Math.round(worstWR * 100),
        avgConf, highConfWR,
        byHour, equity, byStrategy,
        todayTrades: trades.filter(t => t.time >= _jaMidnight()).length,
        avgDuration,
        trades,
    };
}

function _empty() {
    return {
        total: 0, wins: 0, losses: 0, winRate: 0,
        totalPnL: 0, maxDrawdown: 0, avgRR: '—',
        bestStrategy: '—', bestWR: 0,
        worstSymbol: '—', worstWR: 0,
        avgConf: null, highConfWR: null,
        byHour: Array(24).fill(null).map(() => ({ w: 0, l: 0 })),
        equity: [], byStrategy: {}, todayTrades: 0, avgDuration: '—',
        trades: [],
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

    _set('an-total-trades',  s.total);
    _set('an-today-trades',  s.todayTrades);
    _set('an-win-rate',      s.total === 0 ? '—' : `${s.winRate}%`);
    _set('an-avg-rr',        s.avgRR);
    _set('an-avg-duration',  s.avgDuration);
    _set('an-total-pnl',     s.total === 0 ? '+$0.00' : `${pos ? '+' : '-'}$${Math.abs(s.totalPnL).toFixed(2)}`);
    _set('an-max-drawdown',  s.total === 0 ? '$0.00' : `-$${s.maxDrawdown.toFixed(2)}`);
    _set('an-best-strategy', s.bestStrategy === '—' ? '—' : s.bestStrategy.toUpperCase());
    _set('an-worst-symbol',  s.worstSymbol === '—' ? '—' : s.worstSymbol);

    // Confidence intelligence
    _set('an-avg-conf',      s.avgConf !== null ? `${s.avgConf}%` : '—');
    _set('an-high-conf-wr',  s.highConfWR !== null ? `${s.highConfWR}%` : '—');

    const pnlEl = document.getElementById('an-total-pnl');
    if (pnlEl) pnlEl.style.color = pos ? 'var(--accent2)' : 'var(--accent3)';

    const wrEl = document.getElementById('an-win-rate');
    if (wrEl && s.total > 0) {
        wrEl.style.color = s.winRate >= 50 ? 'var(--accent2)' : 'var(--accent3)';
    }

    _setBadge('an-pnl-badge',   pos,           s.total > 0 ? `${s.total} trades` : '+0');
    _setBadge('an-wr-badge',    s.winRate >= 50, s.total > 0 ? `${s.wins}W / ${s.losses}L` : '0W / 0L');
    _setBadge('an-dd-badge',    false,           s.maxDrawdown > 0 ? `${((s.maxDrawdown / (Math.abs(s.totalPnL) + s.maxDrawdown || 1)) * 100).toFixed(1)}%` : '0%');
    _setBadge('an-best-badge',  true,            s.bestWR ? `${s.bestWR}% WR` : '—');
    _setBadge('an-worst-badge', false,           s.worstWR ? `${s.worstWR}% WR` : '—');

    // Charts
    _drawEquityCurve(s.equity);
    _drawHourChart(s.byHour);
    _drawStrategyChart(s.byStrategy);
    _drawConfidenceChart(s.trades);

    // Live confidence preview
    _renderLiveConfidence();

    const notice = document.getElementById('an-empty-notice');
    if (notice) notice.style.display = s.total === 0 ? '' : 'none';
}

// ─────────────────────────────────────────────────────────────
// CANVAS CHARTS
// ─────────────────────────────────────────────────────────────
function _drawEquityCurve(equity) {
    const canvas = document.getElementById('an-equity-canvas');
    if (!canvas || equity.length < 2) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight || 120;
    ctx.clearRect(0, 0, W, H);

    const min  = Math.min(...equity, 0);
    const max  = Math.max(...equity, 0);
    const rang = max - min || 1;
    const pad  = 8;

    const x = i => pad + (i / (equity.length - 1)) * (W - pad * 2);
    const y = v => H - pad - ((v - min) / rang) * (H - pad * 2);

    // Zero line
    ctx.strokeStyle = 'rgba(100,116,139,0.25)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(W, y(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    const isPos = equity[equity.length - 1] >= 0;
    grad.addColorStop(0,   isPos ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)');
    grad.addColorStop(1,   'rgba(255,255,255,0)');

    ctx.beginPath();
    ctx.moveTo(x(0), y(equity[0]));
    equity.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(equity.length - 1), H);
    ctx.lineTo(x(0), H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = isPos ? '#10b981' : '#ef4444';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.moveTo(x(0), y(equity[0]));
    equity.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.stroke();

    // Current value dot
    const last = equity[equity.length - 1];
    ctx.beginPath();
    ctx.arc(x(equity.length - 1), y(last), 4, 0, Math.PI * 2);
    ctx.fillStyle = isPos ? '#10b981' : '#ef4444';
    ctx.fill();
}

function _drawHourChart(byHour) {
    const canvas = document.getElementById('an-hour-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  = canvas.offsetWidth;
    const H   = canvas.height = canvas.offsetHeight || 100;
    ctx.clearRect(0, 0, W, H);

    const tradingHours = Array.from({ length: 24 }, (_, i) => i);
    const maxCount = Math.max(...byHour.map(h => h.w + h.l), 1);
    const barW     = (W - 16) / 24;
    const pad      = 4;

    tradingHours.forEach(hr => {
        const { w, l } = byHour[hr];
        const total    = w + l;
        if (total === 0) return;

        const wr     = w / total;
        const barH   = ((total / maxCount) * (H - 20));
        const bx     = 8 + hr * barW + pad / 2;
        const color  = wr >= 0.6 ? '#10b981' : wr >= 0.4 ? '#f59e0b' : '#ef4444';

        ctx.fillStyle = color + '33';
        ctx.fillRect(bx, H - barH - 12, barW - pad, barH);
        ctx.fillStyle = color;
        ctx.fillRect(bx, H - (barH * wr) - 12, barW - pad, barH * wr);

        if (hr % 3 === 0) {
            ctx.fillStyle   = 'rgba(100,116,139,0.6)';
            ctx.font        = '8px DM Mono, monospace';
            ctx.textAlign   = 'center';
            ctx.fillText(`${hr}h`, bx + (barW - pad) / 2, H - 1);
        }
    });
}

function _drawStrategyChart(byStrategy) {
    const canvas = document.getElementById('an-strategy-canvas');
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    const W      = canvas.width  = canvas.offsetWidth;
    const H      = canvas.height = canvas.offsetHeight || 120;
    ctx.clearRect(0, 0, W, H);

    const entries = Object.entries(byStrategy).filter(([, v]) => v.w + v.l > 0);
    if (!entries.length) return;

    const barH   = Math.min(22, (H - 8) / entries.length - 4);
    const maxTotal = Math.max(...entries.map(([, v]) => v.w + v.l));

    entries.forEach(([name, { w, l }], i) => {
        const total  = w + l;
        const wr     = w / total;
        const barW   = ((total / maxTotal) * (W - 90));
        const by     = 4 + i * (barH + 6);
        const color  = wr >= 0.6 ? '#10b981' : wr >= 0.4 ? '#f59e0b' : '#ef4444';
        const label  = name.replace('_', ' ').toUpperCase().slice(0, 12);

        ctx.fillStyle = 'rgba(100,116,139,0.15)';
        ctx.fillRect(82, by, W - 90, barH);

        ctx.fillStyle = color + '55';
        ctx.fillRect(82, by, barW, barH);

        ctx.fillStyle = color;
        ctx.fillRect(82, by, barW * wr, barH);

        ctx.fillStyle   = 'rgba(30,41,59,0.7)';
        ctx.font        = `bold 8px DM Mono, monospace`;
        ctx.textAlign   = 'right';
        ctx.fillText(label, 78, by + barH - 4);

        ctx.fillStyle   = 'rgba(100,116,139,0.8)';
        ctx.font        = `8px DM Mono, monospace`;
        ctx.textAlign   = 'left';
        ctx.fillText(`${Math.round(wr * 100)}% (${total})`, 86 + barW + 2, by + barH - 4);
    });
}

function _drawConfidenceChart(trades) {
    const canvas = document.getElementById('an-conf-canvas');
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    const W      = canvas.width  = canvas.offsetWidth;
    const H      = canvas.height = canvas.offsetHeight || 100;
    ctx.clearRect(0, 0, W, H);

    const withConf = trades.filter(t => t.confidence?.score);
    if (withConf.length < 2) {
        ctx.fillStyle = 'rgba(100,116,139,0.3)';
        ctx.font      = '10px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('No confidence data yet', W / 2, H / 2);
        return;
    }

    const buckets = [0, 20, 40, 60, 80].map(min => {
        const max    = min + 20;
        const bucket = withConf.filter(t => t.confidence.score >= min && t.confidence.score < max + (max === 100 ? 1 : 0));
        const wins   = bucket.filter(t => t.outcome === 'TP').length;
        return { label: `${min}-${max}`, total: bucket.length, wins, wr: bucket.length ? wins / bucket.length : 0 };
    });

    const maxCount = Math.max(...buckets.map(b => b.total), 1);
    const barW     = (W - 16) / 5;

    buckets.forEach(({ label, total, wr }, i) => {
        if (total === 0) return;
        const bx    = 8 + i * barW + 2;
        const barH  = ((total / maxCount) * (H - 28));
        const color = wr >= 0.6 ? '#10b981' : wr >= 0.4 ? '#f59e0b' : '#ef4444';
        const by    = H - barH - 18;

        ctx.fillStyle = color + '25';
        ctx.fillRect(bx, by, barW - 4, barH);
        ctx.fillStyle = color;
        ctx.fillRect(bx, by + barH * (1 - wr), barW - 4, barH * wr);

        ctx.fillStyle = 'rgba(30,41,59,0.7)';
        ctx.font      = 'bold 8px DM Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(wr * 100)}%`, bx + (barW - 4) / 2, by - 2);

        ctx.fillStyle = 'rgba(100,116,139,0.6)';
        ctx.font      = '7px DM Mono, monospace';
        ctx.fillText(label, bx + (barW - 4) / 2, H - 5);
    });
}

// ─────────────────────────────────────────────────────────────
// LIVE CONFIDENCE PREVIEW
// ─────────────────────────────────────────────────────────────
function _renderLiveConfidence() {
    const container = document.getElementById('an-live-confidence');
    if (!container) return;

    const liveConf = SessionState.get().liveConfidence || {};
    const entries  = Object.values(liveConf);

    if (!entries.length) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.65rem;text-align:center;padding:16px 0;">No active signals yet — waiting for first signal fire</div>';
        return;
    }

    const recent = entries
        .filter(e => Date.now() - e.time < 600000)
        .sort((a, b) => b.time - a.time);

    if (!recent.length) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.65rem;text-align:center;padding:16px 0;">No signals in last 10 minutes</div>';
        return;
    }

    container.innerHTML = recent.map(e => {
        const age     = Math.floor((Date.now() - e.time) / 1000);
        const ageStr  = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
        const sym     = (e.symbol || '').replace('frx','').replace('cry','').replace('_','');
        const factors = (e.factors || []).slice(0, 4);
        const color = e.color || '#8b5cf6';

        return `
        <div class="live-conf-row" style="
            display:flex;align-items:flex-start;gap:12px;
            padding:10px 14px;border-radius:var(--r-sm);
            background:${color}11;border:1px solid ${color}33;
            margin-bottom:6px;
        ">
            <div style="
                width:44px;height:44px;border-radius:50%;flex-shrink:0;
                background:conic-gradient(${color} ${(e.score || 50) * 3.6}deg, rgba(15,23,42,0.08) 0deg);
                display:flex;align-items:center;justify-content:center;
                position:relative;
            ">
                <div style="
                    width:34px;height:34px;border-radius:50%;
                    background:var(--surface-white);
                    display:flex;flex-direction:column;align-items:center;justify-content:center;
                ">
                    <span style="font-size:0.62rem;font-weight:800;color:${color};font-family:var(--font-mono);line-height:1;">${e.score || 50}</span>
                    <span style="font-size:0.48rem;color:${color};font-weight:700;">${e.grade || 'B'}</span>
                </div>
            </div>

            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span style="
                        font-size:0.6rem;font-weight:700;letter-spacing:0.08em;
                        color:${e.type === 'BUY' ? '#10b981' : '#ef4444'};
                        font-family:var(--font-mono);
                    ">${e.type || 'SIGNAL'}</span>
                    <span style="font-size:0.65rem;font-weight:600;color:var(--text-dark);">${sym}</span>
                    <span style="font-size:0.58rem;color:var(--text-muted);margin-left:auto;">${ageStr}</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">
                    ${factors.map(f => `
                        <span style="
                            font-size:0.52rem;padding:2px 6px;border-radius:4px;
                            background:${color}18;color:${color};
                            font-family:var(--font-mono);letter-spacing:0.03em;
                        ">${f}</span>
                    `).join('')}
                    ${factors.length === 0 ? `<span style="font-size:0.55rem;color:var(--text-muted);">No confluence factors</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// MT5 REAL TRADES RENDERING
// ─────────────────────────────────────────────────────────────
function _renderMT5(results = []) {
    const closed = results.filter(t => t.pnl !== undefined && t.pnl !== null);

    // Badge
    const badge = document.getElementById('an-mt5-badge');
    if (badge) {
        if (closed.length === 0) {
            badge.textContent = 'WAITING FOR EA';
            badge.style.cssText = 'background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);';
        } else {
            badge.textContent = 'LIVE';
            badge.style.cssText = 'background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);';
        }
    }

    // Stats
    const netPnL  = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins    = closed.filter(t => (t.pnl || 0) > 0).length;
    const wr      = closed.length ? Math.round((wins / closed.length) * 100) : 0;

    const pnlEl = document.getElementById('an-mt5-pnl');
    if (pnlEl) {
        pnlEl.textContent = `$${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(2)}`;
        pnlEl.style.color = netPnL >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
    _set('an-mt5-wr',     closed.length ? `${wr}%`       : '—');
    _set('an-mt5-trades', closed.length ? closed.length  : '0');

    // Simulated vs real drift
    const simPnL  = SessionState.get().sessionPnL || 0;
    const drift   = closed.length ? (netPnL - simPnL).toFixed(2) : null;
    const driftEl = document.getElementById('an-mt5-drift');
    if (driftEl) {
        driftEl.textContent = drift !== null ? `${drift >= 0 ? '+' : ''}${drift}` : '—';
        driftEl.style.color = drift !== null
            ? (drift >= 0 ? 'var(--accent2)' : 'var(--accent3)')
            : 'var(--text-muted)';
    }

    // Profit factor
    const totalWins = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const totalLosses = Math.abs(closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const profitFactor = totalLosses > 0 ? (totalWins / totalLosses).toFixed(2) : totalWins > 0 ? '∞' : '—';
    const pfEl = document.getElementById('an-mt5-pf');
    if (pfEl) {
        pfEl.textContent = profitFactor;
        pfEl.style.color = (profitFactor !== '—' && parseFloat(profitFactor) >= 1) ? 'var(--accent2)' : 'var(--accent3)';
    }

    // Trade log
    const logEl = document.getElementById('an-mt5-trade-log');
    if (!logEl) return;
    if (!closed.length) {
        logEl.innerHTML = '<div style="font-size:0.62rem;color:var(--text-muted);text-align:center;padding:16px;font-style:italic;">No MT5 trade results yet — EA will post results here when trades close.</div>';
        return;
    }
    logEl.innerHTML = [...closed].reverse().slice(0, 20).map(t => {
        const pnl     = t.pnl || 0;
        const time    = t.close_time ? new Date(t.close_time * 1000).toLocaleTimeString() : '—';
        const isWin   = pnl > 0;
        const symbol = t.symbol || '—';
        return `<div style="display:flex;gap:10px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border-light);font-size:0.62rem;font-family:'DM Mono',monospace;">
            <span style="color:${isWin ? 'var(--accent2)' : 'var(--accent3)'};">${isWin ? '▲' : '▼'}</span>
            <span style="color:var(--text-primary);flex:1;">${symbol}</span>
            <span style="color:var(--text-sub);">${time}</span>
            <span style="color:${isWin ? 'var(--accent2)' : 'var(--accent3)'};font-weight:600;">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>
        </div>`;
    }).join('');
}