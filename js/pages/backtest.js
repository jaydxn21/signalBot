// js/pages/backtest.js
import { _fetchCandles, _simulate, _calcATR, _calcRSI,
         _tfLabel, _sleep, CHUNK_SIZE, CHUNK_DELAY, WS_URL,
         _getBuiltinStrategy }                                     from '../backtest-core.js';
import { WalkForward, SuggestionEngine }                           from '../walk-forward.js';

// StrategyEngine lives on the server — use built-in standalone
// versions for browser backtest, or server engine if available.
function _makeStrategy(strategyId) {
    if (window.StrategyEngine) {
        const eng = new window.StrategyEngine();
        return { analyze: (id, c, h4, rs, atr, sym, rsi) => eng.analyze(strategyId, c, h4, rs, atr, sym, rsi) };
    }
    return _getBuiltinStrategy(strategyId);
}

const H4_GRAN = 14400;

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _chart       = null;
let _candleSeries = null;
let _splitLine   = null;
let _markers     = [];
let _trades      = [];
let _wfResult    = null;
let _wfSugStore  = {};   // id → suggestion object for Open in Builder
let _socket      = null;
let _running     = false;

// Deep-link to strategy builder with a suggestion pre-applied
window._openInBuilder = function(suggestionId) {
    const strategyId = document.getElementById('bt-strategy')?.value || '';
    const suggestion = _wfSugStore[suggestionId] || null;
    const payload    = { strategyId, suggestion };
    sessionStorage.setItem('nexus_builder_payload', JSON.stringify(payload));
    window.location.href = 'strategy-builder.html';
};

export const Backtest = {

    init() {
        document.getElementById('bt-run-btn')
            .addEventListener('click', _run);
        document.getElementById('bt-show-signals')
            .addEventListener('change', _toggleMarkers);
        document.getElementById('bt-export-btn')
            ?.addEventListener('click', _exportCSV);

        _initChart();
        _renderEmpty();
    },
};

// ─────────────────────────────────────────────────────────────
// CHART INIT
// ─────────────────────────────────────────────────────────────
function _initChart() {
    const container = document.getElementById('bt-chart');
    if (!container || _chart) return;

    _chart = LightweightCharts.createChart(container, {
        layout: {
            background:  { color: 'transparent' },
            textColor:   '#64748b',
            fontFamily:  'DM Mono, monospace',
            fontSize:    11,
        },
        grid: {
            vertLines:   { color: 'rgba(226,232,240,0.5)' },
            horzLines:   { color: 'rgba(226,232,240,0.5)' },
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: 'rgba(226,232,240,0.8)' },
        timeScale: {
            borderColor:     'rgba(226,232,240,0.8)',
            timeVisible:     true,
            secondsVisible:  false,
            timezone:        'America/Jamaica',
        },
        handleScroll:  true,
        handleScale:   true,
    });

    _candleSeries = _chart.addCandlestickSeries({
        upColor:        '#10b981', downColor:     '#ef4444',
        borderUpColor:  '#10b981', borderDownColor:'#ef4444',
        wickUpColor:    '#10b981', wickDownColor:  '#ef4444',
    });

    new ResizeObserver(() => {
        if (_chart && container.offsetWidth > 0)
            _chart.resize(container.offsetWidth, container.offsetHeight);
    }).observe(container);
}

