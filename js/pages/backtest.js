// js/pages/backtest.js
import { _fetchCandles, _simulate, _walkForward, _calcStats, _detectOverfit,
         _calcATR, _calcRSI, _tfLabel, _sleep, CHUNK_SIZE, CHUNK_DELAY, WS_URL,
         _getBuiltinStrategy }                                     from '../backtest-core.js';
import { SessionState }                                            from '../session-state.js';
import { Auth }                                                    from '../auth.js';


function _makeStrategy(strategyId, options = {}) {
    return _getBuiltinStrategy(strategyId, options);
}

const H4_GRAN = 14400;

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _chart        = null;
let _candleSeries = null;
let _markers      = [];
let _trades       = [];
let _wfResult     = null;
let _btMode       = 'single';
let _cachedCandles    = null;
let _cachedH4Candles  = null;
let _running      = false;

function _usesGenericBacktestEngine(strategyId) {
    return true; // All strategies now use the generic engine
}

window.btClearDates = function() {
    const f = document.getElementById('bt-date-from');
    const t = document.getElementById('bt-date-to');
    if (f) f.value = '';
    if (t) t.value = '';
};

// ─────────────────────────────────────────────────────────────
// DYNAMIC CANDLE COUNT OPTIONS
// ─────────────────────────────────────────────────────────────
function _barsForDays(calendarDays, tfSeconds) {
    const isSynthetic = ['R_100','R_75','R_50','R_25','R_10',
        '1HZ100V','1HZ75V','1HZ50V','CRASH1000','BOOM1000',
        'CRASH500','BOOM500','stpRNG'].includes(
            document.getElementById('bt-symbol')?.value || '');
    const tradingHrsPerDay = isSynthetic ? 24 : 16;
    const barsPerDay = (tradingHrsPerDay * 3600) / tfSeconds;
    return Math.round(calendarDays * barsPerDay);
}

let _btCountMode = 'days';

window.btToggleCountMode = function() {
    const tf    = parseInt(document.getElementById('bt-tf')?.value || '300');
    const input = document.getElementById('bt-count-input');
    const unit  = document.getElementById('bt-count-unit');
    const toggle= document.getElementById('bt-count-mode-toggle');
    if (!input) return;

    if (_btCountMode === 'days') {
        const days = parseInt(input.value) || 61;
        input.value = _barsForDays(days, tf);
        unit.textContent = 'candles';
        toggle.textContent = 'switch to days';
        _btCountMode = 'candles';
    } else {
        const bars = parseInt(input.value) || 1000;
        const secsPerBar = tf || 300;
        input.value = Math.round(bars * secsPerBar / 86400);
        unit.textContent = 'days';
        toggle.textContent = 'switch to candles';
        _btCountMode = 'days';
    }
    window.btSyncCountFromInput();
};

window.btSyncCountFromInput = function() {
    const tf    = parseInt(document.getElementById('bt-tf')?.value || '300');
    const input = document.getElementById('bt-count-input');
    const hint  = document.getElementById('bt-count-hint');
    const sel   = document.getElementById('bt-count');
    if (!input || !sel) return;

    let bars;
    if (_btCountMode === 'days') {
        const days = Math.max(1, parseInt(input.value) || 61);
        bars = _barsForDays(days, tf);
        if (hint) {
            const tfLabel = tf < 3600 ? `${tf/60}m` : `${tf/3600}h`;
            hint.textContent = `≈ ${bars.toLocaleString()} ${tfLabel} candles`;
        }
    } else {
        bars = Math.max(1, parseInt(input.value) || 1000);
        if (hint) {
            const days = Math.round(bars * tf / 86400);
            hint.textContent = `≈ ${days} days`;
        }
    }

    let opt = sel.querySelector(`option[value="${bars}"]`);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = bars;
        sel.appendChild(opt);
    }
    sel.value = bars;
};

window.btBuildCandleOptions = function() {
    window.btSyncCountFromInput();
};

window._openInBuilder = function() {
    const strategyId = document.getElementById('bt-strategy')?.value || '';
    sessionStorage.setItem('nexus_builder_payload', JSON.stringify({ strategyId }));
    window.location.href = 'strategy-builder.html';
};

// ─────────────────────────────────────────────────────────────
// STRATEGY CHANGE HANDLER
// ─────────────────────────────────────────────────────────────
window.btStrategyChanged = function(strategy) {
    document.querySelectorAll('.bt-strategy-notice').forEach(n => n.remove());
    
    const notices = {
        breakout: { 
            color: '#f59e0b', 
            icon: '📈', 
            text: 'BREAKOUT — Works on any symbol. Detects support/resistance breakouts with trend confirmation. TP=2x SL.' 
        },
    };
    
    const n = notices[strategy];
    if (!n) return;
    const el = document.createElement('div');
    el.className = 'bt-strategy-notice';
    el.style.cssText = `margin-top:8px;padding:7px 10px;background:${n.color}18;border:1px solid ${n.color}40;border-radius:6px;font-size:0.62rem;color:${n.color};line-height:1.5;`;
    el.textContent = n.icon + ' ' + n.text;
    document.getElementById('bt-strategy')?.closest('.bt-field-group')?.appendChild(el);
};

