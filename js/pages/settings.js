// js/pages/settings.js
// Owns everything on the Settings page.
// Persists all settings to localStorage so they survive page reloads.
// Other modules read settings via Settings.get(key).

import { SessionState } from '../nav.js';

// ─────────────────────────────────────────────────────────────
// DEFAULTS — what every setting starts as on first load
// ─────────────────────────────────────────────────────────────
const DEFAULTS = {
    // Connection
    apiToken:        '',
    mt5Url:          '',
    autoReconnect:   true,

    // Risk
    maxDailyLoss:    500,
    maxBots:         3,
    lossProtection:  true,
    sessionFilter:   false,

    // Data
    logTraining:     true,
    exportOnStop:    false,
    logRetention:    30,

    // Display
    waveBackground:  true,
    tickerBar:       true,
    chartTheme:      'light',

    // Automations (kept in sync with terminal checkboxes)
    autoLog:         true,
    autoMt5:         false,
    autoSession:     false,
    autoStopLosses:  true,
};

const STORAGE_KEY = 'nexus_settings';

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
export const Settings = {

    // Read a setting by key — usable from any module
    get(key) {
        return _load()[key] ?? DEFAULTS[key];
    },

    // Read all settings
    getAll() {
        return { ...DEFAULTS, ..._load() };
    },

    // Write one or more settings
    set(partial) {
        const current = _load();
        _save({ ...current, ...partial });
    },

    init() {
        _populateForm();
        _wireForm();
        _wireActions();
        _updateSessionInfo();
    },
};

