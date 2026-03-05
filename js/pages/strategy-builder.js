// js/pages/strategy-builder.js
// Strategy Builder — visual rule composer with:
// - Load & edit existing coded strategies (shows their params visually)
// - Build custom strategies from scratch
// - Inline walk-forward backtest
// - Suggestion engine feedback
// - Export as .js strategy file
// - Save to localStorage for use in live bots + backtest page

import { _fetchCandles, _simulate, _sleep, CHUNK_SIZE } from '../backtest-core.js';
import { WalkForward, SuggestionEngine }                from '../walk-forward.js';

// ─────────────────────────────────────────────────────────────
// INDICATOR DEFINITIONS
// What appears in the rule dropdowns
// ─────────────────────────────────────────────────────────────
const INDICATORS = [
    { value: 'rsi',           label: 'RSI (14)',           type: 'number',  defaultVal: 50   },
    { value: 'ema8',          label: 'EMA 8',              type: 'price',   defaultVal: null },
    { value: 'ema20',         label: 'EMA 20',             type: 'price',   defaultVal: null },
    { value: 'ema50',         label: 'EMA 50',             type: 'price',   defaultVal: null },
    { value: 'ema200',        label: 'EMA 200',            type: 'price',   defaultVal: null },
    { value: 'h4_ema21',      label: 'H4 EMA 21',          type: 'price',   defaultVal: null },
    { value: 'atr',           label: 'ATR (14)',           type: 'number',  defaultVal: null },
    { value: 'bb_upper',      label: 'BB Upper (20,2)',    type: 'price',   defaultVal: null },
    { value: 'bb_lower',      label: 'BB Lower (20,2)',    type: 'price',   defaultVal: null },
    { value: 'bb_mid',        label: 'BB Mid (20)',        type: 'price',   defaultVal: null },
    { value: 'price',         label: 'Close Price',        type: 'price',   defaultVal: null },
    { value: 'candle_body',   label: 'Candle Body Size',   type: 'number',  defaultVal: null },
    { value: 'volume_rel',    label: 'Relative Volume',    type: 'number',  defaultVal: 1.0  },
    { value: 'vwap',          label: 'VWAP',               type: 'price',   defaultVal: null },
    { value: 'prev_high',     label: 'Previous High',      type: 'price',   defaultVal: null },
    { value: 'prev_low',      label: 'Previous Low',       type: 'price',   defaultVal: null },
];

const CONDITIONS_NUMBER = [
    { value: 'gt',       label: 'is above'       },
    { value: 'lt',       label: 'is below'       },
    { value: 'between',  label: 'is between'     },
    { value: 'crosses_above', label: 'crosses above' },
    { value: 'crosses_below', label: 'crosses below' },
];

const CONDITIONS_PRICE = [
    { value: 'price_above', label: 'price above'   },
    { value: 'price_below', label: 'price below'   },
    { value: 'crosses_above', label: 'crosses above' },
    { value: 'crosses_below', label: 'crosses below' },
];