// ─────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────
async function _run() {
    if (_running) return;
    _running = true;

    const symbol   = document.getElementById('bt-symbol').value;
    const strategy = document.getElementById('bt-strategy').value;
    const tf       = parseInt(document.getElementById('bt-tf').value);
    const count    = parseInt(document.getElementById('bt-count').value);
    const stake    = parseFloat(document.getElementById('bt-stake').value) || 10;
    const comm     = parseFloat(document.getElementById('bt-commission').value) || 0;

    _setRunning(true);
    _setProgress(5, 'Connecting to Deriv...');
    document.getElementById('bt-chart-title').textContent =
        `${symbol.replace('frx','').replace('cry','')}  ·  ${_tfLabel(tf)}  ·  ${strategy.replace(/_/g,' ').toUpperCase()}`;

    try {
        const chunks  = Math.ceil(count / CHUNK_SIZE);
        const chunkStr = chunks > 1 ? ` in ${chunks} chunks` : '';
        _setProgress(10, `Fetching ${count} candles${chunkStr}...`);

        const candles = await _fetchCandles(symbol, tf, count, (done, total) => {
            const pct = 10 + Math.round((done / total) * 35);
            _setProgress(pct, `Fetching candles... ${done}/${total}`);
        });

        _setProgress(48, `Fetching H4 candles...`);
        const h4Count   = Math.min(1000, Math.ceil(count * tf / H4_GRAN) + 100);
        const h4Candles = await _fetchCandles(symbol, H4_GRAN, h4Count, (done, total) => {
            const pct = 48 + Math.round((done / total) * 12);
            _setProgress(pct, `Fetching H4... ${done}/${total}`);
        });

        _setProgress(70, `Running ${strategy} on ${candles.length} bars...`);
        await _sleep(30);

        // Full simulation for chart display
        const stratObj = _makeStrategy(strategy);
        const result   = _simulate(candles, h4Candles, stratObj, stake, comm);

        _setProgress(80, 'Running walk-forward analysis...');
        await _sleep(30);

        // Walk-forward: IS (first 50%) vs OOS (second 50%)
        const wf = WalkForward.run(candles, h4Candles, stratObj, stake, comm);

        _setProgress(95, 'Rendering...');
        await _sleep(30);

        _renderChart(candles, result.trades, wf.splitTime);
        _renderEquity(result.equity, wf);
        _renderKPIs(result, wf);
        _renderWalkForward(wf);
        _renderTradeLog(result.trades);

        document.getElementById('bt-chart-count').textContent =
            `${candles.length} candles  ·  ${result.trades.length} signals  ·  WF split @ bar ${wf.splitIdx}`;

        _trades  = result.trades;
        _wfResult = wf;

        _setProgress(100, 'Complete');
        setTimeout(() => {
            document.getElementById('bt-progress').style.display = 'none';
            document.getElementById('bt-results').style.display  = '';
        }, 400);

    } catch(e) {
        console.error('[Backtest]', e);
        _setProgress(0, `Error: ${e.message}`);
    }

    _setRunning(false);
    _running = false;
}

// _simulate imported from backtest-core.js

// ─────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────
function _renderChart(candles, trades) {
    _hidePlaceholder();
    _candleSeries.setData(candles);
    _chart.timeScale().fitContent();
    _updateMarkers(trades);
}

function _updateMarkers(trades) {
    _markers = trades.map(t => ({
        time:     t.time,
        position: t.type === 'BUY' ? 'belowBar' : 'aboveBar',
        color:    t.outcome === 'TP' ? '#10b981' : t.outcome === 'SL' ? '#ef4444' : '#f59e0b',
        shape:    t.type === 'BUY' ? 'arrowUp' : 'arrowDown',
        text:     t.outcome === 'TP' ? '✓' : t.outcome === 'SL' ? '✗' : '…',
    }));
    if (document.getElementById('bt-show-signals')?.checked) {
        _candleSeries.setMarkers(_markers);
    }
}

function _toggleMarkers() {
    const show = document.getElementById('bt-show-signals')?.checked;
    _candleSeries.setMarkers(show ? _markers : []);
}

function _renderEquity(equity, wf) {
    const canvas = document.getElementById('bt-equity-canvas');
    if (!canvas || equity.length < 2) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  = canvas.offsetWidth  || canvas.parentElement.offsetWidth;
    const H   = canvas.height = canvas.offsetHeight || 90;
    ctx.clearRect(0, 0, W, H);

    const min   = Math.min(...equity, 0);
    const max   = Math.max(...equity, 0);
    const range = max - min || 1;
    const pad   = 6;
    const x = i => pad + (i / (equity.length - 1)) * (W - pad * 2);
    const y = v => H - pad - ((v - min) / range) * (H - pad * 2);

    // Zero line
    ctx.strokeStyle = 'rgba(100,116,139,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
    ctx.setLineDash([]);

    // IS/OOS split shading
    if (wf && wf.splitIdx) {
        const splitX = x(wf.splitIdx);
        ctx.fillStyle = 'rgba(245,158,11,0.06)';
        ctx.fillRect(splitX, 0, W - splitX, H);
        ctx.strokeStyle = 'rgba(245,158,11,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(245,158,11,0.6)';
        ctx.font = '8px DM Mono, monospace';
        ctx.fillText('IS', splitX - 18, 10);
        ctx.fillText('OOS', splitX + 4, 10);
    }

    // IS equity (blue)
    const isEq  = wf ? wf.is.equity  : equity;
    const oosEq = wf ? wf.oos.equity : [];

    const drawLine = (data, offset, color) => {
        if (data.length < 2) return;
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, color + '33');
        grad.addColorStop(1, color + '00');
        ctx.beginPath();
        ctx.moveTo(x(offset), y(data[0]));
        data.forEach((v, i) => ctx.lineTo(x(offset + i), y(v)));
        ctx.lineTo(x(offset + data.length - 1), H); ctx.lineTo(x(offset), H);
        ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
        ctx.beginPath();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
        ctx.moveTo(x(offset), y(data[0]));
        data.forEach((v, i) => ctx.lineTo(x(offset + i), y(v)));
        ctx.stroke();
    };

    if (wf) {
        drawLine(isEq,  0,                '#2563eb');
        drawLine(oosEq, wf.splitIdx || 0, oosEq[oosEq.length-1] >= 0 ? '#10b981' : '#ef4444');
    } else {
        const last = equity[equity.length-1];
        drawLine(equity, 0, last >= 0 ? '#10b981' : '#ef4444');
    }
}