// ─────────────────────────────────────────────────────────────
// LOAD / SAVE
// ─────────────────────────────────────────────────────────────
function _load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function _save(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch(e) {
        console.warn('[Settings] Failed to save:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// POPULATE FORM ON LOAD
// ─────────────────────────────────────────────────────────────
function _populateForm() {
    const s = Settings.getAll();

    // Connection
    _setInput('set-api-token',       s.apiToken);
    _setInput('set-mt5-url',         s.mt5Url);
    _setCheck('set-auto-reconnect',  s.autoReconnect);

    // Risk
    _setInput('set-max-loss',        s.maxDailyLoss);
    _setInput('set-max-bots',        s.maxBots);
    _setCheck('set-loss-protection', s.lossProtection);
    _setCheck('set-session-filter',  s.sessionFilter);

    // Data
    _setCheck('set-log-training',    s.logTraining);
    _setCheck('set-export-on-stop',  s.exportOnStop);
    _setInput('set-log-retention',   s.logRetention);

    // Display
    _setCheck('set-wave-bg',         s.waveBackground);
    _setCheck('set-ticker-bar',      s.tickerBar);
    _setSelect('set-chart-theme',    s.chartTheme);

    // Apply display settings immediately
    _applyDisplay(s);
}

// ─────────────────────────────────────────────────────────────
// WIRE ALL INPUTS — save on every change
// ─────────────────────────────────────────────────────────────
function _wireForm() {
    // Each input id maps to a settings key
    const inputMap = {
        'set-api-token':       'apiToken',
        'set-mt5-url':         'mt5Url',
        'set-max-loss':        'maxDailyLoss',
        'set-max-bots':        'maxBots',
        'set-log-retention':   'logRetention',
    };

    const checkMap = {
        'set-auto-reconnect':  'autoReconnect',
        'set-loss-protection': 'lossProtection',
        'set-session-filter':  'sessionFilter',
        'set-log-training':    'logTraining',
        'set-export-on-stop':  'exportOnStop',
        'set-wave-bg':         'waveBackground',
        'set-ticker-bar':      'tickerBar',
    };

    const selectMap = {
        'set-chart-theme': 'chartTheme',
    };

    Object.entries(inputMap).forEach(([id, key]) => {
        document.getElementById(id)?.addEventListener('input', e => {
            const val = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
            Settings.set({ [key]: val });
            _showSaved();
        });
    });

    Object.entries(checkMap).forEach(([id, key]) => {
        document.getElementById(id)?.addEventListener('change', e => {
            Settings.set({ [key]: e.target.checked });
            _applyDisplay(Settings.getAll());
            _showSaved();
        });
    });

    Object.entries(selectMap).forEach(([id, key]) => {
        document.getElementById(id)?.addEventListener('change', e => {
            Settings.set({ [key]: e.target.value });
            _showSaved();
        });
    });
}

// ─────────────────────────────────────────────────────────────
// WIRE ACTION BUTTONS
// ─────────────────────────────────────────────────────────────
function _wireActions() {
    // Clear session data
    document.getElementById('btn-clear-session')?.addEventListener('click', () => {
        if (!confirm('Clear all session trade data? This cannot be undone.')) return;
        SessionState.clear();
        _updateSessionInfo();
        _showStatus('session-action-status', 'Session data cleared.', false);
    });

    // Export session trades as CSV
    document.getElementById('btn-export-session')?.addEventListener('click', () => {
        const trades = SessionState.get().trades;
        if (!trades.length) {
            _showStatus('session-action-status', 'No trades to export.', true);
            return;
        }
        _exportCSV(trades);
        _showStatus('session-action-status', `Exported ${trades.length} trades.`, false);
    });

    // Reset all settings to defaults
    document.getElementById('btn-reset-settings')?.addEventListener('click', () => {
        if (!confirm('Reset all settings to defaults?')) return;
        _save(DEFAULTS);
        _populateForm();
        _showSaved();
    });
}

// ─────────────────────────────────────────────────────────────
// SESSION INFO PANEL
// ─────────────────────────────────────────────────────────────
function _updateSessionInfo() {
    const state  = SessionState.get();
    const trades = state.trades || [];
    const wins   = trades.filter(t => t.outcome === 'TP').length;
    const losses = trades.filter(t => t.outcome === 'SL').length;
    const pnl    = trades.reduce((s, t) => s + (t.outcome === 'TP' ? t.pnl : -t.pnl), 0);

    _set('info-trade-count', trades.length);
    _set('info-wins',        wins);
    _set('info-losses',      losses);
    _set('info-pnl',         `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);

    const pnlEl = document.getElementById('info-pnl');
    if (pnlEl) pnlEl.style.color = pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
}

// ─────────────────────────────────────────────────────────────
// APPLY DISPLAY SETTINGS IMMEDIATELY
// ─────────────────────────────────────────────────────────────
function _applyDisplay(s) {
    // Wave background toggle
    const canvas = document.getElementById('wave-canvas');
    if (canvas) canvas.style.opacity = s.waveBackground ? '0.55' : '0';
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────
function _exportCSV(trades) {
    const headers = ['Date','Time','Symbol','Strategy','Direction','Entry','SL','TP','Outcome','PnL'];
    const rows    = trades.map(t => {
        const d = new Date(t.time);
        return [
            d.toLocaleDateString('en-GB'),
            d.toLocaleTimeString('en-GB', { hour12: false }),
            t.symbol   || '',
            t.strategy || '',
            t.type     || '',
            t.entry    ? parseFloat(t.entry).toFixed(5) : '',
            t.sl       ? parseFloat(t.sl).toFixed(5)    : '',
            t.tp       ? parseFloat(t.tp).toFixed(5)    : '',
            t.outcome  || '',
            t.outcome === 'TP' ? t.pnl.toFixed(5) : (-t.pnl).toFixed(5),
        ].join(',');
    });

    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');
    a.download = `nexus_trades_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _setInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}

function _setCheck(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
}

function _setSelect(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}

function _showSaved() {
    _showStatus('settings-saved-indicator', 'Settings saved', false);
}

function _showStatus(id, msg, isWarn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isWarn ? 'var(--accent3)' : 'var(--accent2)';
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 2500);
}