// ─────────────────────────────────────────────────────────────
// EXISTING STRATEGY DEFINITIONS
// Visual representation of coded strategies — editable params
// ─────────────────────────────────────────────────────────────
const EXISTING_STRATEGIES = {
    trend: {
        name:        'trend',
        displayName: 'Trend Follow',
        slMult:      1.0,
        tpMult:      2.0,
        warmup:      50,
        minBars:     2,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 0,
        sessionTo:   23,
        sessionEnabled: false,
        buyRules: [
            { indicator: 'price',  condition: 'price_above', value: 'ema50',  value2: null },
            { indicator: 'ema20',  condition: 'price_above', value: 'ema50',  value2: null },
            { indicator: 'rsi',    condition: 'between',     value: '30',     value2: '48' },
        ],
        sellRules: [
            { indicator: 'price',  condition: 'price_below', value: 'ema50',  value2: null },
            { indicator: 'ema20',  condition: 'price_below', value: 'ema50',  value2: null },
            { indicator: 'rsi',    condition: 'between',     value: '52',     value2: '70' },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'Pullback entries in established trend direction. EMA20/50 alignment + RSI pullback.',
    },
    vwap_reversion: {
        name:        'vwap_reversion',
        displayName: 'VWAP Reversion',
        slMult:      1.2,
        tpMult:      1.8,
        warmup:      50,
        minBars:     2,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 7,
        sessionTo:   20,
        sessionEnabled: true,
        buyRules: [
            { indicator: 'price',  condition: 'price_below', value: 'vwap',   value2: null },
            { indicator: 'rsi',    condition: 'lt',          value: '40',     value2: null },
            { indicator: 'candle_body', condition: 'gt',     value: '0.3',    value2: null },
        ],
        sellRules: [
            { indicator: 'price',  condition: 'price_above', value: 'vwap',   value2: null },
            { indicator: 'rsi',    condition: 'gt',          value: '60',     value2: null },
            { indicator: 'candle_body', condition: 'gt',     value: '0.3',    value2: null },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'Mean reversion to VWAP. Price extended from VWAP + RSI extreme + body confirmation.',
    },
    h4_kiss: {
        name:        'h4_kiss',
        displayName: 'KISS H4',
        slMult:      1.0,
        tpMult:      2.5,
        warmup:      21,
        minBars:     3,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 7,
        sessionTo:   17,
        sessionEnabled: true,
        buyRules: [
            { indicator: 'price',   condition: 'price_above', value: 'h4_ema21', value2: null },
            { indicator: 'h4_ema21', condition: 'price_above', value: 'ema50',   value2: null },
            { indicator: 'rsi',     condition: 'between',      value: '40',      value2: '60' },
        ],
        sellRules: [
            { indicator: 'price',   condition: 'price_below', value: 'h4_ema21', value2: null },
            { indicator: 'h4_ema21', condition: 'price_below', value: 'ema50',   value2: null },
            { indicator: 'rsi',     condition: 'between',      value: '40',      value2: '60' },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'Price kissing H4 EMA21 in trend direction. H4 alignment + M5 pullback to level.',
    },
    range_boundary: {
        name:        'range_boundary',
        displayName: 'Range Boundary',
        slMult:      1.5,
        tpMult:      2.0,
        warmup:      20,
        minBars:     2,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 0,
        sessionTo:   23,
        sessionEnabled: false,
        buyRules: [
            { indicator: 'price',  condition: 'price_above', value: 'bb_lower', value2: null },
            { indicator: 'rsi',    condition: 'lt',          value: '35',       value2: null },
            { indicator: 'bb_lower', condition: 'price_above', value: 'prev_low', value2: null },
        ],
        sellRules: [
            { indicator: 'price',  condition: 'price_below', value: 'bb_upper', value2: null },
            { indicator: 'rsi',    condition: 'gt',          value: '65',       value2: null },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'Fade moves to BB extremes. Buy near lower band with RSI oversold, sell near upper.',
    },
    synthetic_scalp: {
        name:        'synthetic_scalp',
        displayName: 'BB+RSI Synthetic',
        slMult:      1.2,
        tpMult:      1.5,
        warmup:      20,
        minBars:     1,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 0,
        sessionTo:   23,
        sessionEnabled: false,
        buyRules: [
            { indicator: 'rsi',    condition: 'lt',          value: '30',       value2: null },
            { indicator: 'price',  condition: 'price_above', value: 'bb_lower', value2: null },
        ],
        sellRules: [
            { indicator: 'rsi',    condition: 'gt',          value: '70',       value2: null },
            { indicator: 'price',  condition: 'price_below', value: 'bb_upper', value2: null },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'RSI extreme + BB touch on synthetic indices. Fast scalp — tight SL.',
    },
    momentum: {
        name:        'momentum',
        displayName: 'Momentum',
        slMult:      1.5,
        tpMult:      2.0,
        warmup:      50,
        minBars:     2,
        allowBuy:    true,
        allowSell:   true,
        sessionFrom: 8,
        sessionTo:   17,
        sessionEnabled: true,
        buyRules: [
            { indicator: 'ema8',   condition: 'crosses_above', value: 'ema20',  value2: null },
            { indicator: 'rsi',    condition: 'gt',            value: '50',     value2: null },
            { indicator: 'price',  condition: 'price_above',   value: 'ema50',  value2: null },
        ],
        sellRules: [
            { indicator: 'ema8',   condition: 'crosses_below', value: 'ema20',  value2: null },
            { indicator: 'rsi',    condition: 'lt',            value: '50',     value2: null },
            { indicator: 'price',  condition: 'price_below',   value: 'ema50',  value2: null },
        ],
        buyLogic:  'AND',
        sellLogic: 'AND',
        note: 'EMA8/20 crossover with trend confirmation. Classic momentum entry.',
    },
};

// Default empty strategy
const EMPTY_STRATEGY = {
    name: 'my_strategy', displayName: 'My Strategy',
    slMult: 1.5, tpMult: 2.0, warmup: 50, minBars: 2,
    allowBuy: true, allowSell: true,
    sessionFrom: 0, sessionTo: 23, sessionEnabled: false,
    buyRules: [], sellRules: [],
    buyLogic: 'AND', sellLogic: 'AND',
    note: '',
};

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _state = JSON.parse(JSON.stringify(EMPTY_STRATEGY));
let _ruleIdCounter = 0;

// ─────────────────────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────────────────────
export const StrategyBuilder = {
    init() {
        _loadSavedStrategies();
        _bindEvents();
        _renderRules();
        _renderPreview();
        window.sbAddRule     = _addRule;
        window.sbRemoveRule  = _removeRule;
        window.sbToggleLogic = _toggleLogic;
        window.sbRuleChanged = _onRuleChanged;
    },
};

// ─────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────
function _bindEvents() {
    document.getElementById('sb-load-btn')
        .addEventListener('click', _loadStrategy);

    document.getElementById('sb-save-btn')
        .addEventListener('click', _saveStrategy);

    document.getElementById('sb-test-btn')
        .addEventListener('click', _runBacktest);

    document.getElementById('sb-bt-run-btn')
        .addEventListener('click', _runBacktest);

    document.getElementById('sb-export-code-btn')
        .addEventListener('click', _exportCode);

    // Live preview update on any param change
    ['sb-name','sb-sl-mult','sb-tp-mult','sb-warmup','sb-min-bars',
     'sb-session-from','sb-session-to','sb-session-enabled',
     'sb-allow-buy','sb-allow-sell'].forEach(id => {
        document.getElementById(id)
            ?.addEventListener('change', () => { _readParams(); _renderPreview(); });
    });
}

// ─────────────────────────────────────────────────────────────
// LOAD EXISTING STRATEGY
// ─────────────────────────────────────────────────────────────
function _loadStrategy() {
    const val = document.getElementById('sb-base-strategy').value;
    if (val === '__new__') {
        _state = JSON.parse(JSON.stringify(EMPTY_STRATEGY));
    } else {
        // Check built-in first
        const builtin = EXISTING_STRATEGIES[val];
        if (builtin) {
            _state = JSON.parse(JSON.stringify(builtin));
        } else {
            // Try saved custom strategies
            const saved = JSON.parse(localStorage.getItem('nexus_strategies') || '{}');
            if (saved[val]) _state = JSON.parse(JSON.stringify(saved[val]));
        }
    }
    _populateForm();
    _renderRules();
    _renderPreview();
}

function _populateForm() {
    const s = _state;
    _set('sb-name',           s.name);
    _set('sb-sl-mult',        s.slMult);
    _set('sb-tp-mult',        s.tpMult);
    _set('sb-warmup',         s.warmup);
    _set('sb-min-bars',       s.minBars);
    _set('sb-session-from',   s.sessionFrom);
    _set('sb-session-to',     s.sessionTo);
    document.getElementById('sb-session-enabled').checked = s.sessionEnabled;
    document.getElementById('sb-allow-buy').checked       = s.allowBuy;
    document.getElementById('sb-allow-sell').checked      = s.allowSell;
    document.getElementById('sb-buy-logic-label').textContent  = s.buyLogic  === 'AND' ? 'ALL (AND)' : 'ANY (OR)';
    document.getElementById('sb-sell-logic-label').textContent = s.sellLogic === 'AND' ? 'ALL (AND)' : 'ANY (OR)';
}

// ─────────────────────────────────────────────────────────────
// READ PARAMS FROM FORM
// ─────────────────────────────────────────────────────────────
function _readParams() {
    _state.name           = document.getElementById('sb-name').value || 'my_strategy';
    _state.slMult         = parseFloat(document.getElementById('sb-sl-mult').value) || 1.5;
    _state.tpMult         = parseFloat(document.getElementById('sb-tp-mult').value) || 2.0;
    _state.warmup         = parseInt(document.getElementById('sb-warmup').value)    || 50;
    _state.minBars        = parseInt(document.getElementById('sb-min-bars').value)  || 2;
    _state.sessionFrom    = parseInt(document.getElementById('sb-session-from').value) || 0;
    _state.sessionTo      = parseInt(document.getElementById('sb-session-to').value)   || 23;
    _state.sessionEnabled = document.getElementById('sb-session-enabled').checked;
    _state.allowBuy       = document.getElementById('sb-allow-buy').checked;
    _state.allowSell      = document.getElementById('sb-allow-sell').checked;
}

// ─────────────────────────────────────────────────────────────
// RULES
// ─────────────────────────────────────────────────────────────
function _addRule(dir) {
    const rules = dir === 'buy' ? _state.buyRules : _state.sellRules;
    rules.push({ id: ++_ruleIdCounter, indicator: 'rsi', condition: 'lt', value: '50', value2: null });
    _renderRules();
    _renderPreview();
}

function _removeRule(dir, id) {
    const key = dir === 'buy' ? 'buyRules' : 'sellRules';
    _state[key] = _state[key].filter((_, i) => i !== parseInt(id));
    _renderRules();
    _renderPreview();
}

function _toggleLogic(dir) {
    const key   = dir === 'buy' ? 'buyLogic' : 'sellLogic';
    const label = dir === 'buy' ? 'sb-buy-logic-label' : 'sb-sell-logic-label';
    _state[key] = _state[key] === 'AND' ? 'OR' : 'AND';
    document.getElementById(label).textContent = _state[key] === 'AND' ? 'ALL (AND)' : 'ANY (OR)';
    _renderPreview();
}

function _onRuleChanged(dir, idx, field, val) {
    const key = dir === 'buy' ? 'buyRules' : 'sellRules';
    if (_state[key][idx]) {
        _state[key][idx][field] = val;
        if (field === 'indicator') {
            // Reset condition to sensible default for new indicator
            const ind = INDICATORS.find(i => i.value === val);
            _state[key][idx].condition = ind?.type === 'price' ? 'price_above' : 'gt';
            _state[key][idx].value     = ind?.defaultVal != null ? String(ind.defaultVal) : '50';
            _state[key][idx].value2    = null;
        }
        _renderRules();
        _renderPreview();
    }
}

// ─────────────────────────────────────────────────────────────
// RENDER RULES
// ─────────────────────────────────────────────────────────────
function _renderRules() {
    _renderRuleList('buy');
    _renderRuleList('sell');
}

function _renderRuleList(dir) {
    const el    = document.getElementById(`sb-${dir}-rules`);
    const rules = dir === 'buy' ? _state.buyRules : _state.sellRules;
    const color = dir === 'buy' ? '#10b981' : '#ef4444';

    if (!rules.length) {
        el.innerHTML = `<div class="sb-no-rules">No conditions — signal fires on every bar</div>`;
        return;
    }

    el.innerHTML = rules.map((r, idx) => {
        const ind        = INDICATORS.find(i => i.value === r.indicator) || INDICATORS[0];
        const conditions = ind.type === 'price' ? CONDITIONS_PRICE : CONDITIONS_NUMBER;
        const isBetween  = r.condition === 'between';

        // Value input: if condition compares to another indicator, show indicator select
        const compareIndicators = INDICATORS.filter(i => i.value !== r.indicator);
        const isIndicatorCompare = compareIndicators.some(i => i.value === r.value);

        return `
        <div class="sb-rule" style="border-left:3px solid ${color}22;">
            <div class="sb-rule-row">
                <span class="sb-rule-num">${idx + 1}</span>

                <!-- Indicator -->
                <select class="sb-mini-select" onchange="window.sbRuleChanged('${dir}',${idx},'indicator',this.value)">
                    ${INDICATORS.map(i => `<option value="${i.value}" ${i.value===r.indicator?'selected':''}>${i.label}</option>`).join('')}
                </select>

                <!-- Condition -->
                <select class="sb-mini-select" onchange="window.sbRuleChanged('${dir}',${idx},'condition',this.value)">
                    ${conditions.map(c => `<option value="${c.value}" ${c.value===r.condition?'selected':''}>${c.label}</option>`).join('')}
                </select>

                <!-- Value — number or indicator reference -->
                <select class="sb-mini-select sb-mini-select-value" onchange="window.sbRuleChanged('${dir}',${idx},'value',this.value)">
                    <optgroup label="— Fixed Value —">
                        <option value="__custom__" ${!isIndicatorCompare?'selected':''}>fixed value...</option>
                    </optgroup>
                    <optgroup label="— Compare to Indicator —">
                        ${compareIndicators.map(i => `<option value="${i.value}" ${i.value===r.value?'selected':''}>${i.label}</option>`).join('')}
                    </optgroup>
                </select>

                ${!isIndicatorCompare ? `
                    <input type="number" class="sb-mini-input" step="any"
                        value="${r.value}"
                        onchange="window.sbRuleChanged('${dir}',${idx},'value',this.value)"
                        placeholder="value">
                ` : ''}

                ${isBetween ? `
                    <span style="font-size:0.6rem;color:var(--text-muted)">and</span>
                    <input type="number" class="sb-mini-input" step="any"
                        value="${r.value2 || ''}"
                        onchange="window.sbRuleChanged('${dir}',${idx},'value2',this.value)"
                        placeholder="max">
                ` : ''}

                <button class="sb-rule-remove" onclick="window.sbRemoveRule('${dir}',${idx})" title="Remove">✕</button>
            </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// PREVIEW CODE GENERATOR
// ─────────────────────────────────────────────────────────────
function _renderPreview() {
    const el = document.getElementById('sb-preview-code');
    if (!el) return;
    _readParams();
    const code = _generateCode(_state, true); // true = preview mode (readable)
    el.innerHTML = `<pre class="sb-code">${_highlight(code)}</pre>`;
}

function _highlight(code) {
    return code
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/(\/\/[^\n]*)/g,     '<span class="hl-comment">$1</span>')
        .replace(/\b(if|return|const|let|null|true|false|function|export)\b/g, '<span class="hl-keyword">$1</span>')
        .replace(/\b(\d+\.?\d*)\b/g,  '<span class="hl-number">$1</span>')
        .replace(/('[^']*')/g,         '<span class="hl-string">$1</span>');
}

// ─────────────────────────────────────────────────────────────
// CODE GENERATOR
// Generates a real strategy-engine compatible .js file
// ─────────────────────────────────────────────────────────────
function _generateCode(s, preview = false) {
    const buyRuleCode  = _rulesToCode(s.buyRules,  s.buyLogic,  'BUY');
    const sellRuleCode = _rulesToCode(s.sellRules, s.sellLogic, 'SELL');
    const className    = _toPascalCase(s.name) + 'Strategy';

    return `// ${s.name}.js — Generated by NEXUS Strategy Builder
// ${s.note || 'Custom strategy'}

export const ${className} = {

    checkEntry(candles, rsiState, h4Candles) {
        if (candles.length < ${s.warmup}) return null;

        const closed = candles.slice(0, -1);
        const bar    = closed[closed.length - 1];
        const prev   = closed[closed.length - 2];
        if (!bar || !prev) return null;

        // ── INDICATORS ──
        const rsi     = _calcRSI(closed, rsiState);
        const ema8    = _ema(closed, 8);
        const ema20   = _ema(closed, 20);
        const ema50   = _ema(closed, 50);
        const ema200  = _ema(closed, 200);
        const atr     = _atr(closed, 14);
        const bb      = _bb(closed, 20, 2);
        const h4ema21 = h4Candles?.length >= 21 ? _ema(h4Candles, 21) : null;
        const vwap    = _vwap(closed);
        const prevHigh = Math.max(...closed.slice(-20).map(c => c.high));
        const prevLow  = Math.min(...closed.slice(-20).map(c => c.low));
        const candleBody = Math.abs(bar.close - bar.open) / (atr || 1);

${s.sessionEnabled ? `        // ── SESSION FILTER ──
        const hour = new Date(bar.time * 1000).getUTCHours();
        const jaHour = (hour - 5 + 24) % 24; // Jamaica EST
        if (jaHour < ${s.sessionFrom} || jaHour > ${s.sessionTo}) return null;
` : ''}
${s.allowBuy ? `        // ── BUY SIGNAL ──
${buyRuleCode}
        if (buySignal) {
            return { type: 'BUY', label: '${s.displayName || s.name} Buy',
                     slMultiplier: ${s.slMult}, tpMultiplier: ${s.tpMult} };
        }
` : ''}
${s.allowSell ? `        // ── SELL SIGNAL ──
${sellRuleCode}
        if (sellSignal) {
            return { type: 'SELL', label: '${s.displayName || s.name} Sell',
                     slMultiplier: ${s.slMult}, tpMultiplier: ${s.tpMult} };
        }
` : ''}
        return null;
    },
};

// ── INDICATOR HELPERS ──
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) e = candles[i].close * k + e * (1 - k);
    return e;
}
function _calcRSI(candles, state, period = 14) {
    if (candles.length < 2) return 50;
    const d = candles[candles.length-1].close - candles[candles.length-2].close;
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (!state.initialized) { state.prevAvgGain = g; state.prevAvgLoss = l; state.initialized = true; }
    const k = 1/period;
    state.prevAvgGain = state.prevAvgGain*(1-k) + g*k;
    state.prevAvgLoss = state.prevAvgLoss*(1-k) + l*k;
    return state.prevAvgLoss === 0 ? 100 : 100 - 100/(1 + state.prevAvgGain/state.prevAvgLoss);
}
function _atr(candles, period = 14) {
    if (candles.length < period+1) return null;
    const trs = candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
    return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function _bb(candles, period = 20, mult = 2) {
    if (candles.length < period) return null;
    const slice = candles.slice(-period).map(c => c.close);
    const mid   = slice.reduce((a,b)=>a+b,0)/period;
    const std   = Math.sqrt(slice.reduce((s,v)=>s+(v-mid)**2,0)/period);
    return { upper: mid+mult*std, lower: mid-mult*std, mid };
}
function _vwap(candles) {
    let tv = 0, tpv = 0;
    candles.forEach(c => { const v = c.volume || 1; tv += v; tpv += ((c.high+c.low+c.close)/3)*v; });
    return tv > 0 ? tpv/tv : candles[candles.length-1]?.close;
}`;
}

function _rulesToCode(rules, logic, dir) {
    if (!rules.length) return `        const ${dir.toLowerCase()}Signal = true;`;

    const op   = logic === 'AND' ? ' &&\n            ' : ' ||\n            ';
    const conds = rules.map(r => _ruleToCondition(r)).filter(Boolean);

    if (!conds.length) return `        const ${dir.toLowerCase()}Signal = false;`;

    return `        const ${dir.toLowerCase()}Signal =\n            ${conds.join(op)};`;
}

function _ruleToCondition(r) {
    const lhs = _indicatorExpr(r.indicator);
    const rhs = _isIndicatorRef(r.value) ? _indicatorExpr(r.value) : r.value;

    switch (r.condition) {
        case 'gt':            return `${lhs} != null && ${lhs} > ${rhs}`;
        case 'lt':            return `${lhs} != null && ${lhs} < ${rhs}`;
        case 'between':       return `${lhs} != null && ${lhs} > ${r.value} && ${lhs} < ${r.value2 || rhs}`;
        case 'price_above':   return `bar.close > ${rhs}`;
        case 'price_below':   return `bar.close < ${rhs}`;
        case 'crosses_above': return `prev.close <= ${_indicatorExprPrev(r.value)} && bar.close > ${rhs}`;
        case 'crosses_below': return `prev.close >= ${_indicatorExprPrev(r.value)} && bar.close < ${rhs}`;
        default:              return `/* unknown condition: ${r.condition} */`;
    }
}

function _indicatorExpr(ind) {
    const map = {
        rsi: 'rsi', ema8: 'ema8', ema20: 'ema20', ema50: 'ema50', ema200: 'ema200',
        h4_ema21: 'h4ema21', atr: 'atr', bb_upper: 'bb?.upper', bb_lower: 'bb?.lower',
        bb_mid: 'bb?.mid', price: 'bar.close', candle_body: 'candleBody',
        vwap: 'vwap', prev_high: 'prevHigh', prev_low: 'prevLow', volume_rel: '1',
    };
    return map[ind] || ind;
}

function _indicatorExprPrev(ind) {
    // Previous bar version for crossover detection
    return ind === 'ema8' ? '_ema(closed.slice(0,-1), 8)'
         : ind === 'ema20' ? '_ema(closed.slice(0,-1), 20)'
         : _indicatorExpr(ind);
}

function _isIndicatorRef(val) {
    return INDICATORS.some(i => i.value === val);
}

function _toPascalCase(str) {
    return str.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────
// SAVE / LOAD
// ─────────────────────────────────────────────────────────────
function _saveStrategy() {
    _readParams();
    const saved = JSON.parse(localStorage.getItem('nexus_strategies') || '{}');
    saved[_state.name] = JSON.parse(JSON.stringify(_state));
    localStorage.setItem('nexus_strategies', JSON.stringify(saved));
    _loadSavedStrategies();
    _showToast(`Strategy "${_state.name}" saved`);
}

function _loadSavedStrategies() {
    const saved  = JSON.parse(localStorage.getItem('nexus_strategies') || '{}');
    const select = document.getElementById('sb-base-strategy');
    if (!select) return;

    // Remove old custom options
    const existing = select.querySelector('optgroup[label="📁 Saved Custom"]');
    if (existing) {
        while (existing.firstChild) existing.removeChild(existing.firstChild);
        Object.keys(saved).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = saved[name].displayName || name;
            existing.appendChild(opt);
        });
    }
}

// ─────────────────────────────────────────────────────────────
// EXPORT CODE
// ─────────────────────────────────────────────────────────────
function _exportCode() {
    _readParams();
    const code = _generateCode(_state, false);
    const blob = new Blob([code], { type: 'text/javascript' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${_state.name}.js`;
    a.click();
    _showToast(`Exported ${_state.name}.js`);
}

// ─────────────────────────────────────────────────────────────
// QUICK BACKTEST
// ─────────────────────────────────────────────────────────────
async function _runBacktest() {
    _readParams();

    const symbol = document.getElementById('sb-bt-symbol').value;
    const tf     = parseInt(document.getElementById('sb-bt-tf').value);
    const count  = parseInt(document.getElementById('sb-bt-count').value);
    const stake  = parseFloat(document.getElementById('sb-bt-stake').value) || 10;

    const runBtn  = document.getElementById('sb-bt-run-btn');
    const testBtn = document.getElementById('sb-test-btn');
    const prog    = document.getElementById('sb-bt-progress');

    runBtn.disabled  = true;
    testBtn.disabled = true;
    prog.style.display = '';
    prog.textContent   = 'Fetching candles...';

    try {
        const candles = await _fetchCandles(symbol, tf, count, (d, t) => {
            prog.textContent = `Fetching ${d}/${t} candles...`;
        });
        prog.textContent = 'Fetching H4...';
        const h4Count   = Math.min(500, Math.ceil(count * tf / 14400) + 50);
        const h4Candles = await _fetchCandles(symbol, 14400, h4Count);

        prog.textContent = 'Simulating...';
        await _sleep(20);

        // Build a runtime strategy from the current state
        const dynStrategy = _buildRuntimeStrategy(_state);
        const result      = _simulate(candles, h4Candles, dynStrategy, stake, 0);
        const wf          = WalkForward.run(candles, h4Candles, dynStrategy, stake, 0);

        prog.style.display = 'none';
        _renderResults(result, wf);

    } catch(e) {
        prog.textContent = `Error: ${e.message}`;
    }

    runBtn.disabled  = false;
    testBtn.disabled = false;
}

// Build a runtime StrategyEngine-compatible object from the visual state
function _buildRuntimeStrategy(s) {
    // Returns an object with analyze() method that backtest-core._simulate can call
    return {
        _customState: JSON.parse(JSON.stringify(s)),
        analyze(stratId, candles, h4Candles, rsiState, atr) {
            const cs = this._customState;
            if (candles.length < cs.warmup) return null;

            const closed = candles.slice(0, -1);
            const bar    = closed[closed.length - 1];
            const prev   = closed[closed.length - 2];
            if (!bar || !prev) return null;

            const vals = _computeIndicators(closed, h4Candles, rsiState);

            if (cs.sessionEnabled) {
                const jaHour = ((new Date(bar.time * 1000).getUTCHours()) - 5 + 24) % 24;
                if (jaHour < cs.sessionFrom || jaHour > cs.sessionTo) return null;
            }

            if (cs.allowBuy && _evalRules(cs.buyRules, cs.buyLogic, vals, bar, prev)) {
                return { type: 'BUY',  label: cs.name + ' Buy',  tpMultiplier: cs.tpMult, slMultiplier: cs.slMult };
            }
            if (cs.allowSell && _evalRules(cs.sellRules, cs.sellLogic, vals, bar, prev)) {
                return { type: 'SELL', label: cs.name + ' Sell', tpMultiplier: cs.tpMult, slMultiplier: cs.slMult };
            }
            return null;
        }
    };
}

function _computeIndicators(closed, h4Candles, rsiState) {
    const last   = closed[closed.length - 1];
    const period = 14;
    const k      = 2 / (period + 1);

    // EMA helper
    const ema = (c, p) => {
        if (c.length < p) return null;
        let e = c.slice(0,p).reduce((s,x)=>s+x.close,0)/p;
        for (let i = p; i < c.length; i++) e = c[i].close*k + e*(1-k);
        return e;
    };

    // BB
    const bbSlice = closed.slice(-20).map(c=>c.close);
    const bbMid   = bbSlice.reduce((a,b)=>a+b,0)/20;
    const bbStd   = Math.sqrt(bbSlice.reduce((s,v)=>s+(v-bbMid)**2,0)/20);

    // RSI
    const d = closed.length > 1 ? last.close - closed[closed.length-2].close : 0;
    const g = d>0?d:0, l = d<0?-d:0;
    if (!rsiState.initialized) { rsiState.prevAvgGain=g; rsiState.prevAvgLoss=l; rsiState.initialized=true; }
    const rk = 1/14;
    rsiState.prevAvgGain = rsiState.prevAvgGain*(1-rk)+g*rk;
    rsiState.prevAvgLoss = rsiState.prevAvgLoss*(1-rk)+l*rk;
    const rsi = rsiState.prevAvgLoss===0?100:100-100/(1+rsiState.prevAvgGain/rsiState.prevAvgLoss);

    // ATR
    const trs = closed.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-closed[i].close),Math.abs(c.low-closed[i].close)));
    const atr = trs.length >= 14 ? trs.slice(-14).reduce((a,b)=>a+b,0)/14 : null;

    // VWAP
    let tv=0,tpv=0;
    closed.forEach(c=>{const v=c.volume||1;tv+=v;tpv+=((c.high+c.low+c.close)/3)*v;});
    const vwap = tv>0?tpv/tv:last.close;

    return {
        rsi, atr, vwap,
        ema8:    ema(closed,8),
        ema20:   ema(closed,20),
        ema50:   ema(closed,50),
        ema200:  ema(closed,200),
        h4_ema21: h4Candles?.length>=21 ? ema(h4Candles,21) : null,
        bb_upper: bbMid + 2*bbStd,
        bb_lower: bbMid - 2*bbStd,
        bb_mid:   bbMid,
        price:    last.close,
        candle_body: atr ? Math.abs(last.close-last.open)/atr : 0,
        prev_high: Math.max(...closed.slice(-20).map(c=>c.high)),
        prev_low:  Math.min(...closed.slice(-20).map(c=>c.low)),
    };
}

function _evalRules(rules, logic, vals, bar, prev) {
    if (!rules.length) return false;
    const results = rules.map(r => _evalRule(r, vals, bar, prev));
    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function _evalRule(r, vals, bar, prev) {
    const lhs = vals[r.indicator] ?? bar.close;
    const rhs = _isIndicatorRef(r.value) ? (vals[r.value] ?? 0) : parseFloat(r.value);
    if (lhs == null || isNaN(rhs)) return false;
    switch (r.condition) {
        case 'gt':            return lhs > rhs;
        case 'lt':            return lhs < rhs;
        case 'between':       return lhs > rhs && lhs < parseFloat(r.value2||rhs+1);
        case 'price_above':   return bar.close > rhs;
        case 'price_below':   return bar.close < rhs;
        case 'crosses_above': return prev.close <= rhs && bar.close > rhs;
        case 'crosses_below': return prev.close >= rhs && bar.close < rhs;
        default: return false;
    }
}

// ─────────────────────────────────────────────────────────────
// RENDER RESULTS
// ─────────────────────────────────────────────────────────────
function _renderResults(result, wf) {
    document.getElementById('sb-results-wrap').style.display = '';
    document.getElementById('sb-empty-state').style.display  = 'none';

    const s   = wf.oos.stats;
    const is  = wf.is.stats;
    const c   = wf.confidence;

    // KPI row
    document.getElementById('sb-kpi-row').innerHTML = `
    <div class="sb-kpi-row">
        ${_kpiCard('NET P&L',       (s.netPnL>=0?'+':'')+s.netPnL.toFixed(4),       s.netPnL>=0?'#10b981':'#ef4444')}
        ${_kpiCard('OOS WIN RATE',  s.winRate.toFixed(1)+'%',                          s.winRate>=50?'#10b981':'#ef4444')}
        ${_kpiCard('PROFIT FACTOR', s.profitFactor===Infinity?'∞':s.profitFactor.toFixed(2), s.profitFactor>=1?'#10b981':'#ef4444')}
        ${_kpiCard('AVG R:R',       s.avgRR.toFixed(2),                                '#64748b')}
        ${_kpiCard('TRADES (OOS)',  String(s.total),                                   '#64748b')}
        <div class="sb-kpi-card" style="border-color:${c.color}44;background:${c.color}0a;">
            <div class="sb-kpi-label">WF CONFIDENCE</div>
            <div class="sb-kpi-val" style="color:${c.color};font-size:1.4rem;">${c.score}<span style="font-size:0.7rem;margin-left:2px;">${c.grade}</span></div>
            <div style="font-size:0.52rem;color:${c.color};font-family:var(--font-mono);margin-top:2px;">${c.verdict}</div>
        </div>
    </div>`;

    // IS vs OOS delta row
    document.getElementById('sb-wf-row').innerHTML = `
    <div class="sb-wf-mini">
        <span class="sb-wf-mini-label">IN-SAMPLE:</span>
        <span style="color:#2563eb;font-weight:700;">${is.winRate.toFixed(1)}% WR</span>
        <span style="color:var(--text-muted)">·</span>
        <span style="color:#2563eb">${is.profitFactor===Infinity?'∞':is.profitFactor.toFixed(2)} PF</span>
        <span style="color:var(--text-muted);margin:0 8px;">→</span>
        <span class="sb-wf-mini-label">OUT-OF-SAMPLE:</span>
        <span style="color:${s.winRate>=is.winRate*0.85?'#10b981':'#ef4444'};font-weight:700;">${s.winRate.toFixed(1)}% WR</span>
        <span style="color:var(--text-muted)">·</span>
        <span style="color:${s.profitFactor>=1?'#10b981':'#ef4444'}">${s.profitFactor===Infinity?'∞':s.profitFactor.toFixed(2)} PF</span>
        <span style="color:var(--text-muted);margin-left:12px;font-size:0.55rem;">
            (drop: ${(is.winRate-s.winRate).toFixed(1)}% WR)
        </span>
    </div>`;

    // Equity curve
    _drawEquity(wf);

    // Suggestions
    const sugEl = document.getElementById('sb-suggestions');
    if (!wf.suggestions.length) {
        sugEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.62rem;padding:6px 0;">No issues detected.</div>';
    } else {
        sugEl.innerHTML = wf.suggestions.map(s => `
        <div class="sb-suggestion" data-priority="${s.priority}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span>${s.icon}</span>
                <span style="font-size:0.6rem;font-weight:700;letter-spacing:0.07em;font-family:var(--font-mono);color:var(--text-dark);">${s.type.replace(/_/g,' ').toUpperCase()}</span>
                <span class="sb-sug-badge ${s.priority}">${s.priority.toUpperCase()}</span>
            </div>
            <div style="font-size:0.62rem;color:var(--text-body);margin-bottom:4px;line-height:1.5;">${s.observation}</div>
            <div style="font-size:0.6rem;color:var(--text-muted);line-height:1.4;">
                <strong style="color:var(--text-dark);font-family:var(--font-mono);font-size:0.52rem;">TWEAK:</strong> ${s.tweak}
            </div>
            <div style="font-size:0.58rem;color:var(--text-muted);margin-top:3px;">
                <strong style="color:var(--text-dark);font-family:var(--font-mono);font-size:0.52rem;">EXPECTED:</strong> ${s.expected_impact}
            </div>
        </div>`).join('');
    }
}

function _kpiCard(label, val, color) {
    return `<div class="sb-kpi-card">
        <div class="sb-kpi-label">${label}</div>
        <div class="sb-kpi-val" style="color:${color}">${val}</div>
    </div>`;
}

function _drawEquity(wf) {
    const canvas = document.getElementById('sb-equity-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  = canvas.offsetWidth || 600;
    const H   = canvas.height = 100;
    ctx.clearRect(0, 0, W, H);

    const allEq = [...(wf.is.equity||[]), ...(wf.oos.equity||[])];
    if (allEq.length < 2) return;

    const min   = Math.min(...allEq, 0);
    const max   = Math.max(...allEq, 0);
    const range = max - min || 1;
    const pad   = 6;
    const total = allEq.length;
    const x = i  => pad + (i / (total - 1)) * (W - pad*2);
    const y = v  => H - pad - ((v - min) / range) * (H - pad*2);

    // Zero line
    ctx.strokeStyle='rgba(100,116,139,0.2)';ctx.lineWidth=1;ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(0,y(0));ctx.lineTo(W,y(0));ctx.stroke();ctx.setLineDash([]);

    // OOS shading
    const splitX = x(wf.is.equity.length);
    ctx.fillStyle='rgba(245,158,11,0.05)';
    ctx.fillRect(splitX,0,W-splitX,H);
    ctx.strokeStyle='rgba(245,158,11,0.4)';ctx.lineWidth=1;ctx.setLineDash([2,2]);
    ctx.beginPath();ctx.moveTo(splitX,0);ctx.lineTo(splitX,H);ctx.stroke();ctx.setLineDash([]);

    // IS curve
    const drawCurve = (data, offset, color) => {
        if (data.length < 2) return;
        ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.lineJoin='round';
        ctx.moveTo(x(offset), y(data[0]));
        data.forEach((v,i) => ctx.lineTo(x(offset+i), y(v)));
        ctx.stroke();
    };
    drawCurve(wf.is.equity,  0,                  '#2563eb');
    drawCurve(wf.oos.equity, wf.is.equity.length, wf.oos.equity.slice(-1)[0]>=0?'#10b981':'#ef4444');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _set(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function _showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1e293b;color:white;
        padding:10px 18px;border-radius:8px;font-size:0.65rem;font-family:DM Mono,monospace;
        z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}