function _renderKPIs(result) {
    const { trades, equity } = result;
    const closed  = trades.filter(t => t.outcome === 'TP' || t.outcome === 'SL');
    const wins    = closed.filter(t => t.outcome === 'TP');
    const losses  = closed.filter(t => t.outcome === 'SL');
    const netPnL  = equity[equity.length - 1];
    const winRate = closed.length ? (wins.length / closed.length * 100).toFixed(1) : 0;

    const avgWin   = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)            / wins.length   : 0;
    const avgLoss  = losses.length ? losses.reduce((s,t)=>s+Math.abs(t.pnl),0)/ losses.length : 0;

    const grossWin  = wins.reduce((s,t)=>s+t.pnl,0);
    const grossLoss = losses.reduce((s,t)=>s+Math.abs(t.pnl),0);
    const pf        = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞';

    const rrVals = closed.filter(t=>t.sl&&t.tp&&t.entry).map(t=>{
        const slD = Math.abs(t.entry-t.sl), tpD = Math.abs(t.entry-t.tp);
        return slD > 0 ? tpD/slD : 0;
    }).filter(r=>r>0);
    const avgRR = rrVals.length ? (rrVals.reduce((a,b)=>a+b,0)/rrVals.length).toFixed(2) : '—';

    let maxDD = 0, peak = 0, eq = 0;
    equity.forEach(v => { if(v>peak)peak=v; if(peak-v>maxDD)maxDD=peak-v; });

    let streak=0, maxStreak=0;
    closed.forEach(t => { if(t.outcome==='SL'){streak++;maxStreak=Math.max(maxStreak,streak);}else{streak=0;} });

    const expectancy = closed.length
        ? ((winRate/100 * avgWin) - ((1-winRate/100) * avgLoss)).toFixed(4) : '—';

    const pos = netPnL >= 0;
    _kpi('bt-pnl',        `${pos?'+':''}${netPnL.toFixed(4)}`,  pos?'#10b981':'#ef4444');
    _kpi('bt-wr',         `${winRate}%`,                          parseFloat(winRate)>=50?'#10b981':'#ef4444');
    _kpi('bt-trades',     `${wins.length}W / ${losses.length}L`,  '#64748b');
    _kpi('bt-dd',         `-${maxDD.toFixed(4)}`,                 '#ef4444');
    _kpi('bt-rr',         avgRR,                                   '#64748b');
    _kpi('bt-pf',         pf,                                      parseFloat(pf)>=1?'#10b981':'#ef4444');
    _kpi('bt-avg-win',    `+${avgWin.toFixed(4)}`,                '#10b981');
    _kpi('bt-avg-loss',   `-${avgLoss.toFixed(4)}`,               '#ef4444');
    _kpi('bt-max-streak', String(maxStreak),                       maxStreak>=5?'#ef4444':'#64748b');
    _kpi('bt-expectancy', String(expectancy),                      parseFloat(expectancy)>0?'#10b981':'#ef4444');
}

function _kpi(id, val, color) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.style.color = color;
}

