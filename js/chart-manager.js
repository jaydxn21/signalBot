// js/chart-manager.js
// TWO MODES:
//   SPLIT MODE  — each bot has its own panel in the grid (uses per-bot ChartEngine)
//   FOCUS MODE  — one bot fills the main chart area (uses a single shared ChartEngine)
//
// Split mode uses #chart-grid with .chart-panel divs.
// Focus mode hides the grid and shows #chart-main-wrap (the original chart area).
// This way focus mode uses the exact same proven rendering path as the original app.

import { ChartEngine } from './chart-engine.js';

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const splitEngines = {};   // botId → ChartEngine (split mode, one per panel)
let   mainEngine   = null; // single ChartEngine for focus mode
let   _splitMode   = true;
let   _focusedId   = null;
let   _botData     = {};   // botId → { symbol, tf } labels

// ─────────────────────────────────────────────────────────────
// INIT — called once on page load to create the main engine
// ─────────────────────────────────────────────────────────────
export function initChartManager() {
    mainEngine = new ChartEngine('chart-main');
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
export const ChartManager = {

    addBot(botId, symbolLabel, tfLabel) {
        _botData[botId] = { symbolLabel, tfLabel };

        // Create split panel + engine
        if (!splitEngines[botId]) {
            const panel = _createPanel(botId, symbolLabel, tfLabel);
            document.getElementById('chart-grid').appendChild(panel);
            splitEngines[botId] = new ChartEngine(`chart-canvas-${botId}`);
        }

        _updateSplitGrid();
        _updateSplitBtn();
        return splitEngines[botId];
    },

    removeBot(botId) {
        const panel = document.getElementById(`chart-panel-${botId}`);
        if (panel) panel.remove();

        if (splitEngines[botId]) {
            try { splitEngines[botId].chart.remove(); } catch(e) {}
            delete splitEngines[botId];
        }
        delete _botData[botId];

        if (_focusedId === botId) {
            _focusedId = null;
            const remaining = Object.keys(splitEngines);
            if (remaining.length > 0) {
                ChartManager.focus(remaining[0]);
            } else {
                ChartManager.splitView();
            }
        }

        _updateSplitGrid();
        _updateSplitBtn();
    },

    // Returns the engine to use for a given bot right now
    get(botId) {
        if (!_splitMode && _focusedId === botId) {
            return mainEngine;
        }
        return splitEngines[botId] || null;
    },

    // Expand a bot to full screen using the main engine
    focus(botId) {
        _focusedId = botId;
        _splitMode = false;

        // Show main chart, hide grid
        document.getElementById('chart-main-wrap').style.display = 'flex';
        document.getElementById('chart-grid').style.display      = 'none';

        _updateSplitBtn();
        _highlightCard(botId);
    },

    // Load candle data into the focused main chart
    // Called from signal-bot.js after focus() with the bot's candles
    loadMain(botId, candles) {
        if (!mainEngine) return;
        if (candles && candles.length > 0) {
            mainEngine.setData(candles);
        }
    },

    // Return to split grid
    splitView() {
        _splitMode = true;
        _focusedId = null;

        document.getElementById('chart-main-wrap').style.display = 'none';
        document.getElementById('chart-grid').style.display      = 'grid';

        // Notify signal-bot to hide overlay panel
        if (window.onSplitView) window.onSplitView();

        // Resize all split engines after layout change
        setTimeout(() => {
            Object.entries(splitEngines).forEach(([id, engine]) => {
                const c = document.getElementById(`chart-canvas-${id}`);
                if (c) {
                    engine.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
                    engine.chart.timeScale().fitContent();
                }
            });
        }, 60);

        _updateSplitBtn();
    },

    updateLabel(botId, symbolLabel, tfLabel) {
        _botData[botId] = { symbolLabel, tfLabel };
        const lbl = document.getElementById(`chart-label-${botId}`);
        const tf  = document.getElementById(`chart-tf-${botId}`);
        if (lbl) lbl.textContent = symbolLabel;
        if (tf)  tf.textContent  = tfLabel;
    },

    count()       { return Object.keys(splitEngines).length; },
    isSplitMode() { return _splitMode; },
    focusedId()   { return _focusedId; },
    mainEngine()  { return mainEngine; },

    // Update the per-panel mini HUD in split mode
    updatePanelHUD(botId, rsi, atr, marketCond) {
        _setPanelHUD(botId, rsi, atr, marketCond);
    },
};

// ─────────────────────────────────────────────────────────────
// CREATE SPLIT PANEL
// ─────────────────────────────────────────────────────────────
function _createPanel(botId, symbolLabel, tfLabel) {
    const panel = document.createElement('div');
    panel.id        = `chart-panel-${botId}`;
    panel.className = 'chart-panel';

    panel.innerHTML = `
        <div class="chart-panel-header">
            <div style="display:flex;align-items:center;gap:8px;">
                <span id="chart-label-${botId}" class="mono chart-panel-symbol">${symbolLabel}</span>
                <span id="chart-tf-${botId}" class="chart-panel-tf">${tfLabel}</span>
            </div>
            <div class="chart-panel-hud">
                <span class="chart-hud-item">RSI <span id="panel-rsi-${botId}" class="chart-hud-val">—</span></span>
                <span class="chart-hud-item">ATR <span id="panel-atr-${botId}" class="chart-hud-val atr">—</span></span>
                <span class="chart-hud-item"><span id="panel-bias-${botId}" class="chart-hud-val">—</span></span>
            </div>
            <button class="chart-expand-btn" title="Expand to full screen">⤢</button>
        </div>
        <div id="chart-canvas-${botId}" class="chart-canvas"></div>
    `;

    panel.querySelector('.chart-expand-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        // Tell signal-bot to focus this bot (which calls ChartManager.focus + loadMain)
        if (window.focusBot) window.focusBot(botId);
    });

    panel.querySelector('.chart-panel-header').addEventListener('click', () => {
        if (Object.keys(splitEngines).length > 1 && window.focusBot) {
            window.focusBot(botId);
        }
    });

    return panel;
}

