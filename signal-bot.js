// signal-bot.js — Multi-instance runner v3.0
// PATCH v3.0 changes:
//   - Integrated Position Sizing Module (dynamic lot sizing based on risk %)
//   - Fixed 11% win rate issues with stricter entry filters
//   - Added win rate gates and daily loss limits
//   - KISMET cooldown: 1 candle → 3 candles (15min on M5)
//   - KISMET drift_reentry: score gate added (< 70 blocked)
//   - stake → lotSize throughout (UI input, config, fireSignal, all close fns)
//   - PnL calculation: stake×multiplier → lotSize×pointValue×priceDist
//   - _pointValue() helper for per-symbol dollar-per-point calibration
//   - Added ULTRA SCALPER strategy (fast momentum scalper)
if (location.hostname !== 'localhost') console.log = () => {};

import { DerivAPI }          from './js/deriv-api.js';
import { StrategyEngine }    from './js/strategy-engine.js';
import { Indicators }        from './js/indicators.js';
import { Storage }           from './js/storage.js';
import { OverlayManager }    from './js/overlays.js';
import { MomentumStrategy }  from './js/strategies/momentum.js';
import { PhantomStrategy, PhantomReversalCheck } from './js/strategies/phantom.js';
import { NovaStrategy, novaSymbolConfig, detectSpike } from './js/strategies/nova.js';
import { PulseStrategy, pulseSymbolConfig } from './js/strategies/pulse.js';
import { KismetStrategy, kismetSymbolConfig } from './js/strategies/kismet.js';
import { VortexStrategy } from './js/strategies/vortex.js';
import { DataLogger }        from './js/data-logger.js';
import { UIManager }         from './js/ui-manager.js';
import { SessionState }      from './js/session-state.js';
import { Analytics }         from './js/pages/analytics.js';
import { Settings }          from './js/pages/settings.js';
import { ChartManager, initChartManager } from './js/chart-manager.js';
import { ConfidenceEngine }          from './js/confidence.js';
import { Auth }              from './js/auth.js';
import { CipherStrategy, isCipherSymbol } from './js/strategies/cipher.js';
import { PositionSizing }    from './js/position-sizing.js';
import { UltraScalper }      from './js/strategies/ultra-scalper.js';
import { Jump75Strategy } from './js/strategies/jump75.js'; 

// ─────────────────────────────────────────────────────────────
// SYMBOL MAP
// ─────────────────────────────────────────────────────────────
const SYMBOL_MAP = {
    'R_100':'Volatility 100 Index','R_75':'Volatility 75 Index',
    'R_50':'Volatility 50 Index','R_25':'Volatility 25 Index',
    'R_10':'Volatility 10 Index',
    '1HZ100V':'Volatility 100 (1s) Index','1HZ75V':'Volatility 75 (1s) Index',
    '1HZ50V':'Volatility 50 (1s) Index','1HZ25V':'Volatility 25 (1s) Index',
    '1HZ10V':'Volatility 10 (1s) Index',
    'cryBTCUSD':'BTCUSD','cryETHUSD':'ETHUSD',
    'cryLTCUSD':'LTCUSD','cryXRPUSD':'XRPUSD',
    'frxXAUUSD':'XAUUSD','frxXAGUSD':'XAGUSD',
    'frxEURUSD':'EURUSD','frxGBPUSD':'GBPUSD',
    'frxUSDJPY':'USDJPY','frxAUDUSD':'AUDUSD',
    'frxUSDCAD':'USDCAD','frxUSDCHF':'USDCHF',
    'frxEURGBP':'EURGBP','frxGBPJPY':'GBPJPY',
    'JD10':'Jump 10 Index','JD25':'Jump 25 Index',
    'JD50':'Jump 50 Index','JD75':'Jump 75 Index','JD100':'Jump 100 Index',
    'CRASH1000':'Crash 1000 Index','BOOM1000':'Boom 1000 Index',
    'CRASH_1000':'Crash 1000 Index','BOOM_1000':'Boom 1000 Index',
    'CRASH500':'Crash 500 Index','BOOM500':'Boom 500 Index',
    'CRASH_500':'Crash 500 Index','BOOM_500':'Boom 500 Index',
    'stpRNG':'Step Index','STEP':'Step Index',
};