// MODE SWITCHING
// ─────────────────────────────────────────────────────────────
window.btSetMode = function(mode) {
    _btMode = mode;
    document.getElementById('bt-mode-single').classList.toggle('active', mode === 'single');
    document.getElementById('bt-mode-compare').classList.toggle('active', mode === 'compare');
    document.getElementById('bt-compare-slots').style.display = mode === 'compare' ? 'flex' : 'none';
    document.getElementById('bt-run-label').textContent =
        mode === 'compare' ? '▶  RUN COMPARISON' : '▶  RUN BACKTEST';
};

// ─────────────────────────────────────────────────────────────
// STRATEGY COMPARISON
// ─────────────────────────────────────────────────────────────
async function _runComparison(candles, h4Candles, stake, comm) {
    const COLORS = ['#2563eb', '#8b5cf6', '#f59e0b'];
    const LABELS = ['A', 'B', 'C'];

    const stratIds = [document.getElementById('bt-strategy').value];
    document.querySelectorAll('.bt-compare-strategy').forEach(sel => {
        if (sel.value) stratIds.push(sel.value);
    });

    const results = await Promise.all(stratIds.map(async (id, i) => {
        const obj    = _makeStrategy(id, window._currentStrategyOptions || {});
        const sym    = document.getElementById('bt-symbol')?.value || '';
        const result = _simulate(candles, h4Candles, obj, stake, comm, sym);
        const wf     = await _walkForward(candles, h4Candles, obj, stake, comm, sym);
        const s      = wf.oos.stats;
        return {
            id, label: LABELS[i], color: COLORS[i],
            equity: result.equity,
            winRate: s.winRate * 100, pf: s.profitFactor,
            netPnL: s.netPnL, maxDD: s.maxDD,
            trades: s.total, rr: s.avgRR,
            confidence: wf.overfit.score,
            grade: wf.overfit.grade,
            gradeColor: wf.overfit.color,
            isWR: wf.is.stats.winRate * 100,
        };
    }));

    _renderComparison(results, candles.length);
}