function _renderWalkForward(wf) {
    const el = document.getElementById('bt-wf-section');
    if (!el) return;
    if (!wf || wf.error) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:0.62rem;padding:8px">${wf?.error || 'No walk-forward data'}</div>`;
        return;
    }

    const { is, oos, confidence: c, suggestions } = wf;

    // Store suggestions by id so onclick can look them up safely
    suggestions.forEach(s => { _wfSugStore[s.id] = s; });

    el.innerHTML = `

    <!-- ROW 1: Confidence badge + IS/OOS table side by side -->
    <div class="wf-top-row">

        <div class="wf-confidence-card">
            <svg width="72" height="72" viewBox="0 0 72 72">
                <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(100,116,139,0.12)" stroke-width="6"/>
                <circle cx="36" cy="36" r="30" fill="none" stroke="${c.color}" stroke-width="6"
                    stroke-dasharray="${(c.score/100*188.5).toFixed(1)} 188.5"
                    stroke-dashoffset="47.1"
                    stroke-linecap="round"
                    transform="rotate(-90 36 36)"/>
                <text x="36" y="32" text-anchor="middle" font-size="15" font-weight="800" fill="${c.color}" font-family="DM Mono,monospace">${c.score}</text>
                <text x="36" y="46" text-anchor="middle" font-size="10" font-weight="700" fill="${c.color}" font-family="DM Mono,monospace">${c.grade}</text>
            </svg>
            <div class="wf-conf-label">WALK-FORWARD<br>CONFIDENCE</div>
            <div class="wf-verdict" style="color:${c.color}">${c.verdict}</div>
        </div>

        <div class="wf-compare-card">
            <table class="wf-table">
                <thead><tr>
                    <th>METRIC</th>
                    <th style="color:#2563eb">◀ IN-SAMPLE</th>
                    <th style="color:${oos.stats.netPnL>=0?'#10b981':'#ef4444'}">OUT-OF-SAMPLE ▶</th>
                    <th>DELTA</th>
                </tr></thead>
                <tbody>
                    ${_wfRow('Win Rate',      is.stats.winRate.toFixed(1)+'%',    oos.stats.winRate.toFixed(1)+'%',    (oos.stats.winRate-is.stats.winRate).toFixed(1)+'%')}
                    ${_wfRow('Profit Factor', is.stats.profitFactor===Infinity?'∞':is.stats.profitFactor.toFixed(2), oos.stats.profitFactor===Infinity?'∞':oos.stats.profitFactor.toFixed(2), null)}
                    ${_wfRow('Net P&L',       '$'+is.stats.netPnL.toFixed(2),     '$'+oos.stats.netPnL.toFixed(2),    null)}
                    ${_wfRow('Max Drawdown',  '-$'+is.stats.maxDD.toFixed(2),     '-$'+oos.stats.maxDD.toFixed(2),    null)}
                    ${_wfRow('Avg R:R',       is.stats.avgRR.toFixed(2)+':1',     oos.stats.avgRR.toFixed(2)+':1',    null)}
                    ${_wfRow('Total Trades',  String(is.stats.total),             String(oos.stats.total),            null)}
                    ${_wfRow('Max Consec. SL',String(is.stats.maxStreak),         String(oos.stats.maxStreak),        null)}
                    ${_wfRow('Expectancy',    is.stats.expectancy.toFixed(4),     oos.stats.expectancy.toFixed(4),    null)}
                </tbody>
            </table>
        </div>
    </div>

    <!-- ROW 2: Score breakdown — full width -->
    <div class="wf-breakdown-card">
        <div class="wf-sub-label">SCORE BREAKDOWN</div>
        ${c.breakdown.map(b => `
            <div class="wf-score-row">
                <div class="wf-score-label">${b.label}</div>
                <div class="wf-score-bar-wrap">
                    <div class="wf-score-bar" style="width:${(b.pts/b.max*100).toFixed(0)}%;background:${b.pts/b.max>=0.7?'#10b981':b.pts/b.max>=0.4?'#f59e0b':'#ef4444'}"></div>
                </div>
                <div class="wf-score-pts">${b.pts} / ${b.max}</div>
                <div class="wf-score-val">${b.value}</div>
            </div>
        `).join('')}
    </div>

    <!-- ROW 3: Suggestions — full width, each card on its own line -->
    <div class="wf-suggestions">
        <div class="wf-sub-label">
            STRATEGY SUGGESTIONS
            <span style="font-size:0.52rem;color:var(--text-muted);font-weight:400;margin-left:8px;letter-spacing:0;">
                rule-based · AI-powered coming soon
            </span>
        </div>
        ${suggestions.length === 0
            ? '<div style="color:var(--text-muted);font-size:0.65rem;padding:8px 0;">No issues detected — strategy looks clean.</div>'
            : suggestions.map(s => `
                <div class="wf-suggestion" data-id="${s.id}" data-priority="${s.priority}">
                    <div class="wf-sug-header">
                        <span class="wf-sug-icon">${s.icon}</span>
                        <span class="wf-sug-type">${s.type.replace(/_/g,' ').toUpperCase()}</span>
                        <span class="wf-sug-priority ${s.priority}">${s.priority.toUpperCase()}</span>
                        <button class="wf-sug-open-btn"
                            title="Open this strategy in Strategy Builder with suggestion pre-applied"
                            onclick="window._openInBuilder('${s.id}')">
                            ⚙ Open in Builder
                        </button>
                    </div>
                    <div class="wf-sug-observation">${s.observation}</div>
                    <div class="wf-sug-tweak"><span class="wf-sug-tweak-label">TWEAK — </span>${s.tweak}</div>
                    <div class="wf-sug-impact"><span class="wf-sug-tweak-label">EXPECTED — </span>${s.expected_impact}</div>
                </div>
            `).join('')
        }
    </div>`;
}

