// js/pages/settings.js
// Owns everything on the Settings page.
// Persists all settings to localStorage so they survive page reloads.
// Other modules read settings via Settings.get(key).

import { SessionState } from '../session-state.js';

// ─────────────────────────────────────────────────────────────
// DEFAULTS — what every setting starts as on first load
// ─────────────────────────────────────────────────────────────
const DEFAULTS = {
    // Connection
    apiToken:        '',
    accountId:       '',      // Required — Deriv retired token-only auth
    accountType:     'demo',  // 'demo' | 'real'
    mt5Url:          '',
    mt5RiskPerLot:   3.0,   // $ lost per 1.0 lot when SL hit — calibrate from live results
    autoReconnect:   true,

    // Risk
    maxDailyLoss:    500,
    maxBots:         3,
    lossProtection:       true,
    sessionFilter:        false,
    vortexNewsBlackout:   true,
    vortexFomcBlackout:   false,

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
        MT5Bridge.init();
        _initNotifications();
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
    _setInput('set-account-id',      s.accountId);
    _setSelect('set-account-type',   s.accountType);
    _setInput('set-mt5-url',         s.mt5Url);
    _setCheck('set-auto-reconnect',  s.autoReconnect);

    // Risk
    _setInput('set-max-loss',        s.maxDailyLoss);
    _setInput('set-max-bots',        s.maxBots);
    _setCheck('set-loss-protection',  s.lossProtection);
    _setCheck('set-session-filter',   s.sessionFilter);
    _setCheck('set-vortex-news',       s.vortexNewsBlackout);
    _setCheck('set-vortex-fomc',       s.vortexFomcBlackout);

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
        'set-account-id':      'accountId',
        'set-mt5-url':         'mt5Url',
        'set-max-loss':        'maxDailyLoss',
        'set-max-bots':        'maxBots',
        'set-log-retention':   'logRetention',
    };

    const checkMap = {
        'set-auto-reconnect':  'autoReconnect',
        'set-loss-protection':  'lossProtection',
        'set-session-filter':   'sessionFilter',
        'set-vortex-news':      'vortexNewsBlackout',
        'set-vortex-fomc':      'vortexFomcBlackout',
        'set-log-training':    'logTraining',
        'set-export-on-stop':  'exportOnStop',
        'set-wave-bg':         'waveBackground',
        'set-ticker-bar':      'tickerBar',
    };

    const selectMap = {
        'set-chart-theme':   'chartTheme',
        'set-account-type':  'accountType',
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
        // Also wipe bot configs and any other nexus_ keys so bots don't restore
        try {
            const keysToRemove = Object.keys(localStorage).filter(k => k.startsWith('nexus_'));
            keysToRemove.forEach(k => localStorage.removeItem(k));
            sessionStorage.clear();
        } catch(_) {}
        location.reload();
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


// ═════════════════════════════════════════════════════════════
// MT5 BRIDGE STATUS PANEL
// Polls /api/signal and /api/signals/history to show live state
// ═════════════════════════════════════════════════════════════
const MT5Bridge = {

    _pollInterval: null,
    _signalsToday: 0,
    _logEntries: [],

    init() {
        // Load saved config into fields
        const cfg = this._loadConfig();
        _set('mt5-host-input',         cfg.host       || '');
        _set('mt5-port-input',         cfg.port       || 3000);
        _set('mt5-lot-input',          cfg.lotSize    || 0.10);
        _set('mt5-max-age-input',      cfg.maxAge     || 30);
        _set('mt5-risk-per-lot-input', cfg.riskPerLot || 3.00);

        // Auto-detect local IP hint
        this._detectIP();

        // Wire config save on change
        ['mt5-host-input','mt5-port-input','mt5-lot-input','mt5-max-age-input','mt5-risk-per-lot-input'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this._saveConfig());
        });

        // Load saved log
        this._logEntries = JSON.parse(localStorage.getItem('nexus_mt5_log') || '[]');
        this._renderLog();

        // Clear log button
        window.mt5ClearLog = () => {
            this._logEntries = [];
            localStorage.removeItem('nexus_mt5_log');
            this._renderLog();
        };

        // Start polling server for EA connection status + signal history
        this._poll();
        this._pollInterval = setInterval(() => this._poll(), 3000);

        // Count today's signals from history
        this._countToday();
    },

    _loadConfig() {
        try { return JSON.parse(localStorage.getItem('nexus_mt5_config') || '{}'); }
        catch { return {}; }
    },

    _saveConfig() {
        const cfg = {
            host:       document.getElementById('mt5-host-input')?.value       || '',
            port:       document.getElementById('mt5-port-input')?.value        || 3000,
            lotSize:    document.getElementById('mt5-lot-input')?.value         || 0.10,
            maxAge:     document.getElementById('mt5-max-age-input')?.value     || 30,
            riskPerLot: parseFloat(document.getElementById('mt5-risk-per-lot-input')?.value) || 3.00,
        };
        localStorage.setItem('nexus_mt5_config', JSON.stringify(cfg));
        Settings.set({ mt5Config: cfg, mt5RiskPerLot: cfg.riskPerLot });
    },

    async _poll() {
        try {
            // Check if server is reachable and get latest signal
            const res  = await fetch('/api/signal');
            const data = await res.json();

            // Check signal history to count clients and last signal
            const histRes  = await fetch('/api/signals/history');
            const histData = await histRes.json();

            const clientCount = data._clientCount ?? (data.action && data.action !== 'none' ? 1 : 0);
            const isConnected = Array.isArray(histData) && histData.length > 0 ||
                                data.action !== 'none';

            // Update status badge
            const badge = document.getElementById('mt5-bridge-status-badge');
            const eaStat = document.getElementById('mt5-ea-status');

            // We can't directly know EA client count from current server
            // But we can tell if the server is alive and if signals are flowing
            this._setServerOnline(true);

            if (data.action && data.action !== 'none') {
                this._updateLastSignal(data);
            }

            // Update signal history from server
            if (Array.isArray(histData) && histData.length > 0) {
                this._syncServerHistory(histData);
            }

            // Update today count
            this._countToday();

        } catch(e) {
            this._setServerOnline(false);
        }
    },

    _setServerOnline(online) {
        const badge  = document.getElementById('mt5-bridge-status-badge');
        const eaStat = document.getElementById('mt5-ea-status');
        const step1  = document.getElementById('mt5-step-1');

        // Check SessionState for EA connection
        const eaConnected = SessionState.get().mt5Connected === true;

        if (!online) {
            badge.className  = 'mt5-badge mt5-badge-offline';
            badge.textContent = '● DISCONNECTED';
            eaStat.className  = 'mt5-stat-val mt5-offline';
            eaStat.textContent = 'Server unreachable';
            return;
        }

        if (eaConnected) {
            badge.className   = 'mt5-badge mt5-badge-online';
            badge.textContent  = '● CONNECTED';
            eaStat.className   = 'mt5-stat-val mt5-online';
            eaStat.textContent = 'EA connected — receiving signals';
            this._markStep(3, true);
            this._markStep(4, true);
            this._markStep(5, true);
        } else {
            badge.className   = 'mt5-badge mt5-badge-waiting';
            badge.textContent  = '◌ WAITING FOR EA';
            eaStat.className   = 'mt5-stat-val mt5-waiting';
            eaStat.textContent = 'Server online — waiting for EA to connect';
        }

        // Auto-push status
        const autoPushEl = document.getElementById('mt5-auto-push-status');
        if (autoPushEl) {
            try {
                // Check terminal page checkbox state via localStorage
                const term = JSON.parse(localStorage.getItem('nexus_terminal_prefs') || '{}');
                autoPushEl.textContent = term.autoPush ? 'ENABLED' : 'DISABLED';
                autoPushEl.style.color = term.autoPush ? '#10b981' : '#94a3b8';
            } catch { autoPushEl.textContent = '—'; }
        }
    },

    _updateLastSignal(data) {
        const sigEl  = document.getElementById('mt5-last-signal');
        const timeEl = document.getElementById('mt5-last-time');
        if (sigEl && data.action && data.action !== 'none') {
            sigEl.textContent = `${data.action.toUpperCase()} ${data.symbol || ''} @ ${data.price || ''}`;
            sigEl.style.color = data.action === 'buy' ? '#10b981' : '#ef4444';
        }
        if (timeEl && data.receivedAt) {
            const d = new Date(data.receivedAt);
            timeEl.textContent = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        }
    },

    _syncServerHistory(history) {
        // Add any new server-side signals to local log
        const existing = new Set(this._logEntries.map(e => e.timestamp));
        let added = false;
        history.forEach(sig => {
            if (sig.timestamp && !existing.has(sig.timestamp)) {
                this._logEntries.unshift({
                    timestamp:  sig.timestamp,
                    action:     sig.action,
                    symbol:     sig.symbol,
                    price:      sig.price,
                    sl:         sig.sl,
                    tp:         sig.tp,
                    label:      sig.label,
                    receivedAt: sig.receivedAt,
                });
                added = true;
            }
        });
        if (added) {
            this._logEntries = this._logEntries.slice(0, 100);
            localStorage.setItem('nexus_mt5_log', JSON.stringify(this._logEntries));
            this._renderLog();
        }
    },

    _countToday() {
        const today = new Date().toDateString();
        const count = this._logEntries.filter(e => {
            if (!e.receivedAt) return false;
            return new Date(e.receivedAt).toDateString() === today;
        }).length;
        const el = document.getElementById('mt5-signals-today');
        if (el) el.textContent = count;
    },

    _renderLog() {
        const el = document.getElementById('mt5-signal-log');
        if (!el) return;
        if (!this._logEntries.length) {
            el.innerHTML = '<div class="mt5-log-empty">No signals sent yet — enable MT5 Auto-Push on a bot and wait for a signal.</div>';
            return;
        }
        el.innerHTML = this._logEntries.map(e => {
            const isBuy = e.action === 'buy';
            const time  = e.receivedAt
                ? new Date(e.receivedAt).toLocaleTimeString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
                : '—';
            return `
            <div class="mt5-log-row">
                <span class="mt5-log-dir ${isBuy ? 'mt5-log-buy' : 'mt5-log-sell'}">${e.action?.toUpperCase()}</span>
                <span class="mt5-log-symbol">${e.symbol || '—'}</span>
                <span class="mt5-log-price">@ ${e.price || '—'}</span>
                <span class="mt5-log-sl">SL ${e.sl ? parseFloat(e.sl).toFixed(4) : '—'}</span>
                <span class="mt5-log-tp">TP ${e.tp ? parseFloat(e.tp).toFixed(4) : '—'}</span>
                <span class="mt5-log-label">${e.label || ''}</span>
                <span class="mt5-log-time">${time}</span>
            </div>`;
        }).join('');
    },

    _markStep(num, done) {
        const step = document.getElementById(`mt5-step-${num}`);
        if (!step) return;
        const check = step.querySelector('.mt5-step-check');
        if (check) {
            check.textContent = done ? '✓' : '○';
            check.style.color = done ? '#10b981' : '#94a3b8';
        }
        step.style.opacity = done ? '1' : '0.5';
    },

    async _detectIP() {
        // Show server URL as the host hint
        const display = document.getElementById('mt5-ip-display');
        const input   = document.getElementById('mt5-host-input');
        const saved   = this._loadConfig().host;

        if (saved && display) { display.textContent = saved; return; }

        // Try to get from window.location
        const host = window.location.hostname;
        if (host && host !== 'localhost' && host !== '127.0.0.1') {
            if (display) display.textContent = host;
            if (input && !input.value) input.value = host;
        } else {
            if (display) display.textContent = window.location.hostname + ':3000';
        }
    },
};

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS PANEL
// ─────────────────────────────────────────────────────────────
function _initNotifications() {
    const statusEl = document.getElementById('notif-permission-status');
    if (statusEl && 'Notification' in window) {
        const p = Notification.permission;
        statusEl.textContent  = p.toUpperCase();
        statusEl.style.color  = p === 'granted' ? '#10b981' : p === 'denied' ? '#ef4444' : '#f59e0b';
    }

    window.nexusRequestNotify = async () => {
        if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
        const perm = await Notification.requestPermission();
        if (statusEl) {
            statusEl.textContent = perm.toUpperCase();
            statusEl.style.color = perm === 'granted' ? '#10b981' : perm === 'denied' ? '#ef4444' : '#f59e0b';
        }
        if (perm === 'granted') {
            new Notification('✅ NEXUS Notifications Active', {
                body: 'You will now receive alerts for signals and trade outcomes.',
                icon: '/favicon.ico',
            });
        } else if (perm === 'denied') {
            alert('Notifications blocked. Enable them in your browser settings → Site permissions.');
        }
    };
}