function _renderComparison(results, totalBars) {
    const wrap = document.getElementById('bt-compare-wrap');
    const el   = document.getElementById('bt-compare-results');
    wrap.style.display = '';

    const METRICS = [
        { key: 'winRate',     label: 'OOS Win Rate',     fmt: v => v.toFixed(1)+'%',   better: 'high' },
        { key: 'pf',          label: 'Profit Factor',    fmt: v => v===Infinity?'∞':v.toFixed(2), better: 'high' },
        { key: 'netPnL',      label: 'Net P&L',          fmt: v => (v>=0?'+':'')+v.toFixed(2), better: 'high' },
        { key: 'maxDD',       label: 'Max Drawdown',     fmt: v => '-'+v.toFixed(2),   better: 'low' },
        { key: 'rr',          label: 'Avg R:R',          fmt: v => v.toFixed(2)+':1',  better: 'high' },
        { key: 'trades',      label: 'Trades',           fmt: v => String(v),          better: null },
        { key: 'confidence',  label: 'WF Confidence',    fmt: v => v+' '+results.find(r=>r.confidence===v)?.grade, better: 'high' },
        { key: 'isWR',        label: 'IS Win Rate',      fmt: v => v.toFixed(1)+'%',   better: 'high' },
    ];

    const best = {};
    METRICS.forEach(m => {
        if (!m.better) return;
        const vals = results.map(r => parseFloat(r[m.key]) || 0);
        best[m.key] = m.better === 'high' ? Math.max(...vals) : Math.min(...vals);
    });

    const canvasId = 'bt-compare-equity';

    el.innerHTML = `
    <div style="padding:14px 20px 10px;">
        <canvas id="${canvasId}" style="width:100%;height:120px;display:block;margin-bottom:16px;"></canvas>
        <table class="bt-compare-table">
            <thead><tr>
                <th>METRIC</th>
                ${results.map(r => `<th>
                    <span class="bt-compare-label" style="background:${r.color}22;color:${r.color};border:1px solid ${r.color}44;">${r.label}</span>
                    <div style="font-size:0.58rem;font-weight:400;color:var(--text-muted);margin-top:2px;">${r.id.replace(/_/g,' ')}</div>
                </th>`).join('')}
            </tr></thead>
            <tbody>
            ${METRICS.map(m => `
                <tr>
                    <td class="bt-compare-metric-label">${m.label}</td>
                    ${results.map(r => {
                        const val   = r[m.key];
                        const isBest = m.better && (parseFloat(val)||0) === best[m.key];
                        const isGood = m.key === 'winRate' || m.key === 'isWR'
                            ? val >= 50 : m.key === 'pf' ? val >= 1
                            : m.key === 'netPnL' ? val >= 0
                            : m.key === 'confidence' ? val >= 60 : null;
                        const color = isGood === true ? '#10b981' : isGood === false ? '#ef4444' : 'var(--text-dark)';
                        return `<td style="color:${color};font-weight:${isBest?'800':'600'};">
                            ${m.fmt(val)}${isBest ? ' <span style="font-size:0.55rem;color:#f59e0b">★</span>' : ''}
                        </td>`;
                    }).join('')}
                </tr>
            `).join('')}
            </tbody>
        </table>
    </div>`;

    requestAnimationFrame(() => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W   = canvas.width  = canvas.offsetWidth || 800;
        const H   = canvas.height = 120;
        ctx.clearRect(0, 0, W, H);

        const allVals = results.flatMap(r => r.equity);
        const min = Math.min(...allVals, 0);
        const max = Math.max(...allVals, 0);
        const range = max - min || 1;
        const pad = 8;
        const xFn = (i, len) => pad + (i/(len-1)) * (W-pad*2);
        const yFn = v => H - pad - ((v-min)/range)*(H-pad*2);

        ctx.strokeStyle='rgba(100,116,139,0.15)'; ctx.lineWidth=1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(0,yFn(0)); ctx.lineTo(W,yFn(0)); ctx.stroke();
        ctx.setLineDash([]);

        results.forEach(r => {
            if (r.equity.length < 2) return;
            ctx.beginPath(); ctx.strokeStyle = r.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
            ctx.moveTo(xFn(0, r.equity.length), yFn(r.equity[0]));
            r.equity.forEach((v,i) => ctx.lineTo(xFn(i, r.equity.length), yFn(v)));
            ctx.stroke();
            const lx = xFn(r.equity.length-1, r.equity.length);
            const ly = yFn(r.equity[r.equity.length-1]);
            ctx.fillStyle = r.color; ctx.font = 'bold 11px DM Mono,monospace';
            ctx.fillText(r.label, lx+4, ly+4);
        });
    });
}

// ─────────────────────────────────────────────────────────────
// PARAMETER OPTIMIZER
// ─────────────────────────────────────────────────────────────
window.btToggleOptimizer = function() {
    const wrap = document.getElementById('bt-optimizer-wrap');
    wrap.style.display = wrap.style.display === 'none' ? '' : 'none';
};

window.btRunOptimizer = async function() {
    const strategy = document.getElementById('bt-strategy').value;
    if (!_usesGenericBacktestEngine(strategy)) {
        alert(`${strategy.toUpperCase()} optimizer is not supported yet in this mode.`);
        return;
    }

    if (!_cachedCandles || !_cachedH4Candles) {
        alert('Run a backtest first — optimizer reuses the same candles.');
        return;
    }

    const stake    = parseFloat(document.getElementById('bt-stake').value) || 10;
    const comm     = parseFloat(document.getElementById('bt-commission').value) || 0;

    const slMin  = parseFloat(document.getElementById('bt-opt-sl-min').value);
    const slMax  = parseFloat(document.getElementById('bt-opt-sl-max').value);
    const slStep = parseFloat(document.getElementById('bt-opt-sl-step').value);
    const tpMin  = parseFloat(document.getElementById('bt-opt-tp-min').value);
    const tpMax  = parseFloat(document.getElementById('bt-opt-tp-max').value);
    const tpStep = parseFloat(document.getElementById('bt-opt-tp-step').value);
    const maxCombos = parseInt(document.getElementById('bt-opt-max').value) || 30;

    const combos = [];
    for (let sl = slMin; sl <= slMax + 0.001; sl += slStep) {
        for (let tp = tpMin; tp <= tpMax + 0.001; tp += tpStep) {
            if (tp > sl) combos.push({ sl: +sl.toFixed(2), tp: +tp.toFixed(2) });
        }
    }
    const limited = combos.slice(0, maxCombos);

    const btn      = document.getElementById('bt-opt-run-btn');
    const progEl   = document.getElementById('bt-opt-progress');
    btn.disabled   = true;
    progEl.style.display = '';

    const results = [];
    for (let i = 0; i < limited.length; i++) {
        const { sl, tp } = limited[i];
        progEl.textContent = `Testing combo ${i+1}/${limited.length}  SL×${sl}  TP×${tp}...`;
        await _sleep(8);

        const base = _makeStrategy(strategy, window._currentStrategyOptions || {});
        const modified = {
            analyze(id, candles, h4, rsiState, atr, sym, rsi) {
                const sig = base.analyze(id, candles, h4, rsiState, atr, sym, rsi);
                if (!sig) return null;
                return { ...sig, slMultiplier: sl, tpMultiplier: tp };
            }
        };

        const wf = await _walkForward(_cachedCandles, _cachedH4Candles, modified, stake, comm, document.getElementById('bt-symbol')?.value || '');
        results.push({
            sl, tp,
            confidence: wf.overfit.score,
            grade:      wf.overfit.grade,
            gradeColor: wf.overfit.color,
            oosWR:      wf.oos.stats.winRate,
            oosPF:      wf.oos.stats.profitFactor,
            oosNetPnL:  wf.oos.stats.netPnL,
            isWR:       wf.is.stats.winRate,
            trades:     wf.oos.stats.total,
        });
    }

    results.sort((a, b) => b.confidence - a.confidence);

    btn.disabled = false;
    progEl.style.display = 'none';
    _renderOptimizerResults(results, strategy);
};