function _wfRow(label, isVal, oosVal, delta) {
    const deltaColor = delta
        ? (parseFloat(delta) >= 0 ? '#10b981' : '#ef4444') : '';
    return `<tr>
        <td>${label}</td>
        <td style="color:#2563eb;font-weight:600">${isVal}</td>
        <td style="font-weight:600">${oosVal}</td>
        <td style="color:${deltaColor};font-weight:600">${delta || '—'}</td>
    </tr>`;
}

function _renderTradeLog(trades) {
    const el = document.getElementById('bt-trade-log');
    if (!el) return;
    const closed = trades.filter(t => t.outcome);
    document.getElementById('bt-log-count').textContent = `${closed.length} trades`;

    if (!closed.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.62rem;">No trades generated</div>';
        return;
    }

    el.innerHTML = `<table>
        <thead><tr>
            <th>#</th><th>TIME</th><th>DIR</th>
            <th>ENTRY</th><th>SL</th><th>TP</th>
            <th>EXIT</th><th>OUTCOME</th><th>P&L</th>
        </tr></thead>
        <tbody>${closed.map((t, i) => {
            const isWin  = t.outcome === 'TP';
            const isOpen = t.outcome === 'OPEN';
            const d = new Date(t.time * 1000);
            const ts = `${d.getUTCMonth()+1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
            return `<tr>
                <td style="color:var(--text-muted)">${i+1}</td>
                <td>${ts}</td>
                <td class="${t.type==='BUY'?'bt-log-buy':'bt-log-sell'}">${t.type}</td>
                <td>${t.entry.toFixed(5)}</td>
                <td style="color:#ef4444">${t.sl.toFixed(5)}</td>
                <td style="color:#10b981">${t.tp.toFixed(5)}</td>
                <td>${t.exit?.toFixed(5)||'—'}</td>
                <td class="${isWin?'bt-log-win':isOpen?'':'bt-log-loss'}">${t.outcome}</td>
                <td class="${isWin?'bt-log-win':isOpen?'':'bt-log-loss'}">${t.pnl!=null?(t.pnl>=0?'+':'')+t.pnl.toFixed(4):'—'}</td>
            </tr>`;
        }).join('')}</tbody>
    </table>`;
}

function _renderEmpty() {
    // Show placeholder overlay inside chart wrap, not inside the chart div
    const wrap = document.getElementById('bt-chart-wrap');
    if (!wrap) return;
    let placeholder = document.getElementById('bt-placeholder');
    if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.id = 'bt-placeholder';
        placeholder.style.cssText = `
            position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;
            pointer-events:none;z-index:2;
        `;
        placeholder.innerHTML = `
            <div style="font-size:2rem;opacity:0.15;color:var(--accent);">◈</div>
            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:8px;letter-spacing:0.04em;">Select symbol + strategy and run</div>
        `;
        wrap.style.position = 'relative';
        wrap.appendChild(placeholder);
    }
    placeholder.style.display = 'flex';
}

function _hidePlaceholder() {
    const el = document.getElementById('bt-placeholder');
    if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────
function _exportCSV() {
    if (!_trades.length) return;
    const rows = ['#,Time,Direction,Entry,SL,TP,Exit,Outcome,PnL'];
    _trades.filter(t=>t.outcome).forEach((t, i) => {
        const d  = new Date(t.time * 1000);
        const ts = d.toISOString().slice(0,19).replace('T',' ');
        rows.push(`${i+1},${ts},${t.type},${t.entry},${t.sl},${t.tp},${t.exit||''},${t.outcome},${t.pnl??''}`);
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `nexus_backtest_${Date.now()}.csv`;
    a.click();
}


function _setRunning(running) {
    const btn     = document.getElementById('bt-run-btn');
    const label   = document.getElementById('bt-run-label');
    const spinner = document.getElementById('bt-run-spinner');
    btn.disabled  = running;
    label.style.display  = running ? 'none' : '';
    spinner.style.display= running ? '' : 'none';
    if (running) document.getElementById('bt-progress').style.display = '';
}

function _setProgress(pct, label) {
    const fill = document.getElementById('bt-progress-fill');
    const lbl  = document.getElementById('bt-progress-label');
    if (fill) fill.style.width = pct + '%';
    if (lbl)  lbl.textContent  = label;
}

// _sleep imported from backtest-core.js