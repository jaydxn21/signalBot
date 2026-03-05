// js/pages/analytics.js
import { SessionState } from '../session-state.js';

const JA_OFFSET = 5 * 3600 * 1000; // ms

function _jaMidnight() {
    const now = Date.now() - JA_OFFSET;
    return now - (now % 86400000) + JA_OFFSET;
}

export const Analytics = {

    init() {
        _render();
        setInterval(_render, 5000);
        // Daily P&L reset at Jamaica midnight
        _scheduleMidnightReset();
    },

    recordTrade() { _render(); },

    reset() {
        SessionState.set({ trades: [], wins: 0, losses: 0, sessionPnL: 0, winRate: 0 });
        _render();
    },
};

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
        _scheduleMidnightReset(); // reschedule for next day
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
    SessionState.set({ dailyHistory: days.slice(-30) }); // keep 30 days
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

    return {
        total, wins: wins.length, losses: losses.length, winRate,
        totalPnL, maxDrawdown, avgRR,
        bestStrategy, bestWR: Math.round(bestWR * 100),
        worstSymbol, worstWR: Math.round(worstWR * 100),
        avgConf, highConfWR,
        byHour, equity, byStrategy,
        todayTrades: trades.filter(t => t.time >= _jaMidnight()).length,
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
        equity: [], byStrategy: {}, todayTrades: 0, trades: [],
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
    _set('an-total-pnl',     s.total === 0 ? '+$0.00' : `${pos ? '+' : '-'}$${Math.abs(s.totalPnL).toFixed(2)}`);
    _set('an-max-drawdown',  s.total === 0 ? '$0.00' : `-$${s.maxDrawdown.toFixed(2)}`);
    _set('an-best-strategy', s.bestStrategy);
    _set('an-best-wr',       s.bestWR ? `${s.bestWR}% WR` : '—');
    _set('an-worst-symbol',  s.worstSymbol);
    _set('an-worst-wr',      s.worstWR ? `${s.worstWR}% WR` : '—');

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

    // Live confidence preview — shows even before trade closes
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

        // Hour label every 3 hours
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

    // Bucket by score ranges 0-20, 20-40, 40-60, 60-80, 80-100
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
// Shows active signals with confidence scores before trade closes
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

    // Sort by time desc, only show signals from last 10 minutes
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
        const sym     = e.symbol.replace('frx','').replace('cry','').replace('_','');
        const factors = (e.factors || []).slice(0, 4);

        return `
        <div class="live-conf-row" style="
            display:flex;align-items:flex-start;gap:12px;
            padding:10px 14px;border-radius:var(--r-sm);
            background:${e.color}11;border:1px solid ${e.color}33;
            margin-bottom:6px;
        ">
            <!-- Score ring -->
            <div style="
                width:44px;height:44px;border-radius:50%;flex-shrink:0;
                background:conic-gradient(${e.color} ${e.score * 3.6}deg, rgba(15,23,42,0.08) 0deg);
                display:flex;align-items:center;justify-content:center;
                position:relative;
            ">
                <div style="
                    width:34px;height:34px;border-radius:50%;
                    background:var(--surface-white);
                    display:flex;flex-direction:column;align-items:center;justify-content:center;
                ">
                    <span style="font-size:0.62rem;font-weight:800;color:${e.color};font-family:var(--font-mono);line-height:1;">${e.score}</span>
                    <span style="font-size:0.48rem;color:${e.color};font-weight:700;">${e.grade}</span>
                </div>
            </div>

            <!-- Signal info -->
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span style="
                        font-size:0.6rem;font-weight:700;letter-spacing:0.08em;
                        color:${e.type === 'BUY' ? '#10b981' : '#ef4444'};
                        font-family:var(--font-mono);
                    ">${e.type}</span>
                    <span style="font-size:0.65rem;font-weight:600;color:var(--text-dark);">${sym}</span>
                    <span style="font-size:0.58rem;color:var(--text-muted);">@ ${e.price?.toFixed(4) || '—'}</span>
                    <span style="font-size:0.55rem;color:var(--text-muted);margin-left:auto;">${ageStr}</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">
                    ${factors.map(f => `
                        <span style="
                            font-size:0.52rem;padding:2px 6px;border-radius:4px;
                            background:${e.color}18;color:${e.color};
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