function _renderOptimizerResults(results, strategy) {
    const el = document.getElementById('bt-optimizer-results');

    const top = results[0];

    el.innerHTML = `
    <div style="padding:10px 20px 20px;">
        <div class="bt-opt-best-banner">
            <div>
                <div style="font-size:0.52rem;font-weight:700;letter-spacing:0.1em;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:4px;">BEST COMBINATION</div>
                <div style="font-size:1rem;font-weight:800;color:var(--text-dark);font-family:var(--font-mono);">
                    SL ×${top.sl} &nbsp;·&nbsp; TP ×${top.tp}
                    <span style="font-size:0.7rem;font-weight:400;color:var(--text-muted);margin-left:8px;">R:R = ${(top.tp/top.sl).toFixed(2)}:1</span>
                </div>
                <div style="font-size:0.62rem;color:var(--text-muted);margin-top:3px;">
                    OOS ${top.oosWR.toFixed(1)}% WR · PF ${top.oosPF===Infinity?'∞':top.oosPF.toFixed(2)} · ${top.trades} trades
                </div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:2rem;font-weight:800;color:${top.gradeColor};font-family:var(--font-mono);">${top.confidence}</div>
                <div style="font-size:0.7rem;font-weight:700;color:${top.gradeColor};font-family:var(--font-mono);">${top.grade}</div>
                <div style="font-size:0.52rem;color:var(--text-muted);">confidence</div>
            </div>
        </div>

        <table class="bt-opt-table">
            <thead><tr>
                <th>#</th><th>SL ×ATR</th><th>TP ×ATR</th><th>R:R</th>
                <th>IS WR%</th><th>OOS WR%</th><th>OOS PF</th><th>NET P&L</th><th>TRADES</th><th>CONFIDENCE</th>
            </tr></thead>
            <tbody>
            ${results.map((r, i) => `
                <tr class="${i === 0 ? 'bt-opt-best-row' : ''}">
                    <td style="color:var(--text-muted)">${i+1}</td>
                    <td style="font-weight:700">${r.sl}</td>
                    <td style="font-weight:700">${r.tp}</td>
                    <td>${(r.tp/r.sl).toFixed(2)}</td>
                    <td style="color:${r.isWR>=50?'#10b981':'#ef4444'};font-weight:600">${r.isWR.toFixed(1)}%</td>
                    <td style="color:${r.oosWR>=50?'#10b981':'#ef4444'};font-weight:700">${r.oosWR.toFixed(1)}%</td>
                    <td style="color:${r.oosPF>=1?'#10b981':'#ef4444'};font-weight:600">${r.oosPF===Infinity?'∞':r.oosPF.toFixed(2)}</td>
                    <td style="color:${r.oosNetPnL>=0?'#10b981':'#ef4444'}">${r.oosNetPnL>=0?'+':''}${r.oosNetPnL.toFixed(2)}</td>
                    <td>${r.trades}</td>
                    <td><span style="font-weight:800;color:${r.gradeColor};font-family:var(--font-mono)">${r.confidence} ${r.grade}</span></td>
                </tr>
            `).join('')}
            </tbody>
        </table>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// SAVED STRATEGY CONFIGS (Supabase-backed, shared with Strategy Builder)
// ─────────────────────────────────────────────────────────────
async function _fetchSavedStrategies() {
    try {
        const res = await fetch('/api/user/strategies', { headers: Auth.headers() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { strategies } = await res.json();
        return strategies || {};
    } catch (e) {
        console.error('[Backtest] Failed to load saved strategies:', e.message);
        return {};
    }
}

async function _populateSavedStrategies() {
    const sel = document.getElementById('bt-saved-strategy');
    if (!sel) return;
    const strategies = await _fetchSavedStrategies();
    const current = sel.value;
    sel.innerHTML = '<option value="">— load saved config —</option>';
    Object.keys(strategies).sort().forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    });
    if (strategies[current]) sel.value = current;
}

window.btSaveStrategy = async function() {
    const name = prompt('Save this configuration as:');
    if (!name) return;

    const type = document.getElementById('bt-strategy')?.value || 'breakout';
    const payload = {
        type,
        options: window._currentStrategyOptions || {},
        notes: '',
        saved_at: new Date().toISOString(),
    };

    try {
        const res = await fetch('/api/user/strategies', {
            method: 'POST',
            headers: Auth.headers(),
            body: JSON.stringify({ name, strategy: payload }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await _populateSavedStrategies();
        const sel = document.getElementById('bt-saved-strategy');
        if (sel) sel.value = name;
        alert(`Saved "${name}"`);
    } catch (e) {
        console.error('[Backtest] Save failed:', e.message);
        alert('Failed to save strategy: ' + e.message);
    }
};

window.btLoadStrategy = async function(name) {
    if (!name) {
        window._currentStrategyOptions = {};
        return;
    }
    const strategies = await _fetchSavedStrategies();
    const strat = strategies[name];
    if (!strat) {
        alert(`Strategy "${name}" not found`);
        return;
    }

    window._currentStrategyOptions = strat.options || {};

    const stratSelect = document.getElementById('bt-strategy');
    if (stratSelect && strat.type) {
        stratSelect.value = strat.type;
        window.btStrategyChanged?.(strat.type);
    }

    console.log(`[Backtest] Loaded "${name}" (${strat.type}):`, strat.options);
};

export const Backtest = {

    init() {
        _populateSavedStrategies();

        document.getElementById('bt-run-btn')
            .addEventListener('click', _run);
        document.getElementById('bt-show-signals')
            .addEventListener('change', _toggleMarkers);
        document.getElementById('bt-export-btn')
            ?.addEventListener('click', _exportCSV);

        document.getElementById('bt-journal-btn')
            ?.addEventListener('click', _exportToJournal);

        document.getElementById('bt-tf')
            ?.addEventListener('change', window.btBuildCandleOptions);
        document.getElementById('bt-symbol')
            ?.addEventListener('change', window.btBuildCandleOptions);
        window.btBuildCandleOptions();

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

    const symbol      = document.getElementById('bt-symbol').value;
    const strategy    = document.getElementById('bt-strategy').value;
    const tf          = parseInt(document.getElementById('bt-tf').value);
    const count       = parseInt(document.getElementById('bt-count').value);
    const stake       = parseFloat(document.getElementById('bt-stake').value) || 1;
    const comm        = parseFloat(document.getElementById('bt-commission').value) || 0;
    const dateFrom    = document.getElementById('bt-date-from')?.value  || '';
    const dateTo      = document.getElementById('bt-date-to')?.value    || '';

    _setRunning(true);
    _setProgress(5, 'Connecting to Deriv...');
    const STRATEGY_LABELS = { breakout: 'BREAKOUT', vwap_reversion: 'VWAP REVERSION' };
    const strategyLabel = STRATEGY_LABELS[strategy] || strategy.toUpperCase();
    document.getElementById('bt-chart-title').textContent =
        `${symbol.replace('frx','').replace('cry','')}  ·  ${_tfLabel(tf)}  ·  ${strategyLabel}`;

    try {
        _setProgress(10, `Fetching ${count} candles...`);
        const candles = await _fetchCandles(symbol, tf, count, (done, total) => {
            _setProgress(10 + Math.round((done/total)*35), `Fetching candles ${done}/${total}...`);
        });

        let filteredCandles = candles;
        if (dateFrom || dateTo) {
            const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00Z').getTime() / 1000 : 0;
            const toTs   = dateTo   ? new Date(dateTo   + 'T23:59:59Z').getTime() / 1000 : Infinity;
            filteredCandles = candles.filter(c => c.time >= fromTs && c.time <= toTs);
            if (filteredCandles.length < 35) {
                throw new Error(`Date range too narrow — only ${filteredCandles.length} candles in window. Widen range or increase candle count.`);
            }
            _setProgress(53, `Date filter: ${filteredCandles.length} of ${candles.length} candles in range`);
            await _sleep(20);
        }

        let result, wf;

        // Fetch H4 candles for context
        _setProgress(50, `Fetching H4 candles...`);
        const h4Count   = Math.min(1000, Math.ceil(count * tf / H4_GRAN) + 100);
        const h4Candles = await _fetchCandles(symbol, H4_GRAN, h4Count, (d,t) => {
            _setProgress(50 + Math.round((d/t)*12), `H4 ${d}/${t}...`);
        });
        
        _setProgress(65, `Running BREAKOUT strategy...`);
        await _sleep(30);
        
        const stratObj = _makeStrategy(strategy, window._currentStrategyOptions || {});
        if (!stratObj) {
            _setProgress(0, `Error: "${strategy}" is not implemented in the backtest engine yet.`);
            _setRunning(false);
            _running = false;
            return;
        }
        
        result = _simulate(filteredCandles, h4Candles, stratObj, stake, comm, symbol);
        _setProgress(80, 'Walk-forward...');
        await _sleep(30);
        wf = await _walkForward(filteredCandles, h4Candles, stratObj, stake, comm, symbol);
        _cachedH4Candles = h4Candles;

        _setProgress(93, 'Rendering...');
        await _sleep(30);

        _renderChart(filteredCandles, result.trades, wf.splitTime);
        _renderEquity(result?.equity || [], wf);
        _renderKPIs(result, wf);
        _renderWalkForward(wf);
        _renderTradeLog(result.trades);

        if (wf.overfit?.isOverfit) {
            _showOverfitWarning(wf.overfit);
        }

        if (_btMode === 'compare') {
            const h4C = _cachedH4Candles || [];
            await _runComparison(filteredCandles, h4C, stake, comm);
        } else {
            document.getElementById('bt-compare-wrap').style.display = 'none';
        }

        document.getElementById('bt-chart-count').textContent =
            `${filteredCandles.length} candles · ${result.trades.length} signals · WF split @ bar ${wf.splitIdx || '—'}`;

        _trades          = result.trades;
        _wfResult        = wf;
        _cachedCandles   = filteredCandles;

        _setProgress(100, 'Complete');
        _sfx.play('complete');
        setTimeout(() => {
            document.getElementById('bt-progress').style.display = 'none';
            document.getElementById('bt-results').style.display  = '';
        }, 400);

    } catch(e) {
        console.error('[Backtest]', e);
        _setProgress(0, `Error: ${e.message}`);
        _sfx.play('error');
    }

    _setRunning(false);
    _running = false;
}

function _showOverfitWarning(overfit) {
    let el = document.getElementById('bt-overfit-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'bt-overfit-banner';
        el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;background:#1e293b;border:2px solid #ef4444;border-radius:10px;padding:16px 22px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:var(--font-mono,monospace);';
        document.body.appendChild(el);
    }
    el.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:1.5rem;flex-shrink:0">⚠️</div>
            <div>
                <div style="font-size:0.75rem;font-weight:800;color:#ef4444;letter-spacing:0.1em;margin-bottom:6px;">${overfit.verdict}</div>
                <div style="font-size:0.62rem;color:#94a3b8;line-height:1.6;">
                    ${overfit.warnings.map(w => `• ${w}`).join('<br>')}
                </div>
                <div style="margin-top:10px;font-size:0.6rem;color:#ef4444;">
                    This strategy should NOT be used with live money in this state.
                    Increase candle count, simplify rules, or try a different symbol.
                </div>
                <button onclick="document.getElementById('bt-overfit-banner').remove()"
                    style="margin-top:10px;padding:5px 14px;background:#ef444420;border:1px solid #ef4444;color:#ef4444;border-radius:5px;font-size:0.6rem;cursor:pointer;font-family:inherit;">
                    I understand
                </button>
            </div>
        </div>`;
    el.style.display = '';
}

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
    if (!canvas) return;
    
    // 👇 ADD THIS LINE: Safety fallback if equity data is missing or empty
    if (!equity || !Array.isArray(equity) || equity.length < 2) return;
    
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

    ctx.strokeStyle = 'rgba(100,116,139,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
    ctx.setLineDash([]);

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