// ─────────────────────────────────────────────────────────────
// GRID LAYOUT
// ─────────────────────────────────────────────────────────────
function _updateSplitGrid() {
    const grid  = document.getElementById('chart-grid');
    const count = Object.keys(splitEngines).length;
    if (!grid) return;

    grid.className = 'chart-grid';
    if      (count <= 1) grid.classList.add('chart-grid-single');
    else if (count === 2) grid.classList.add('chart-grid-2');
    else if (count === 3) grid.classList.add('chart-grid-3');
    else                  grid.classList.add('chart-grid-4');

    // Show/hide placeholder
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph) ph.style.display = count === 0 ? 'flex' : 'none';
}

// ─────────────────────────────────────────────────────────────
// SPLIT VIEW BUTTON — appears in header when >1 bot and in focus mode
// ─────────────────────────────────────────────────────────────
function _updateSplitBtn() {
    let btn = document.getElementById('btn-split-view');
    if (!btn) {
        btn = document.createElement('button');
        btn.id            = 'btn-split-view';
        btn.className     = 'btn-pro btn-outline';
        btn.style.cssText = 'font-size:0.62rem;padding:6px 12px;letter-spacing:0.06em;display:none;';
        btn.textContent   = '⊞ Split View';
        btn.addEventListener('click', () => ChartManager.splitView());
        const hud = document.getElementById('chart-hud-single');
        if (hud) hud.insertBefore(btn, hud.firstChild);
    }

    const showBtn = !_splitMode && Object.keys(splitEngines).length > 1;
    btn.style.display = showBtn ? 'inline-flex' : 'none';
}

function _highlightCard(botId) {
    document.querySelectorAll('.bot-card').forEach(c => c.style.outline = 'none');
    const card = document.querySelector(`.bot-card[data-bot-id="${botId}"]`);
    if (card) card.style.outline = '2px solid var(--accent-light)';
}

function _setPanelHUD(botId, rsi, atr, marketCond) {
    const rsiEl  = document.getElementById(`panel-rsi-${botId}`);
    const atrEl  = document.getElementById(`panel-atr-${botId}`);
    const biasEl = document.getElementById(`panel-bias-${botId}`);
    if (rsiEl)  rsiEl.textContent  = rsi  ? rsi.toFixed(1) : '—';
    if (atrEl)  atrEl.textContent  = atr  ? atr.toFixed(5) : '—';
    if (biasEl) {
        biasEl.textContent = marketCond || '—';
        biasEl.style.color = marketCond === 'TRENDING' ? 'var(--accent2)' : 'var(--text-muted)';
    }
}