const STRATEGY_GROUPS = [
    {
        label: '🌀 VORTEX',
        desc:  'All symbols — trades volatility itself',
        strategies: [
            { value: 'vortex',  label: 'VORTEX (Any Symbol)'  },
        ]
    },
    {
        label: '👻 PHANTOM',
        desc:  'Daily target — high confidence only',
        strategies: [
            { value: 'phantom', label: 'PHANTOM (Daily Target)' },
        ]
    },
    {
        label: '💥 Crash & Boom',
        desc:  'Crash 1000, Boom 1000',
        strategies: [
            { value: 'nova',    label: 'NOVA (Crash & Boom)'   },
            { value: 'pulse',   label: 'PULSE (Compounder)'    },
            { value: 'kismet',  label: 'KISMET (Structure)'    },
        ]
    },
    {
        label: '⚡ Synthetic Indices',
        desc:  'R_100, R_75, 1HZ100V etc.',
        strategies: [
            { value: 'synthetic_scalp', label: 'BB+RSI Synthetic'  },
            { value: 'ultra_scalp',     label: 'Ultra Scalper'     },
            { value: 'candle_speed',    label: 'Candle Speed'      },
            { value: 'range_boundary',  label: 'Range Boundary'    },
            { value: 'rsi_fade',        label: 'RSI Fade Scalper'  },
        ]
    },
    {
        label: '💱 Forex Pairs',
        desc:  'EURUSD, GBPUSD, USDJPY etc.',
        strategies: [
            { value: 'momentum',        label: 'Momentum Scalper'  },
            { value: 'h4_kiss',         label: 'KISS H4'           },
            { value: 'london_breakout', label: 'London Breakout'   },
            { value: 'news_fade',       label: 'News Fade'         },
            { value: 'vwap_reversion',  label: 'VWAP Reversion'    },
            { value: 'swing',           label: 'Swing'             },
            { value: 'trend',           label: 'Trend Follow'      },
            { value: 'orb',             label: 'ORB'               },
        ]
    },
    {
        label: '₿ Crypto',
        desc:  'BTCUSD, ETHUSD etc.',
        strategies: [
            { value: 'crypto_scalp',    label: 'Crypto Scalper'    },
            { value: 'momentum',        label: 'Momentum Scalper'  },
            { value: 'rsi_fade',        label: 'RSI Fade Scalper'  },
            { value: 'swing',           label: 'Swing'             },
            { value: 'cipher',          label: 'CIPHER (BTC Structure)' },
        ]
    },
    {
        label: '🥇 Commodities',
        desc:  'XAUUSD, XAGUSD',
        strategies: [
            { value: 'momentum',        label: 'Momentum Scalper'  },
            { value: 'h4_kiss',         label: 'KISS H4'           },
            { value: 'vwap_reversion',  label: 'VWAP Reversion'    },
            { value: 'trend',           label: 'Trend Follow'      },
            { value: 'swing',           label: 'Swing'             },
        ]
    },
    {
        label: '🦘 Jump Indices',
        desc:  'JD10, JD25, JD75, JD100',
        strategies: [
            { value: 'jump75',          label: 'JUMP75 (Multi-TF)' },
            { value: 'scalp',           label: 'Classic Scalp'     },
            { value: 'ultra_scalp',     label: 'Ultra Scalper'     },
            { value: 'range_boundary',  label: 'Range Boundary'    },
            { value: 'rsi_fade',        label: 'RSI Fade Scalper'  },
        ]
    },
];

const STRATEGY_OPTIONS = STRATEGY_GROUPS.flatMap(g => g.strategies);

const TF_LABEL = {
    60:'M1', 120:'M2', 300:'M5', 600:'M10',
    900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1'
};

// ─────────────────────────────────────────────────────────────
// POINT VALUE HELPER
// $/point/lot calibrated from live trade data.
// ─────────────────────────────────────────────────────────────
function _pointValue(symbol) {
    const MAP = {
        'CRASH1000':  0.41,
        'CRASH_1000': 0.41,
        'BOOM1000':   0.41,
        'BOOM_1000':  0.41,
        'CRASH500':   0.41,
        'BOOM500':    0.41,
        'CRASH_500':  0.41,
        'BOOM_500':   0.41,
        'cryBTCUSD': 0.01,
        'BTCUSD':    0.01,
        'JD10':      0.41,
        'JD25':      0.41,
        'JD50':      0.41,
        'JD75':      0.41,
        'JD100':     0.41,
        'frxEURUSD': 10.0,
        'frxGBPUSD': 10.0,
        'frxUSDJPY': 9.35,
        'frxAUDUSD': 10.0,
        'frxUSDCAD': 10.0,
        'frxUSDCHF': 10.0,
        'frxEURGBP': 12.50,
        'frxGBPJPY': 12.50,
    };
    return MAP[symbol] || 0.41;
}

// ─────────────────────────────────────────────────────────────
// BOT STATE CLASS
// ─────────────────────────────────────────────────────────────
class BotState {
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.candles = [];
        this.h4Candles = [];
        this.htfCandles = [];
        this.htfGran = 14400;
        this.rsiState = { prevAvgGain: 0, prevAvgLoss: 0, initialized: false };
        this.strategy = new StrategyEngine();
        this.openSignal = null;
        this.lastFiredMs = 0;
        this.lastSLTimeMs = 0;
        this.lastSLBarIdx = 0;
        this.h4KissCandidate = null;
        this.isActive = false;
        this.sessionStart = null;
        this.wins = 0;
        this.losses = 0;
        this.pnl = 0;
        this.accountEquity = 10000;
        
        this.m5Candles = [];
        this.m15Candles = [];
        this.lastM5CloseTime = null;
        this.lastM15CloseTime = null;
        this.lastH4CloseTime = null;
    }
}

// ─────────────────────────────────────────────────────────────
// SHARED SINGLETONS
// ─────────────────────────────────────────────────────────────
let api       = null;
let symbolMap = {};

const MT5_SYMBOL_MAP = {
    'stpRNG':              'Step Index',
    'STEP':                'Step Index',
    'Step Index 100':      'Step Index',
    'Step Index 200':      'Step Index 200',
    'Crash 1000 Index':    'Crash 1000 Index',
    'Boom 1000 Index':     'Boom 1000 Index',
    'Crash 500 Index':     'Crash 500 Index',
    'Boom 500 Index':      'Boom 500 Index',
    'Volatility 10 Index': 'Volatility 10 Index',
    'Volatility 25 Index': 'Volatility 25 Index',
    'Volatility 50 Index': 'Volatility 50 Index',
    'Volatility 75 Index': 'Volatility 75 Index',
    'Volatility 100 Index':'Volatility 100 Index',
    'Jump 10 Index':       'Jump 10 Index',
    'Jump 25 Index':       'Jump 25 Index',
    'Jump 50 Index':       'Jump 50 Index',
    'Jump 75 Index':       'Jump 75 Index',
    'Jump 100 Index':      'Jump 100 Index',
};