function _renderKPIs(result, wf) {
    const s      = result.stats;
    const oos    = wf?.oos?.stats;
    const netPnL = result.equity[result.equity.length - 1] ?? 0;
    const wr     = (s.winRate * 100).toFixed(1);
    const pf     = s.profitFactor >= 999 ? '\u221e' : s.profitFactor.toFixed(2);
    const wrColor= s.winRate >= 0.70 ? '#10b981' : s.winRate >= 0.55 ? '#f59e0b' : '#ef4444';
    const rrColor= s.avgRR  >= 2.0  ? '#10b981' : s.avgRR  >= 1.5  ? '#f59e0b' : '#ef4444';
    const pos    = netPnL >= 0;

    _kpi('bt-pnl',        `${pos?'+':'-'}$${Math.abs(netPnL).toFixed(2)}`,  pos?'#10b981':'#ef4444');
    _kpi('bt-wr',         `${wr}%`,                                           wrColor);
    _kpi('bt-trades',     `${s.wins}W / ${s.losses}L`,                       '#64748b');
    _kpi('bt-dd',         `-$${s.maxDD.toFixed(2)}`,                          '#ef4444');
    _kpi('bt-rr',         `${s.avgRR.toFixed(2)}:1`,                          rrColor);
    _kpi('bt-pf',         pf,                                                  s.profitFactor>=1?'#10b981':'#ef4444');
    _kpi('bt-avg-win',    `+$${s.avgWin.toFixed(2)}`,                        '#10b981');
    _kpi('bt-avg-loss',   `-$${s.avgLoss.toFixed(2)}`,                       '#ef4444');
    _kpi('bt-max-streak', String(s.maxStreak),                                s.maxStreak>=5?'#ef4444':'#64748b');
    _kpi('bt-expectancy', `$${s.expectancy.toFixed(3)}`,                      s.expectancy>0?'#10b981':'#ef4444');

    const stake  = parseFloat(document.getElementById('bt-stake')?.value) || 1;
    const projEl = document.getElementById('bt-projection');
    if (projEl) {
        if (s.expectancy > 0) {
            const tradesNeeded = Math.ceil(Math.log(50/10) / Math.log(1 + s.expectancy/10));
            const pct = Math.min(100, Math.max(0, (netPnL / 40) * 100));
            projEl.innerHTML = `
                <div style="font-size:0.55rem;font-weight:700;letter-spacing:0.1em;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:5px;">$10 \u2192 $50 PROJECTION</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <div style="flex:1;height:6px;background:rgba(100,116,139,0.15);border-radius:3px;overflow:hidden;">
                        <div style="width:${pct.toFixed(0)}%;height:100%;background:${pct>=100?'#10b981':'#2563eb'};border-radius:3px;"></div>
                    </div>
                    <div style="font-size:0.6rem;font-weight:700;color:${pct>=100?'#10b981':'var(--text-dark)'};">
                        ${pct>=100 ? '\u2713 TARGET REACHED' : '~'+tradesNeeded+' trades at $'+stake+' stake'}
                    </div>
                </div>
                ${oos ? '<div style="font-size:0.58rem;color:var(--text-muted);margin-top:4px;">OOS: '+(oos.winRate*100).toFixed(1)+'% WR &middot; $'+oos.expectancy.toFixed(3)+' expectancy/trade</div>' : ''}
            `;
        } else {
            projEl.innerHTML = '<div style="font-size:0.6rem;color:#ef4444;font-family:var(--font-mono);">\u26a0 Negative expectancy \u2014 loses money on average. Do not go live.</div>';
        }
    }
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
    if (!wf) { el.innerHTML = '<div style="color:var(--text-muted);font-size:0.62rem;padding:8px">No walk-forward data</div>'; return; }

    const { is, oos, overfit } = wf;
    const c = overfit || wf.confidence;
    if (!c || !is || !oos) return;

    el.innerHTML = `
    <div class="wf-top-row">
        <div class="wf-confidence-card">
            <svg width="72" height="72" viewBox="0 0 72 72">
                <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(100,116,139,0.12)" stroke-width="6"/>
                <circle cx="36" cy="36" r="30" fill="none" stroke="${c.color}" stroke-width="6"
                    stroke-dasharray="${(c.score/100*188.5).toFixed(1)} 188.5"
                    stroke-dashoffset="47.1" stroke-linecap="round" transform="rotate(-90 36 36)"/>
                <text x="36" y="32" text-anchor="middle" font-size="15" font-weight="800" fill="${c.color}" font-family="DM Mono,monospace">${c.score}</text>
                <text x="36" y="46" text-anchor="middle" font-size="10" font-weight="700" fill="${c.color}" font-family="DM Mono,monospace">${c.grade}</text>
            </svg>
            <div class="wf-conf-label">OVERFIT<br>SCORE</div>
            <div class="wf-verdict" style="color:${c.color}">${c.verdict}</div>
        </div>
        <div class="wf-compare-card">
            <table class="wf-table">
                <thead><tr>
                    <th>METRIC</th>
                    <th style="color:#2563eb">IN-SAMPLE (60%)</th>
                    <th style="color:${oos.stats.netPnL>=0?'#10b981':'#ef4444'}">OUT-OF-SAMPLE (40%)</th>
                    <th>DELTA</th>
                </tr></thead>
                <tbody>
                    ${_wfRow('Win Rate',       (is.stats.winRate*100).toFixed(1)+'%',  (oos.stats.winRate*100).toFixed(1)+'%',  ((oos.stats.winRate-is.stats.winRate)*100).toFixed(1)+'%')}
                    ${_wfRow('Profit Factor',  is.stats.profitFactor>=999?'\u221e':is.stats.profitFactor.toFixed(2), oos.stats.profitFactor>=999?'\u221e':oos.stats.profitFactor.toFixed(2), null)}
                    ${_wfRow('Net P&L',        '$'+is.stats.netPnL.toFixed(2),        '$'+oos.stats.netPnL.toFixed(2),        null)}
                    ${_wfRow('Max Drawdown',   '-$'+is.stats.maxDD.toFixed(2),        '-$'+oos.stats.maxDD.toFixed(2),        null)}
                    ${_wfRow('Avg R:R',        is.stats.avgRR.toFixed(2)+':1',        oos.stats.avgRR.toFixed(2)+':1',        null)}
                    ${_wfRow('Trades',         String(is.stats.total),                String(oos.stats.total),                null)}
                    ${_wfRow('Max Loss Streak',String(is.stats.maxStreak),            String(oos.stats.maxStreak),            null)}
                    ${_wfRow('Expectancy',     '$'+is.stats.expectancy.toFixed(3),    '$'+oos.stats.expectancy.toFixed(3),    null)}
                </tbody>
            </table>
        </div>
    </div>
    ${c.warnings && c.warnings.length ? `
    <div class="wf-breakdown-card" style="margin-top:10px;">
        <div class="wf-sub-label" style="color:${c.isOverfit?'#ef4444':'#f59e0b'}">
            ${c.isOverfit ? '\u26a0 OVERFIT WARNINGS' : 'NOTES'}
        </div>
        ${c.warnings.map(w => `<div style="font-size:0.62rem;color:var(--text-body);padding:3px 0;line-height:1.5;">&#x2022; ${w}</div>`).join('')}
        ${c.isOverfit ? '<div style="margin-top:8px;font-size:0.62rem;color:#ef4444;font-weight:700;">This strategy is NOT ready for live money. Fix the warnings above first.</div>' : ''}
    </div>` : ''}
    `;
}

function _wfRow(label, isVal, oosVal, delta) {
    const dv = parseFloat(delta);
    const dc = delta ? (dv >= 0 ? '#10b981' : '#ef4444') : '';
    return `<tr>
        <td>${label}</td>
        <td style="color:#2563eb;font-weight:600">${isVal}</td>
        <td style="font-weight:600">${oosVal}</td>
        <td style="color:${dc};font-weight:600">${delta || '\u2014'}</td>
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

function _exportToJournal() {
    if (!_trades.length) {
        _showToast('⚠ Run a backtest first.');
        return;
    }

    const symbol   = document.getElementById('bt-symbol')?.value   || 'Unknown';
    const strategy = document.getElementById('bt-strategy')?.value || 'backtest';
    const closed   = _trades.filter(t => t.outcome === 'TP' || t.outcome === 'SL');

    if (!closed.length) {
        _showToast('⚠ No closed trades to export.');
        return;
    }

    closed.forEach(t => {
        SessionState.pushTrade({
            time:     t.time * 1000,
            symbol,
            strategy,
            type:     t.type,
            entry:    t.entry,
            exit:     t.exit,
            sl:       t.sl,
            tp:       t.tp,
            outcome:  t.outcome,
            pnl:      Math.abs(t.pnl ?? 0),
            source:   'backtest',
        });
    });

    _showToast(`📖 ${closed.length} trades sent to Journal`);
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

// ─────────────────────────────────────────────────────────────
// SOUND ALERTS
// ─────────────────────────────────────────────────────────────
const _sfx = {
    _ctx: null,
    _get() { return this._ctx || (this._ctx = new (window.AudioContext || window.webkitAudioContext)()); },
    play(type) {
        try {
            const ctx  = this._get();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            if (type === 'signal') {
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
                osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
            } else if (type === 'complete') {
                osc.frequency.setValueAtTime(660, ctx.currentTime);
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
                osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.24);
                gain.gain.setValueAtTime(0.25, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
                osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
            } else if (type === 'error') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(220, ctx.currentTime);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
            }
        } catch(e) {}
    }
};
export { _sfx as BacktestSFX };

// ─────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.getElementById('bt-run-btn')?.click();
    }
    if (e.key === 'Escape') {
        document.getElementById('bt-optimizer-wrap').style.display = 'none';
        document.getElementById('bt-compare-wrap').style.display   = 'none';
    }
    if (e.key === 'c' || e.key === 'C') window.btSetMode?.(_btMode === 'single' ? 'compare' : 'single');
    if (e.key === 'o' || e.key === 'O') window.btToggleOptimizer?.();
});

function _showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1e293b;color:white;
        padding:10px 18px;border-radius:8px;font-size:0.65rem;font-family:'DM Mono',monospace;
        z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}