// ─────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
const Notify = {
    _allowed: false,

    async request() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'granted') { this._allowed = true; return; }
        if (Notification.permission !== 'denied') {
            const perm = await Notification.requestPermission();
            this._allowed = perm === 'granted';
        }
    },

    signal(type, symbol, price, label, confidence) {
        if (!this._allowed || document.hasFocus()) return;
        const icon  = type === 'BUY' ? '🟢' : '🔴';
        const title = `${icon} ${type} — ${symbol}`;
        const body  = `${label}  ·  @ ${parseFloat(price).toFixed(4)}  ·  ${confidence?.grade || '?'}${confidence?.score || ''}`;
        try {
            const n = new Notification(title, { body, icon: '/favicon.ico', tag: `nexus-signal-${Date.now()}` });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 8000);
        } catch(e) {}
    },

    outcome(type, outcome, symbol, pnl) {
        if (!this._allowed || document.hasFocus()) return;
        const icon  = outcome === 'TP' ? '✅' : '❌';
        const title = `${icon} ${outcome} — ${symbol}`;
        const body  = `${type} closed  ·  P&L: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
        try {
            const n = new Notification(title, { body, icon: '/favicon.ico', tag: `nexus-outcome-${Date.now()}` });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 6000);
        } catch(e) {}
    },
};
let focusedBotId = null;
let authorised   = false;

const bots = {};

// ─────────────────────────────────────────────────────────────
// OVERLAY PANEL
// ─────────────────────────────────────────────────────────────
const OVERLAY_IDS = ['show-asian','show-pdhpdl','show-fvg','show-h4','show-major','show-orb','show-ob','show-bos'];
const overlayState = {};

function _initOverlayPanel() {
    OVERLAY_IDS.forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            if (focusedBotId) _saveOverlayState(focusedBotId);
            redrawOverlays();
        });
    });
    const toggleBtn = document.getElementById('overlay-panel-toggle');
    const panel     = document.getElementById('overlay-panel');
    if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            toggleBtn.textContent = collapsed ? '+' : '−';
        });
    }
}

function _saveOverlayState(botId) {
    const state = {};
    OVERLAY_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) state[id] = el.checked;
    });
    overlayState[botId] = state;
}

function _loadOverlayState(botId) {
    const state = overlayState[botId] || {};
    OVERLAY_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = state[id] || false;
    });
}

function _showOverlayPanel(show) {
    const panel = document.getElementById('overlay-panel');
    if (panel) panel.style.display = show ? 'block' : 'none';
}

// ─────────────────────────────────────────────────────────────
// SAVE / RESTORE BOT CONFIGS
// ─────────────────────────────────────────────────────────────
function _saveBotConfigs() {
    const active = Object.values(bots)
        .filter(b => b.isActive)
        .map(b => ({ id: b.id, config: b.config }));
    SessionState.set({ botConfigs: active });
}

function _restoreBotCards() {
    const saved = SessionState.get().botConfigs || [];
    if (!saved.length) return;

    saved.forEach(({ id, config }) => {
        _createBotCard(id, config);
        const bot        = new BotState(id, config);
        bots[id]         = bot;
        bot.isActive     = true;
        bot.sessionStart = Date.now();
        window.setBotRunning(id, true);
        const symLabel = (SYMBOL_MAP[config.symbol] || config.symbol).replace(' Index','').trim();
        ChartManager.addBot(id, symLabel, TF_LABEL[config.tf] || 'M5');
        log(`Bot #${id} restored — ${config.strategy} on ${config.symbol}`, 'info');
    });
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph && saved.length > 0) ph.style.display = 'none';
    const firstId = saved[0]?.id;
    if (firstId) { focusedBotId = firstId; }
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
async function init() {
    api = new DerivAPI(96293, handleData);
    initChartManager();

    Analytics.init();
    
    PositionSizing.init(10000);
    PositionSizing.resetSession(10000);

    if (!Auth.isGuest()) {
        const localTrades = SessionState.get().trades || [];
        if (localTrades.length === 0) {
            Auth.fetchTrades().then(serverTrades => {
                if (serverTrades?.length) {
                    SessionState.set({ trades: serverTrades });
                    log(`Restored ${serverTrades.length} trades from cloud`, 'info');
                    Analytics.init();
                }
            }).catch(() => {});
        }
    }

    const restoredState = SessionState.get();
    const pnlEl = document.getElementById('session-pnl');
    if (pnlEl && restoredState.sessionPnL !== 0) {
        const pnl = restoredState.sessionPnL;
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
        pnlEl.style.color = pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
    const winsEl   = document.getElementById('stat-wins');
    const lossesEl = document.getElementById('stat-losses');
    const wrEl     = document.getElementById('stat-winrate');
    if (winsEl)   winsEl.textContent   = restoredState.wins   || 0;
    if (lossesEl) lossesEl.textContent = restoredState.losses || 0;
    if (wrEl)     wrEl.textContent     = restoredState.winRate ? `${restoredState.winRate}%` : '0%';

    document.getElementById('clear-logs')?.addEventListener('click', () => {
        const logs    = document.getElementById('logs');
        const countEl = document.getElementById('log-count');
        if (logs)    logs.innerHTML      = '';
        if (countEl) countEl.textContent = '0 events';
    });

    const token = Storage.getToken();
    if (token) {
        api.connect(token);
    } else {
        document.documentElement.removeAttribute('data-authed');
        document.getElementById('auth-overlay').style.display = 'flex';
    }

    document.getElementById('btn-login').onclick = () => {
        const t = document.getElementById('api-token').value.trim();
        if (!t) return alert('Token required');
        Storage.saveToken(t);
        document.documentElement.setAttribute('data-authed', '1');
        document.getElementById('auth-overlay').style.display = 'none';
        api.connect(t);
    };

    document.getElementById('btn-logout').onclick  = logout;
    document.getElementById('btn-add-bot').onclick = () => _createBotCard(Date.now(), null);

    _initOverlayPanel();
    _restoreBotCards();

    setInterval(() => {
        const hudWrap    = document.getElementById('phantom-scan-hud');
        const hudEl      = document.getElementById('phantom-scan-countdown');
        if (!hudEl || !hudWrap) return;

        const phantomBot = Object.values(bots).find(b =>
            b.config?.strategy === 'phantom' &&
            document.querySelector(`.bot-card[data-bot-id="${b.id}"]`)?.classList.contains('running')
        );

        if (!phantomBot) { hudWrap.style.display = 'none'; return; }

        const session = PhantomStrategy.getSession();

        if (session.mode === 'halted') {
            hudWrap.style.display = 'flex';
            hudEl.textContent = '🛑 HALTED';
            hudEl.style.color = '#f87171';
            return;
        }
        if (session.mode === 'observer') {
            hudWrap.style.display = 'flex';
            hudEl.textContent = '👁 OBSERVING';
            hudEl.style.color = '#a78bfa';
            return;
        }
        if (phantomBot.openSignal?.isPhantom) {
            hudWrap.style.display = 'flex';
            const trailLabel = phantomBot.openSignal.scaleOutDone ? 'TRAILING ½' : 'IN TRADE';
            hudEl.textContent = trailLabel;
            hudEl.style.color = '#34d399';
            return;
        }

        const tf = phantomBot.config.tf || 300;
        const lastCandle = phantomBot.candles?.[phantomBot.candles.length - 1];
        if (!lastCandle) { hudWrap.style.display = 'none'; return; }

        const candleCloseAt = (lastCandle.time + tf) * 1000;
        const secsLeft = Math.max(0, Math.round((candleCloseAt - Date.now()) / 1000));
        const mins = String(Math.floor(secsLeft / 60)).padStart(2, '0');
        const secs = String(secsLeft % 60).padStart(2, '0');

        hudWrap.style.display = 'flex';
        hudEl.style.color = secsLeft <= 10 ? '#fbbf24' : '#a78bfa';
        hudEl.textContent = secsLeft === 0 ? 'SCANNING…' : `${mins}:${secs}`;
    }, 1000);

    const deployRaw = sessionStorage.getItem('nexus_deploy_bot');
    if (deployRaw) {
        sessionStorage.removeItem('nexus_deploy_bot');
        try {
            const payload = JSON.parse(deployRaw);
            const labelEl = document.getElementById('deploy-label');
            if (labelEl) labelEl.textContent = `Deploying "${payload.name || payload.strategy}"…`;
            const id = Date.now();
            _createBotCard(id, payload);
            log(`Strategy "${payload.name || payload.strategy}" deployed from Builder — configure and start.`, 'info');
            setTimeout(() => {
                const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
                if (card) {
                    card.style.transition = 'box-shadow 0.3s';
                    card.style.boxShadow = '0 0 0 2px #8b5cf6';
                    setTimeout(() => { card.style.boxShadow = ''; }, 2000);
                }
                const overlay = document.getElementById('deploy-overlay');
                if (overlay) {
                    overlay.style.transition = 'opacity 0.4s';
                    overlay.style.opacity = '0';
                    setTimeout(() => {
                        overlay.style.display = 'none';
                        document.documentElement.removeAttribute('data-deploying');
                    }, 420);
                }
            }, 350);
        } catch(e) {
            console.warn('[Deploy] Failed to parse payload', e);
            const overlay = document.getElementById('deploy-overlay');
            if (overlay) overlay.style.display = 'none';
        }
    }

    const quickSym = sessionStorage.getItem('nexus_quick_sym');
    if (quickSym) {
        sessionStorage.removeItem('nexus_quick_sym');
        setTimeout(() => {
            const targetCard = document.querySelector('.bot-card.stopped') ||
                               document.querySelector('.bot-card');
            if (!targetCard) {
                const id = Date.now();
                _createBotCard(id, { strategy: 'momentum', symbol: quickSym, tf: 300 });
                log(`New bot created from Market with symbol ${quickSym}`, 'info');
                return;
            }
            const symSelect = targetCard.querySelector('.bot-symbol-select');
            if (symSelect) {
                symSelect.value = quickSym;
                symSelect.dispatchEvent(new Event('change'));
                log(`Symbol pre-selected from Market: ${quickSym}`, 'info');
                targetCard.style.transition = 'box-shadow 0.3s';
                targetCard.style.boxShadow = '0 0 0 2px #06b6d4';
                setTimeout(() => { targetCard.style.boxShadow = ''; }, 2000);
            }
        }, 400);
    }

    // Start status polling with longer interval
    _startStatusPolling();
}

// ─────────────────────────────────────────────────────────────
// STRATEGY STATUS POLLING - FIXED VERSION (10 second interval)
// ─────────────────────────────────────────────────────────────

let pollInterval = null;
let consecutiveErrors = 0;
let isPolling = false;

async function _pollStrategyStatus() {
    if (isPolling) return;
    isPolling = true;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch('https://nexus-api-khvt.onrender.com/api/strategy-status', {
            signal: controller.signal,
            headers: { 'Cache-Control': 'no-cache' }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const status = await response.json();
        consecutiveErrors = 0;
        _updateStatusUI(status);
        
    } catch(e) {
        consecutiveErrors++;
        console.warn('[Status] Poll error:', e.message);
        
        const statusEl = document.getElementById('strategy-status');
        if (statusEl) {
            statusEl.textContent = consecutiveErrors > 3 ? 'OFFLINE' : 'CONNECTING...';
            statusEl.style.color = '#f59e0b';
        }
        
        const lastEventEl = document.getElementById('last-event-text');
        if (lastEventEl && consecutiveErrors > 3) {
            lastEventEl.textContent = 'Server connection lost - retrying...';
        }
        
    } finally {
        isPolling = false;
    }
}

function _updateStatusUI(status) {
    const statusEl = document.getElementById('strategy-status');
    if (statusEl) {
        statusEl.textContent = status.status || 'IDLE';
        
        if (status.status === 'ENTRY_SIGNAL_FIRED') {
            statusEl.style.color = '#10b981';
            statusEl.style.textShadow = '0 0 5px rgba(16,185,129,0.3)';
        } else if (status.status === 'H4_BREAK_DETECTED') {
            statusEl.style.color = '#f59e0b';
            statusEl.style.textShadow = '0 0 5px rgba(245,158,11,0.3)';
        } else if (status.status === 'CONFIRMATION_CANDLE') {
            statusEl.style.color = '#8b5cf6';
            statusEl.style.textShadow = '0 0 5px rgba(139,92,246,0.3)';
        } else if (status.status === 'ACTIVE_SETUP') {
            statusEl.style.color = '#ec4899';
        } else {
            statusEl.style.color = 'var(--text-primary)';
            statusEl.style.textShadow = 'none';
        }
    }
    
    const breaksEl = document.getElementById('stat-breaks');
    if (breaksEl) breaksEl.textContent = status.h4Breaks || 0;
    
    const retestsEl = document.getElementById('stat-retests');
    if (retestsEl) retestsEl.textContent = status.retests || 0;
    
    const entriesEl = document.getElementById('stat-entries');
    if (entriesEl) entriesEl.textContent = status.entries || 0;
    
    const timeEl = document.getElementById('status-time');
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
    
    const setupDiv = document.getElementById('active-setup');
    if (setupDiv) {
        if (status.currentState === 'ACTIVE_SETUP' && status.lastBreakLevel) {
            setupDiv.style.display = 'block';
            const setupDetails = document.getElementById('setup-details');
            if (setupDetails) {
                setupDetails.innerHTML = `${status.lastBreakDirection || '?'} @ ${parseFloat(status.lastBreakLevel).toFixed(4)} | ${status.retestCount || 0}/${status.maxRetests || 3} retests | ${status.setupAge?.toFixed(1) || 0}h old`;
            }
            const setupTimer = document.getElementById('setup-timer');
            if (setupTimer) {
                setupTimer.textContent = `${status.setupAge?.toFixed(1) || 0}h`;
                setupTimer.style.color = (status.setupAge || 0) > 1.5 ? '#ef4444' : '#f59e0b';
            }
        } else {
            setupDiv.style.display = 'none';
        }
    }
    
    const signalDiv = document.getElementById('last-signal');
    if (signalDiv) {
        if (status.status === 'ENTRY_SIGNAL_FIRED' && status.direction) {
            signalDiv.style.display = 'block';
            const signalDetails = document.getElementById('signal-details');
            if (signalDetails) {
                signalDetails.innerHTML = `${status.direction} @ ${parseFloat(status.entryPrice).toFixed(4)} | R:R ${parseFloat(status.rr).toFixed(2)}:1 | SL: ${parseFloat(status.sl).toFixed(4)} TP: ${parseFloat(status.tp).toFixed(4)}`;
            }
            const signalTime = document.getElementById('signal-time');
            if (signalTime && status.timeDetected) {
                signalTime.textContent = new Date(status.timeDetected).toLocaleTimeString();
            }
            signalDiv.style.animation = 'none';
            setTimeout(() => { signalDiv.style.animation = 'glowPulse 0.5s ease-in-out'; }, 10);
        } else {
            signalDiv.style.display = 'none';
        }
    }
    
    const lastEventEl = document.getElementById('last-event-text');
    if (lastEventEl) {
        let eventText = status.status || 'IDLE';
        if (status.direction) eventText += ` (${status.direction})`;
        if (status.rr) eventText += ` | R:R ${parseFloat(status.rr).toFixed(2)}`;
        lastEventEl.textContent = eventText;
    }
}

function _startStatusPolling() {
    if (pollInterval) clearInterval(pollInterval);
    // Poll every 10 seconds (reduced from 3 seconds to avoid rate limiting)
    pollInterval = setInterval(_pollStrategyStatus, 10000);
    _pollStrategyStatus();
}

// Add CSS animation
const style = document.createElement('style');
style.textContent = `
    @keyframes glowPulse {
        0% { border-left-color: #10b981; box-shadow: 0 0 0px rgba(16,185,129,0); }
        50% { border-left-color: #10b981; box-shadow: 0 0 10px rgba(16,185,129,0.5); }
        100% { border-left-color: #10b981; box-shadow: 0 0 0px rgba(16,185,129,0); }
    }
`;
document.head.appendChild(style);

// ─────────────────────────────────────────────────────────────
// START / STOP BOT
// ─────────────────────────────────────────────────────────────
window.startBot = function(id) {
    const config = window.getBotConfig(id);
    if (!config) return;

    const maxBots = Settings.get('maxBots') || 3;
    const activeBotCount = Object.values(bots).filter(b => b.isActive).length;
    if (activeBotCount >= maxBots) {
        log(`Risk block: max ${maxBots} bots allowed. Stop one first.`, 'warn');
        return;
    }

    const maxDailyLoss = Settings.get('maxDailyLoss') || 500;
    const sessionState = SessionState.get();
    if (sessionState.sessionPnL <= -maxDailyLoss) {
        log(`Risk block: daily loss limit $${maxDailyLoss} reached. Trading halted.`, 'warn');
        _showRiskAlert(`Daily loss limit of $${maxDailyLoss} reached. All trading halted.`);
        return;
    }

    const bot        = new BotState(id, config);
    bots[id]         = bot;
    bot.isActive     = true;
    bot.sessionStart = Date.now();
    
    bot.accountEquity = SessionState.get().accountEquity || 10000;

    window.setBotRunning(id, true);
    UIManager.startSession();
    log(`Bot #${id} started — ${config.strategy} on ${config.symbol} ${TF_LABEL[config.tf] || 'M5'}`, 'info');

    const symLabel = (SYMBOL_MAP[config.symbol] || config.symbol).replace(' Index','').trim();
    ChartManager.addBot(id, symLabel, TF_LABEL[config.tf] || 'M5');
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph) ph.style.display = 'none';

    if (api?.socket?.readyState === 1) {
        subscribeBot(bot);
    } else {
        log(`Bot #${id} queued — waiting for API connection`, 'warn');
    }

    if (!focusedBotId) window.focusBot(id);

    SessionState.set({ activeBots: Object.values(bots).filter(b => b.isActive).length });
    _saveBotConfigs();

    PositionSizing.reset();
    PositionSizing.resetSession(bot.accountEquity);
};

window.stopBot = function(id) {
    const bot = bots[id];
    if (!bot) return;
    bot.isActive = false;
    window.setBotRunning(id, false);
    log(`Bot #${id} stopped`, 'neutral');

    if (bot.config?.symbol) {
        api.forgetSymbol(bot.config.symbol, bot.config.tf);
        api.forgetSymbol(bot.config.symbol, 14400);
        if (bot.config.strategy === 'jump75') {
            api.forgetSymbol(bot.config.symbol, 300);
            api.forgetSymbol(bot.config.symbol, 900);
        }
    }

    ChartManager.removeBot(id);
    if (ChartManager.count() === 0) {
        const ph = document.getElementById('chart-placeholder-empty');
        if (ph) ph.style.display = 'flex';
    }

    SessionState.set({ activeBots: Object.values(bots).filter(b => b.isActive).length });
    _saveBotConfigs();
};

window.focusBot = function(id) {
    focusedBotId = id;
    const bot = bots[id];
    if (!bot) return;

    const symLabel = (SYMBOL_MAP[bot.config.symbol] || bot.config.symbol).replace(' Index','').trim();
    const tfLabel  = TF_LABEL[bot.config.tf] || 'M5';

    document.getElementById('chart-symbol-label').textContent = symLabel;
    document.getElementById('chart-tf-label').textContent     = tfLabel;
    ChartManager.updateLabel(id, symLabel, tfLabel);

    if (ChartManager.count() > 1) {
        ChartManager.focus(id);
        _loadOverlayState(id);
        _showOverlayPanel(true);
        setTimeout(() => {
            ChartManager.loadMain(id, bot.candles);
            redrawOverlays();
            if (bot.openSignal) {
                const eng = ChartManager.mainEngine();
                if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
            }
        }, 30);
    } else {
        _showOverlayPanel(true);
        _loadOverlayState(id);
        const engine = ChartManager.get(id);
        if (engine && bot.candles.length > 0) {
            engine.setData(bot.candles);
            engine.chart.timeScale().fitContent();
            redrawOverlays();
        }
    }
};

window.onSplitView = function() {
    _showOverlayPanel(false);
};

function _engineFor(botId) {
    if (!ChartManager.isSplitMode() && botId === focusedBotId) {
        return ChartManager.mainEngine();
    }
    return ChartManager.get(botId);
}

function subscribeBot(bot) {
    Notify.request();
    
    if (bot.config.strategy === 'jump75') {
        api.subscribe(bot.config.symbol, 300);
        api.subscribe(bot.config.symbol, 900);
        api.subscribe(bot.config.symbol, 14400);
        log(`Subscribed ${bot.config.symbol} for Jump75: M5 + M15 + H4`, 'info');
        return;
    }
    
    const HTF_GRAN_MAP = {60:1800, 120:3600, 180:3600, 300:3600, 600:7200, 900:14400, 1800:14400, 3600:86400, 14400:604800};
    bot.htfGran = (bot.config.strategy === 'vortex' || bot.config.strategy === 'phantom')
        ? (HTF_GRAN_MAP[bot.config.tf] || 3600)
        : 14400;
    api.subscribe(bot.config.symbol, bot.config.tf);
    api.subscribe(bot.config.symbol, bot.htfGran);
    const htfLabel = TF_LABEL[bot.htfGran] || `${bot.htfGran}s`;
    log(`Subscribed: ${bot.config.symbol} ${TF_LABEL[bot.config.tf] || 'M5'} + ${htfLabel}`, 'info');
}

// ─────────────────────────────────────────────────────────────
// HANDLE DERIV API DATA
// ─────────────────────────────────────────────────────────────
function handleData(data) {
    if (data.error) {
        const req = data.echo_req || {};
        const sym = req.ticks_history || req.subscribe || '?';
        const gran = req.granularity ? ` (${TF_LABEL[req.granularity] || req.granularity})` : '';
        log(`API Error [${sym}${gran}]: ${data.error.message}`, 'warn');
        if (req.granularity && req.granularity !== 14400) {
            Object.values(bots).forEach(bot => {
                if (bot.isActive && bot.config.symbol === sym) {
                    log(`Bot on ${sym} may not function — check account permissions`, 'warn');
                }
            });
        }
        return;
    }

    if (data.msg_type === 'authorize') {
        authorised = true;
        document.getElementById('connection-indicator').className = 'status-dot status-online';
        document.getElementById('conn-label').textContent         = 'Online';
        log('Terminal authorized — connection established', 'info');
        api.fetchActiveSymbols();
        SessionState.set({ connected: true });
        Object.values(bots).forEach(bot => {
            window.setBotOnline(bot.id);
            if (bot.isActive) subscribeBot(bot);
        });
    }

    if (data.msg_type === 'active_symbols') {
        data.active_symbols.forEach(s => { symbolMap[s.symbol] = s.display_name; });
        log(`${data.active_symbols.length} symbols loaded`, 'info');
    }

    if (data.msg_type === 'candles') {
        const gran    = data.echo_req.granularity;
        const symbol  = data.echo_req.ticks_history;
        const history = data.candles.map(c => ({
            time:  parseInt(c.epoch),
            open:  parseFloat(c.open),
            high:  parseFloat(c.high),
            low:   parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        Object.values(bots).forEach(bot => {
            if (!bot.isActive) return;
            if (bot.config.symbol !== symbol) return;
            
            if (bot.config.strategy === 'jump75') {
                if (gran === 300) {
                    history.forEach(candle => {
                        bot.m5Candles.push(candle);
                        if (bot.m5Candles.length > 100) bot.m5Candles.shift();
                        bot.lastM5CloseTime = candle.time;
                    });
                }
                
                if (gran === 900) {
                    history.forEach(candle => {
                        bot.m15Candles.push(candle);
                        if (bot.m15Candles.length > 50) bot.m15Candles.shift();
                        bot.lastM15CloseTime = candle.time;
                    });
                }
                
                if (gran === 14400) {
                    history.forEach(candle => {
                        bot.h4Candles.push(candle);
                        if (bot.h4Candles.length > 30) bot.h4Candles.shift();
                        bot.lastH4CloseTime = candle.time;
                    });
                }
            }
            
            if (gran === bot.config.tf) {
                bot.candles = history;
                const eng = ChartManager.get(bot.id);
                if (eng) {
                    eng.setData(history);
                    if (bot.id === focusedBotId) redrawOverlays();
                    else if (ChartManager.isSplitMode()) {
                        const saved = overlayState[bot.id] || {};
                        const current = {};
                        OVERLAY_IDS.forEach(oid => {
                            const el = document.getElementById(oid);
                            if (el) { current[oid] = el.checked; el.checked = saved[oid] || false; }
                        });
                        _drawOverlaysOnEngine(eng, bot);
                        OVERLAY_IDS.forEach(oid => {
                            const el = document.getElementById(oid);
                            if (el) el.checked = current[oid];
                        });
                    }
                }
            }
            
            if (gran === 14400 && bot.config.symbol === symbol) {
                bot.h4Candles = history;
            }
            if (gran === bot.htfGran && bot.config.symbol === symbol) {
                bot.htfCandles = history;
                if (bot.config.strategy === 'vortex') VortexStrategy.setHtfCandles(bot.id, history);
            }
        });
    }

    if (data.msg_type === 'ohlc') {
        const gran   = data.echo_req.granularity;
        const symbol = data.ohlc.symbol || data.echo_req.ticks_history;
        const bar    = {
            time:  parseInt(data.ohlc.open_time),
            open:  parseFloat(data.ohlc.open),
            high:  parseFloat(data.ohlc.high),
            low:   parseFloat(data.ohlc.low),
            close: parseFloat(data.ohlc.close)
        };
        Object.values(bots).forEach(bot => {
            if (bot.isActive && bot.config.symbol === symbol) {
                processBar(bot, bar, gran);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────
// PROCESS BAR
// ─────────────────────────────────────────────────────────────
function processBar(bot, bar, gran) {
    if (gran === 14400) {
        const last = bot.h4Candles[bot.h4Candles.length - 1];
        if (last && last.time === bar.time) bot.h4Candles[bot.h4Candles.length - 1] = bar;
        else bot.h4Candles.push(bar);
        if (bot.h4Candles.length > 500) bot.h4Candles.shift();
    }
    if (gran === bot.htfGran) {
        const lastH = bot.htfCandles[bot.htfCandles.length - 1];
        if (lastH && lastH.time === bar.time) bot.htfCandles[bot.htfCandles.length - 1] = bar;
        else bot.htfCandles.push(bar);
        if (bot.htfCandles.length > 500) bot.htfCandles.shift();
        if (bot.config.strategy === 'vortex') VortexStrategy.setHtfCandles(bot.id, bot.htfCandles);
        if (bot.config.strategy === 'phantom') PhantomStrategy.setHtfCandles(bot.id, bot.htfCandles);
    }

    if (bot.config.strategy === 'jump75') {
        if (gran === 300) {
            bot.m5Candles.push(bar);
            if (bot.m5Candles.length > 100) bot.m5Candles.shift();
            bot.lastM5CloseTime = bar.time;
        }
        if (gran === 900) {
            bot.m15Candles.push(bar);
            if (bot.m15Candles.length > 50) bot.m15Candles.shift();
            bot.lastM15CloseTime = bar.time;
        }
        if (gran === 14400) {
            bot.h4Candles.push(bar);
            if (bot.h4Candles.length > 30) bot.h4Candles.shift();
            bot.lastH4CloseTime = bar.time;
        }
    }

    if (gran !== bot.config.tf) return;

    const last = bot.candles[bot.candles.length - 1];
    if (last && last.time === bar.time) bot.candles[bot.candles.length - 1] = bar;
    else bot.candles.push(bar);
    if (bot.candles.length > 1000) bot.candles.shift();

    const activeEng = _engineFor(bot.id);
    if (activeEng) activeEng.update(bar);

    if (!ChartManager.isSplitMode() && bot.id === focusedBotId) {
        const splitEng = ChartManager.get(bot.id);
        if (splitEng && splitEng !== activeEng) splitEng.update(bar);
    }

    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const atr = Indicators.calculateATR(bot.candles);

    const isTrending = bot.candles.length >= 20
        ? MomentumStrategy._isTrending(bot.candles, atr) : null;
    const marketCond = isTrending === null ? '—' : isTrending ? 'TRENDING' : 'RANGING';

    ChartManager.updatePanelHUD(bot.id, rsi, atr, marketCond);
    if (bot.id === focusedBotId) UIManager.updateHUD(rsi, atr, marketCond);

    const livePrices = SessionState.get().livePrices || {};
    const displaySym = SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
    const firstClose = bot.candles[0]?.close;
    livePrices[displaySym] = {
        price:  bar.close,
        change: firstClose ? parseFloat(((bar.close - firstClose) / firstClose * 100).toFixed(2)) : 0,
    };
    SessionState.set({ livePrices });

    checkOutcome(bot);

    if (bot.config.strategy === 'phantom') { _runPhantom(bot, bar, atr, rsi); return; }
    if (bot.config.strategy === 'nova')    { _runNova(bot, bar, atr, rsi);    return; }
    if (bot.config.strategy === 'pulse')   { _runPulse(bot, bar, atr, rsi);   return; }
    if (bot.config.strategy === 'kismet')  { _runKismet(bot, bar, atr, rsi);  return; }
    if (bot.config.strategy === 'cipher')  { _runCipher(bot, bar, atr, rsi);  return; }
    if (bot.config.strategy === 'vortex')  { _runVortex(bot, bar, atr, rsi);  return; }
    if (bot.config.strategy === 'ultra_scalp') { _runUltraScalper(bot, bar, atr, rsi); return; }
    if (bot.config.strategy === 'jump75')  { _runJump75(bot, bar, atr, rsi);  return; }
    
    if (document.getElementById('auto-session')?.checked) {
        const forexStrategies = ['momentum','london_breakout','news_fade','swing','h4_kiss'];
        if (forexStrategies.includes(bot.config.strategy)) {
            const hour = new Date().getUTCHours();
            if (hour < 7 || hour > 20) return;
        }
    }

    const signal = bot.strategy.analyze(
        bot.config.strategy, bot.candles, bot.h4Candles,
        bot.rsiState, atr, bot.config.symbol, rsi
    );

    const now = Date.now();
    if (signal && (now - bot.lastFiredMs) > 30000) {

        if (bot.config.strategy === 'vwap_reversion' && signal.type === 'BUY') {
            if (bot.h4Candles.length >= 21) {
                const k     = 2 / 22;
                let h4ema   = bot.h4Candles.slice(0,21).reduce((s,c)=>s+c.close,0) / 21;
                for (let i = 21; i < bot.h4Candles.length; i++)
                    h4ema = bot.h4Candles[i].close * k + h4ema * (1 - k);
                const h4Last = bot.h4Candles[bot.h4Candles.length - 1];
                if (h4Last.close < h4ema) {
                    log(`VWAP BUY filtered — H4 trend bearish (price ${h4Last.close.toFixed(4)} < EMA21 ${h4ema.toFixed(4)})`, 'neutral');
                    return;
                }
            }
        }

        if (bot.config.strategy === 'range_boundary') {
            const msSinceLastSL = now - bot.lastSLTimeMs;
            const COOLDOWN_MS   = 30 * 60 * 1000;
            if (bot.lastSLTimeMs > 0 && msSinceLastSL < COOLDOWN_MS) {
                const minsLeft = Math.ceil((COOLDOWN_MS - msSinceLastSL) / 60000);
                log(`Range Boundary cooldown — ${minsLeft}m remaining after last SL`, 'neutral');
                return;
            }
        }

        if (bot.config.strategy === 'h4_kiss') {
            if (bot.h4Candles.length >= 21) {
                const k     = 2 / 22;
                let h4ema   = bot.h4Candles.slice(0,21).reduce((s,c)=>s+c.close,0) / 21;
                for (let i = 21; i < bot.h4Candles.length; i++)
                    h4ema = bot.h4Candles[i].close * k + h4ema * (1 - k);
                const candidate  = bot.h4KissCandidate;
                const isNearKiss = Math.abs(bar.close - h4ema) < atr * 0.8;
                if (!candidate && isNearKiss) {
                    bot.h4KissCandidate = { dir: signal.type, bar: bar.time };
                    log(`H4 Kiss first touch @ ${bar.close.toFixed(4)} — waiting for confirmation bar`, 'neutral');
                    return;
                } else if (candidate) {
                    if (candidate.dir !== signal.type) { bot.h4KissCandidate = null; return; }
                    bot.h4KissCandidate = null;
                    log(`H4 Kiss confirmed (2-bar) @ ${bar.close.toFixed(4)}`, 'info');
                } else {
                    return;
                }
            }
        }

        if (bot.config.strategy === 'synthetic_scalp') {
            const barsSinceLastSL = bot.candles.length - bot.lastSLBarIdx;
            if (bot.lastSLBarIdx > 0 && barsSinceLastSL < 2) {
                log(`Synthetic scalp re-entry blocked — only ${barsSinceLastSL} bar(s) since last SL`, 'neutral');
                return;
            }
        }

        bot.lastFiredMs = now;
        fireSignal(bot, signal, bar, atr, rsi, isTrending);
    }
}

// ─────────────────────────────────────────────────────────────
// JUMP75 RUNNER - FIXED VERSION
// ─────────────────────────────────────────────────────────────
async function _runJump75(bot, bar, atr, rsi) {
    const jumpSymbols = ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'];
    if (!jumpSymbols.includes(bot.config.symbol)) return null;
    
    if (bot.m5Candles.length < 10 || bot.m15Candles.length < 10 || bot.h4Candles.length < 5) {
        return null;
    }
    
    try {
        const signal = await Jump75Strategy.checkEntry(
            bot.m5Candles,
            bot.m15Candles,
            bot.h4Candles,
            atr
        );
        
        if (signal) {
            const now = Date.now();
            const cooldownMs = 30000;
            if ((now - bot.lastFiredMs) < cooldownMs) return null;
            
            bot.lastFiredMs = now;
            
            const signalType = signal.type || signal.direction || 'BUY/SELL';
            const displayType = signalType === 'LONG' ? 'BUY' : (signalType === 'SHORT' ? 'SELL' : signalType);
            
            const factorsText = signal.factors && Array.isArray(signal.factors) 
                ? signal.factors.join(' · ') 
                : '';
            
            log(`🦘 JUMP75 ${displayType} @ ${bar.close.toFixed(4)}${factorsText ? ' | ' + factorsText : ''}`, 
                displayType === 'BUY' ? 'buy' : 'sell');
            
            fireSignal(bot, signal, bar, atr, rsi, null);
        }
    } catch (error) {
        console.error('[Jump75] Error in _runJump75:', error);
        log(`🦘 JUMP75 error: ${error.message}`, 'warn');
    }
}

// Note: All other strategy runner functions (_runPhantom, _runNova, _runPulse, _runKismet, _runCipher, _runVortex, _runUltraScalper) 
// and helper functions (_phantomCloseTrade, _novaCloseTrade, _pulseCloseTrade, _kismetCloseTrade, _cipherCloseTrade, 
// _vortexCloseTrade, _ultraScalperCloseTrade, _applyTrailingStop, _pushMT5Modify, checkOutcome, fireSignal, 
// _drawOverlaysOnEngine, redrawOverlays, redrawAllSplitOverlays, _showRiskAlert, logout, _createBotCard, log, etc.)
// remain unchanged from your original file. They have been omitted here for brevity but should be kept in your actual file.

document.addEventListener('DOMContentLoaded', init);