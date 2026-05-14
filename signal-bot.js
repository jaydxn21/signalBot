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
import KismetVolatilityIndices from './js/strategies/kismet.js';  // Default import only
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
import { RangeBoundaryStrategy } from './js/strategies/range_boundary.js';

// FORCE CACHE BUSTER
console.log("%c🚀 SIGNAL-BOT.JS LOADED - VERSION 3.1 (AI DEBUG)", "color: #ff00ff; font-size: 16px; font-weight: bold; background: black; padding: 4px 8px;");
// ─────────────────────────────────────────────────────────────
// ULTRA AGGRESSIVE AI DEBUG
// ─────────────────────────────────────────────────────────────
console.log("%c🚀 Signal Bot v3.0 - AI Debug LOADED", "color: #a855f7; font-size: 16px; font-weight: bold");

let aiServerReady = false;

async function checkAIServer() {
    console.log("%c🔍 [AI] Attempting connection to localhost:5000...", "color: cyan; font-weight: bold");
    
    try {
        const res = await fetch('https://ai-server-production-8bc5.up.railway.app/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rr_ratio: 2.0,
                atr_ratio: 1.5,
                is_breakout: 0,
                hour: new Date().getHours(),
                symbol_type: 1
            })
        });

        if (res.ok) {
            aiServerReady = true;
            console.log("%c✅ AI SERVER CONNECTED SUCCESSFULLY", "color: lime; font-size: 16px; font-weight: bold");
        } else {
            console.log("%c❌ AI Server responded but not OK", "color: orange");
        }
    } catch (e) {
        console.log("%c⛔ CANNOT REACH AI SERVER", "color: red; font-weight: bold");
        console.log("   Make sure 'python ai_server.py' is running in terminal");
    }
}

// Run multiple times
checkAIServer();
setTimeout(checkAIServer, 800);
setTimeout(checkAIServer, 2000);
setTimeout(checkAIServer, 4000);


// Improved predictor
async function getAIWinProbability(signal, atr, rsi, isBreakout = false) {
    if (!aiServerReady) return 50;

    try {
        const features = {
            rr_ratio: (signal.tpMultiplier || 2.2) / (signal.slMultiplier || 1.0),
            atr_ratio: signal.slMultiplier || 1.5,
            is_breakout: isBreakout ? 1 : 0,
            hour: new Date().getHours(),
            symbol_type: signal.symbol?.includes('75') ? 1 : signal.symbol?.includes('10') ? 2 : 3
        };

        const res = await fetch('https://ai-server-production-8bc5.up.railway.app/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(features)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.win_probability || 50;
    } catch(e) {
        console.warn("AI Prediction failed:", e.message);
        return 50;
    }
}




// ─────────────────────────────────────────────────────────────
// WEBSOCKET CONNECTION TO LOCAL BRIDGE (bridge.cjs)
// ─────────────────────────────────────────────────────────────
let renderWS = null;
let pendingSignals = [];

function connectRenderWebSocket() {
    if (renderWS && (renderWS.readyState === WebSocket.OPEN || renderWS.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const WS_URL = 'ws://localhost:3000/';   // ← NO '/mt5' - use root path for frontend
    console.log(`[WS] Connecting to LOCAL BRIDGE: ${WS_URL}`);

    renderWS = new WebSocket(WS_URL);
    window.renderWS = renderWS;

    renderWS.onopen = () => {
        console.log("✅ Connected to LOCAL MT5 Bridge (localhost:3000)");
        log("✅ Connected to MT5 bridge via local proxy", "info");
        const indicator = document.getElementById("mt5-indicator");
        if (indicator) indicator.className = "status-dot status-online";
        SessionState.set({ mt5Connected: true });

        // Send identification as frontend
        renderWS.send(JSON.stringify({
            type: 'frontend',
            client: 'signal-bot',
            timestamp: Date.now()
        }));

        if (pendingSignals.length > 0) {
            console.log(`📤 Flushing ${pendingSignals.length} pending signals...`);
            pendingSignals.forEach(sig => {
                try { renderWS.send(JSON.stringify(sig)); } catch(e) { console.warn("[WS] flush failed", e); }
            });
            pendingSignals = [];
        }
    };

    renderWS.onerror = (err) => {
    console.error("❌ Local Bridge ERROR:", err);
    console.log("WebSocket readyState:", renderWS.readyState);
    console.log("WebSocket URL:", renderWS.url);
    
    // Try to get more info
    if (err.message) console.log("Error message:", err.message);
    if (err.error) console.log("Error object:", err.error);
    
    const indicator = document.getElementById("mt5-indicator");
    if (indicator) indicator.className = "status-dot status-offline";
    log("Cannot connect to local bridge. Is bridge.cjs running?", "warn");
};

    renderWS.onclose = () => {
        console.log("⚠️ Local bridge disconnected — reconnecting in 5s...");
        const indicator = document.getElementById("mt5-indicator");
        if (indicator) indicator.className = "status-dot status-offline";
        SessionState.set({ mt5Connected: false });
        setTimeout(connectRenderWebSocket, 5000);
    };

    renderWS.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log("[Bridge] Received:", data);
            if (data.type === "trade_result") {
                log(`MT5 Trade Result: ${data.outcome} ${data.symbol} P&L: ${data.pnl}`, "info");
            }
        } catch(e) {
            console.log("[Bridge] Raw message:", event.data);
        }
    };
}

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
        // Forex pairs (pip value $10 per lot for most)
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
};

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
        
        // CANDLE STORAGE
        this.m5Candles = [];
        this.m15Candles = [];
        this.lastM5CloseTime = null;
        this.lastM15CloseTime = null;
        this.lastH4CloseTime = null;
    };
};

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
        if (Notification.permission === 'granted') { this._allowed = true; return; };
        if (Notification.permission !== 'denied') {
            const perm = await Notification.requestPermission();
            this._allowed = perm === 'granted';
        };
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
        } catch(e) {};
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
        } catch(e) {};
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
    };
};

function _saveOverlayState(botId) {
    const state = {};
    OVERLAY_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) state[id] = el.checked;
    });
    overlayState[botId] = state;
};

function _loadOverlayState(botId) {
    const state = overlayState[botId] || {};
    OVERLAY_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = state[id] || false;
    });
};

function _showOverlayPanel(show) {
    const panel = document.getElementById('overlay-panel');
    if (panel) panel.style.display = show ? 'block' : 'none';
};

// ─────────────────────────────────────────────────────────────
// SAVE / RESTORE BOT CONFIGS
// ─────────────────────────────────────────────────────────────
function _saveBotConfigs() {
    const active = Object.values(bots)
        .filter(b => b.isActive)
        .map(b => ({ id: b.id, config: b.config }));
    SessionState.set({ botConfigs: active });
};

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
    if (firstId) { focusedBotId = firstId; };
};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
async function init() {

    console.log("%c🚀 Signal Bot v3.0 initializing...", "color: violet; font-weight: bold");

    // Connect to MT5 bridge WebSocket
    connectRenderWebSocket();
    api = new DerivAPI(96293, handleData);
    initChartManager();

    Analytics.init();
setTimeout(() => {
        console.log("%c[INIT] Running AI connection test...", "color: cyan");
        checkAIServer();
    }, 800);
    
    // Initialize Position Sizing
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
                };
            }).catch(() => {});
        };
    };

    const restoredState = SessionState.get();
    const pnlEl = document.getElementById('session-pnl');
    if (pnlEl && restoredState.sessionPnL !== 0) {
        const pnl = restoredState.sessionPnL;
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
        pnlEl.style.color = pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    };
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
    };

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

        if (!phantomBot) { hudWrap.style.display = 'none'; return; };

        const session = PhantomStrategy.getSession();

        if (session.mode === 'halted') {
            hudWrap.style.display = 'flex';
            hudEl.textContent = '🛑 HALTED';
            hudEl.style.color = '#f87171';
            return;
        };
        if (session.mode === 'observer') {
            hudWrap.style.display = 'flex';
            hudEl.textContent = '👁 OBSERVING';
            hudEl.style.color = '#a78bfa';
            return;
        };
        if (phantomBot.openSignal?.isPhantom) {
            hudWrap.style.display = 'flex';
            const trailLabel = phantomBot.openSignal.scaleOutDone ? 'TRAILING ½' : 'IN TRADE';
            hudEl.textContent = trailLabel;
            hudEl.style.color = '#34d399';
            return;
        };

        const tf = phantomBot.config.tf || 300;
        const lastCandle = phantomBot.candles?.[phantomBot.candles.length - 1];
        if (!lastCandle) { hudWrap.style.display = 'none'; return; };

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
                };
                const overlay = document.getElementById('deploy-overlay');
                if (overlay) {
                    overlay.style.transition = 'opacity 0.4s';
                    overlay.style.opacity = '0';
                    setTimeout(() => {
                        overlay.style.display = 'none';
                        document.documentElement.removeAttribute('data-deploying');
                    }, 420);
                };
            }, 350);
        } catch(e) {
            console.warn('[Deploy] Failed to parse payload', e);
            const overlay = document.getElementById('deploy-overlay');
            if (overlay) overlay.style.display = 'none';
        };
    };

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
            };
            const symSelect = targetCard.querySelector('.bot-symbol-select');
            if (symSelect) {
                symSelect.value = quickSym;
                symSelect.dispatchEvent(new Event('change'));
                log(`Symbol pre-selected from Market: ${quickSym}`, 'info');
                targetCard.style.transition = 'box-shadow 0.3s';
                targetCard.style.boxShadow = '0 0 0 2px #06b6d4';
                setTimeout(() => { targetCard.style.boxShadow = ''; }, 2000);
            };
        }, 400);
    };
};

// ─────────────────────────────────────────────────────────────
// START / STOP BOT
// ─────────────────────────────────────────────────────────────
window.startBot = function(id) {
    const config = window.getBotConfig(id);
    if (!config) return;
    
    // ✅ APPLY QUALITY MODE BEFORE STARTING BOT
    if (config.strategy === 'jump75') {
        const savedMode = window._botQualityModes?.[id] ?? 1;
        const modeInfo = QUALITY_MODE_DESCRIPTIONS[savedMode];
        console.log(`[Jump75] Starting bot ${id} with quality mode ${savedMode} (${modeInfo.name})`);
        
        if (window.Jump75Strategy && typeof window.Jump75Strategy.setMode === 'function') {
            window.Jump75Strategy.setMode(savedMode);
        } else if (window.Jump75Strategy) {
            window.Jump75Strategy.QUALITY_MODE = savedMode;
        }
        
        log(`🎯 Jump75 Quality Mode: ${modeInfo.emoji} ${modeInfo.name}`, 'info');
        log(`   Min Score: ${modeInfo.minScore} | Min Momentum: ${modeInfo.minMomentum}`, 'info');
    }
    
    // ✅ APPLY QUALITY MODE FOR RANGE_BOUNDARY
    if (config.strategy === 'range_boundary') {
        const savedMode = window._botQualityModes?.[id] ?? 1;
        const modeNames = { 0: 'FAST', 1: 'BALANCED', 2: 'SAFE' };
        console.log(`[RangeBoundary] Starting bot ${id} with mode ${savedMode} (${modeNames[savedMode]})`);
        
        if (window.RangeBoundaryStrategy && typeof window.RangeBoundaryStrategy.setMode === 'function') {
            window.RangeBoundaryStrategy.setMode(savedMode);
        } else if (window.RangeBoundaryStrategy) {
            window.RangeBoundaryStrategy.QUALITY_MODE = savedMode;
        }
        
        log(`🎯 RangeBoundary Mode: ${modeNames[savedMode] || 'BALANCED'}`, 'info');
    }
    
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
    
    const bot = new BotState(id, config);
    bots[id] = bot;
    bot.isActive = true;
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
        // Also forget M5 and M15 if they were subscribed for Jump75
        if (bot.config.strategy === 'jump75') {
            api.forgetSymbol(bot.config.symbol, 300);
            api.forgetSymbol(bot.config.symbol, 900);
        };
    };

    ChartManager.removeBot(id);
    
    // Clear analysis when bot stops
    const engine = ChartManager.get(id);
    if (engine) {
        try {
            engine.clearAnalysis();
        } catch(e) {
            console.warn('[Chart] Failed to clear analysis:', e.message);
        };
    };
    
    if (ChartManager.count() === 0) {
        const ph = document.getElementById('chart-placeholder-empty');
        if (ph) ph.style.display = 'flex';
    };

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
            
            // Draw H4 levels and analysis
            _drawBotAnalysis(id, bot);
            
            redrawOverlays();
            if (bot.openSignal) {
                const eng = ChartManager.mainEngine();
                if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
            };
        }, 30);
    } else {
        _showOverlayPanel(true);
        _loadOverlayState(id);
        const engine = ChartManager.get(id);
        if (engine && bot.candles.length > 0) {
            engine.setData(bot.candles);
            engine.chart.timeScale().fitContent();
            
            // Draw H4 levels and analysis
            _drawBotAnalysis(id, bot);
            
            redrawOverlays();
        };
    };
};

window.onSplitView = function() {
    _showOverlayPanel(false);
};

// ─────────────────────────────────────────────────────────────
// ✅ NEW: Draw H4 Levels & Strategy-Specific Analysis
// ─────────────────────────────────────────────────────────────

function _drawBotAnalysis(botId, bot) {
    const engine = _engineFor(botId);
    if (!engine) return;

    // Always draw H4 levels if available
    if (bot.h4Candles && bot.h4Candles.length > 0) {
        try {
            engine.drawH4Levels(bot.h4Candles);
            console.log(`[Chart] H4 levels drawn for ${bot.config.symbol}`);
        } catch(e) {
            console.warn('[Chart] Failed to draw H4 levels:', e.message);
        };
    };
};

function _engineFor(botId) {
    if (!ChartManager.isSplitMode() && botId === focusedBotId) {
        return ChartManager.mainEngine();
    };
    return ChartManager.get(botId);
};

function subscribeBot(bot) {
    Notify.request();
    
    // For Jump75 strategy, subscribe to M5, M15, and H4
    if (bot.config.strategy === 'jump75') {
        api.subscribe(bot.config.symbol, 300);   // M5
        api.subscribe(bot.config.symbol, 900);   // M15
        api.subscribe(bot.config.symbol, 14400); // H4
        log(`Subscribed ${bot.config.symbol} for Jump75: M5 + M15 + H4`, 'info');
        return;
    };
    
    const HTF_GRAN_MAP = {60:1800, 120:3600, 180:3600, 300:3600, 600:7200, 900:14400, 1800:14400, 3600:86400, 14400:604800};
    bot.htfGran = (bot.config.strategy === 'vortex' || bot.config.strategy === 'phantom')
        ? (HTF_GRAN_MAP[bot.config.tf] || 3600)
        : 14400;
    api.subscribe(bot.config.symbol, bot.config.tf);
    api.subscribe(bot.config.symbol, bot.htfGran);
    const htfLabel = TF_LABEL[bot.htfGran] || `${bot.htfGran}s`;
    log(`Subscribed: ${bot.config.symbol} ${TF_LABEL[bot.config.tf] || 'M5'} + ${htfLabel}`, 'info');
};

/**
 * Get recommended analysis config for each strategy
 * Customize these based on your trading style
 */
function _getStrategyAnalysis(strategy) {
    const configs = {
        // Jump75: Multi-timeframe, needs volatility and trend info
        'jump75': {
            sma: { periods: 20, color: '#2563eb' },      // Trend
            atr: { periods: 14, color: '#f59e0b' }       // Volatility
        },

        // Momentum: Trending strategy, needs EMA + ATR
        'momentum': {
            ema: { periods: 9, color: '#059669' },       // Fast trend
            sma: { periods: 21, color: '#3b82f6' },      // Slow trend
            atr: { periods: 14, color: '#f59e0b' }       // Volatility
        },

        // Phantom: High-precision daily target
        'phantom': {
            sma: { periods: 20, color: '#a78bfa' },      // Median
            atr: { periods: 14, color: '#f59e0b' }       // Risk sizing
        },

        // Nova: Spike-based strategy on Crash/Boom
        'nova': {
            atr: { periods: 14, color: '#f59e0b' },      // Spike detection
            bollingerBands: { periods: 20, stdDev: 2 }   // Range extremes
        },

        // Pulse: Compounding on Crash/Boom
        'pulse': {
            atr: { periods: 14, color: '#f59e0b' },      // Volatility tracking
            sma: { periods: 20, color: '#2563eb' }       // Direction
        },

        // Kismet: Structure-based strategy
        'kismet': {
            sma: { periods: 20, color: '#2563eb' },      // Support/Resistance
            atr: { periods: 14, color: '#f59e0b' }       // Range
        },

        // Vortex: Volatility-based strategy
        'vortex': {
            atr: { periods: 14, color: '#f59e0b' },      // Chaos detection
            bollingerBands: { periods: 20, stdDev: 2 }   // Extremes
        },

        // Ultra Scalper: Fast momentum on synthetics
        'ultra_scalp': {
            ema: { periods: 9, color: '#059669' },       // Fast entry
            atr: { periods: 7, color: '#f59e0b' }        // Quick exits
        },

        // Cipher: Bitcoin structure
        'cipher': {
            sma: { periods: 20, color: '#2563eb' },      // Structure
            atr: { periods: 14, color: '#f59e0b' }       // Volatility
        },

        // RSI Fade: Mean reversion
        'rsi_fade': {
            ema: { periods: 21, color: '#059669' },      // Mean
            atr: { periods: 14, color: '#f59e0b' }       // Bands
        },

        // Range Boundary: Mean reversion
        'range_boundary': {
            sma: { periods: 20, color: '#2563eb' },      // Middle
            bollingerBands: { periods: 20, stdDev: 2 }   // Extremes
        },

        // H4 Kiss: EMA-based
        'h4_kiss': {
            ema: { periods: 21, color: '#059669' },      // H4 EMA
            atr: { periods: 14, color: '#f59e0b' }       // Volatility
        },

        // Default for unknown strategies
        'default': {
            sma: { periods: 20, color: '#2563eb' },      // Trend
            atr: { periods: 14, color: '#f59e0b' }       // Volatility
        },
    };

    return configs[strategy] || configs['default'];
};

/**
 * Update H4 levels when new H4 candle arrives
 * Call this in processBar() for strategies that need H4 updates
 */
function _updateChartH4Levels(botId, bot) {
    const engine = _engineFor(botId);
    if (!engine) return;
    
    // Check if H4 changed
    const currentH4 = engine.getH4Levels();
    const latestH4 = bot.h4Candles[bot.h4Candles.length - 1];
    
    if (!latestH4) return;
    
    // Redraw if H4 high/low changed (new 4-hour candle)
    if (!currentH4.high || 
        currentH4.high !== latestH4.high || 
        currentH4.low !== latestH4.low) {
        engine.drawH4Levels(bot.h4Candles);
    };
};

// ─────────────────────────────────────────────────────────────
// HANDLE DERIV API DATA
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// HANDLE DERIV API DATA - CORRECTED VERSION
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
                };
            });
        };
        return;
    };

    if (data.msg_type === 'authorize') {
        authorised = true;
        document.getElementById('connection-indicator').className = 'status-dot status-online';
        document.getElementById('conn-label').textContent = 'Online';
        log('Terminal authorized — connection established', 'info');
        api.fetchActiveSymbols();
        SessionState.set({ connected: true });
        Object.values(bots).forEach(bot => {
            window.setBotOnline(bot.id);
            if (bot.isActive) subscribeBot(bot);
        });
    };

    if (data.msg_type === 'active_symbols') {
        data.active_symbols.forEach(s => { symbolMap[s.symbol] = s.display_name; });
        log(`${data.active_symbols.length} symbols loaded`, 'info');
    };

    if (data.msg_type === 'candles') {
        const gran = data.echo_req.granularity;
        const symbol = data.echo_req.ticks_history;
        const history = data.candles.map(c => ({
            time: parseInt(c.epoch),
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        Object.values(bots).forEach(bot => {
            if (!bot.isActive) return;
            if (bot.config.symbol !== symbol) return;
            
            // Store candles for Jump75 strategy
            if (bot.config.strategy === 'jump75') {
                if (gran === 300) {
                    history.forEach(candle => {
                        bot.m5Candles.push(candle);
                        if (bot.m5Candles.length > 100) bot.m5Candles.shift();
                        bot.lastM5CloseTime = candle.time;
                    });
                };
                
                if (gran === 900) {
                    history.forEach(candle => {
                        bot.m15Candles.push(candle);
                        if (bot.m15Candles.length > 50) bot.m15Candles.shift();
                        bot.lastM15CloseTime = candle.time;
                    });
                };
                
                if (gran === 14400) {
                    history.forEach(candle => {
                        bot.h4Candles.push(candle);
                        if (bot.h4Candles.length > 30) bot.h4Candles.shift();
                        bot.lastH4CloseTime = candle.time;
                    });
                };
            };
            
            // Store original candles for all strategies
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
                            if (el) {
                                current[oid] = el.checked;
                                el.checked = saved[oid] || false;
                            };
                        });
                        _drawOverlaysOnEngine(eng, bot);
                        OVERLAY_IDS.forEach(oid => {
                            const el = document.getElementById(oid);
                            if (el) el.checked = current[oid];
                        });
                    };
                };
            };
            
            if (gran === 14400 && bot.config.symbol === symbol) {
                bot.h4Candles = history;
            };
            if (gran === bot.htfGran && bot.config.symbol === symbol) {
                bot.htfCandles = history;
                if (bot.config.strategy === 'vortex') VortexStrategy.setHtfCandles(bot.id, history);
            };
        });
    };

    if (data.msg_type === 'ohlc') {
        const gran = data.echo_req.granularity;
        const symbol = data.ohlc.symbol || data.echo_req.ticks_history;
        const bar = {
            time: parseInt(data.ohlc.open_time),
            open: parseFloat(data.ohlc.open),
            high: parseFloat(data.ohlc.high),
            low: parseFloat(data.ohlc.low),
            close: parseFloat(data.ohlc.close)
        };
        Object.values(bots).forEach(bot => {
            if (bot.isActive && bot.config.symbol === symbol) {
                processBar(bot, bar, gran);
            };
        });
    };
};

// ─────────────────────────────────────────────────────────────
// PROCESS BAR
// ─────────────────────────────────────────────────────────────
function processBar(bot, bar, gran) {
    if (gran === 14400) {
        const last = bot.h4Candles[bot.h4Candles.length - 1];
        if (last && last.time === bar.time) bot.h4Candles[bot.h4Candles.length - 1] = bar;
        else bot.h4Candles.push(bar);
        if (bot.h4Candles.length > 500) bot.h4Candles.shift();
    };
    if (gran === bot.htfGran) {
        const lastH = bot.htfCandles[bot.htfCandles.length - 1];
        if (lastH && lastH.time === bar.time) bot.htfCandles[bot.htfCandles.length - 1] = bar;
        else bot.htfCandles.push(bar);
        if (bot.htfCandles.length > 500) bot.htfCandles.shift();
        if (bot.config.strategy === 'vortex') VortexStrategy.setHtfCandles(bot.id, bot.htfCandles);
        if (bot.config.strategy === 'phantom') PhantomStrategy.setHtfCandles(bot.id, bot.htfCandles);
    };

    // Store candles for Jump75 on each timeframe
    if (bot.config.strategy === 'jump75') {
        if (gran === 300) {
            bot.m5Candles.push(bar);
            if (bot.m5Candles.length > 100) bot.m5Candles.shift();
            bot.lastM5CloseTime = bar.time;
        };
        if (gran === 900) {
            bot.m15Candles.push(bar);
            if (bot.m15Candles.length > 50) bot.m15Candles.shift();
            bot.lastM15CloseTime = bar.time;
        };
        if (gran === 14400) {
            bot.h4Candles.push(bar);
            if (bot.h4Candles.length > 30) bot.h4Candles.shift();
            bot.lastH4CloseTime = bar.time;
        };
    };

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
    };

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

    // ── DIRECT STRATEGY RUNNERS ─────────────────────────────────
    if (bot.config.strategy === 'phantom') { _runPhantom(bot, bar, atr, rsi); return; };
    if (bot.config.strategy === 'nova')    { _runNova(bot, bar, atr, rsi);    return; };
    if (bot.config.strategy === 'pulse')   { _runPulse(bot, bar, atr, rsi);   return; };
    if (bot.config.strategy === 'kismet')  { _runKismet(bot, bar, atr, rsi);  return; };
    if (bot.config.strategy === 'cipher')  { _runCipher(bot, bar, atr, rsi);  return; };
    if (bot.config.strategy === 'vortex')  { _runVortex(bot, bar, atr, rsi);  return; };
    if (bot.config.strategy === 'ultra_scalp') { _runUltraScalper(bot, bar, atr, rsi); return; };
    if (bot.config.strategy === 'jump75')  { _runJump75(bot, bar, atr, rsi);  return; };
    if (bot.config.strategy === 'range_boundary') { _runRangeBoundary(bot, bar, atr, rsi); return; };
    
    if (document.getElementById('auto-session')?.checked) {
        const forexStrategies = ['momentum','london_breakout','news_fade','swing','h4_kiss'];
        if (forexStrategies.includes(bot.config.strategy)) {
            const hour = new Date().getUTCHours();
            if (hour < 7 || hour > 20) return;
        };
    };

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
                };
            };
        };

        if (bot.config.strategy === 'range_boundary') {
            const msSinceLastSL = now - bot.lastSLTimeMs;
            const COOLDOWN_MS   = 30 * 60 * 1000;
            if (bot.lastSLTimeMs > 0 && msSinceLastSL < COOLDOWN_MS) {
                const minsLeft = Math.ceil((COOLDOWN_MS - msSinceLastSL) / 60000);
                log(`Range Boundary cooldown — ${minsLeft}m remaining after last SL`, 'neutral');
                return;
            };
        };

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
                    if (candidate.dir !== signal.type) { bot.h4KissCandidate = null; return; };
                    bot.h4KissCandidate = null;
                    log(`H4 Kiss confirmed (2-bar) @ ${bar.close.toFixed(4)}`, 'info');
                } else {
                    return;
                };
            };
        };

        if (bot.config.strategy === 'synthetic_scalp') {
            const barsSinceLastSL = bot.candles.length - bot.lastSLBarIdx;
            if (bot.lastSLBarIdx > 0 && barsSinceLastSL < 2) {
                log(`Synthetic scalp re-entry blocked — only ${barsSinceLastSL} bar(s) since last SL`, 'neutral');
                return;
            };
        };

        bot.lastFiredMs = now;
        fireSignal(bot, signal, bar, atr, rsi, isTrending);
    };
};



// ─────────────────────────────────────────────────────────────
// JUMP75 RUNNER - ADAPTIVE HYBRID + AI FILTER v2.0
// ─────────────────────────────────────────────────────────────
async function _runJump75(bot, bar, atr, rsi) {
    const symbol = bot.config.symbol;
    const jumpSymbols = ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'];
    if (!jumpSymbols.includes(symbol)) return null;

    if (!bot.m5Candles || bot.m5Candles.length < 8) return null;

    const now = Date.now();
    if ((now - bot.lastFiredMs) < 25000) return null;

    // Apply saved quality mode
    const savedMode = window._botQualityModes?.[bot.id] ?? 1;
    if (Jump75Strategy?.setMode) Jump75Strategy.setMode(savedMode);

    // Get signal from strategy
    const signal = await Jump75Strategy.checkEntry(
        bot.m5Candles,
        bot.m15Candles,
        bot.h4Candles,
        atr
    );

    if (!signal) return null;

    // === AI FILTER ===
    const isBreakout = (signal.mode === 'BREAKOUT' || signal.factors?.some(f => f.includes('Break')));
    const aiScore = await getAIWinProbability(signal, atr, rsi, isBreakout);

    if (aiScore < 52) {
        log(`🤖 AI REJECTED ${signal.mode} ${signal.type} — ${aiScore}% win prob`, 'warn');
        return null;
    }

    log(`🤖 AI APPROVED — ${aiScore}% predicted win rate | ${signal.mode}`, 'info');

    const displayType = signal.type === 'LONG' ? 'BUY' : 'SELL';
    log(`🦘 JUMP75 ${displayType} @ ${bar.close.toFixed(4)} | ${signal.mode} | AI:${aiScore}%`, 
        displayType === 'BUY' ? 'buy' : 'sell');

    bot.lastFiredMs = now;
    fireSignal(bot, signal, bar, atr, rsi, null);

    return signal;
}

// ─────────────────────────────────────────────────────────────
// RANGE BOUNDARY RUNNER
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// RANGE BOUNDARY RUNNER WITH QUALITY MODE
// ─────────────────────────────────────────────────────────────
async function _runRangeBoundary(bot, bar, atr, rsi) {
    // ✅ APPLY QUALITY MODE FROM STORAGE before checking entry
    const savedMode = window._botQualityModes ? window._botQualityModes[bot.id] : null;
    if (savedMode !== undefined && RangeBoundaryStrategy.QUALITY_MODE !== savedMode) {
        RangeBoundaryStrategy.setMode(savedMode);
        console.log(`[RangeBoundary] Bot ${bot.id} using quality mode: ${savedMode}`);
    };
    
    // Set symbol on strategy instance
    RangeBoundaryStrategy.setSymbol(bot.config.symbol);
    
    const signal = await RangeBoundaryStrategy.checkEntry(
        bot.candles,
        bot.rsiState,
        bot.h4Candles,
        atr
    );
    
    if (!signal) return;
    
    const now = Date.now();
    if (now - bot.lastFiredMs < 30000) return;
    
    const signalType = signal.type;
    const displayType = signalType === 'BUY' ? 'BUY' : 'SELL';
    
    log(`🔄 RANGE BOUNDARY ${displayType} @ ${bar.close.toFixed(4)} | Score ${signal.score}`, 
        displayType === 'BUY' ? 'buy' : 'sell');
    
    bot.lastFiredMs = now;
    fireSignal(bot, signal, bar, atr, rsi, null);
}

// ─────────────────────────────────────────────────────────────
// PHANTOM MULTI-TF CANDLE BUFFERS
// ─────────────────────────────────────────────────────────────
const _phantomBuffers = {};

function _getPhantomBuffers(botId) {
    if (!_phantomBuffers[botId]) _phantomBuffers[botId] = { m1: [], m5: [], m15: [] };
    return _phantomBuffers[botId];
};

function _buildPhantomTFBuffers(bot) {
    const buf = _getPhantomBuffers(bot.id);
    const candles = bot.candles;
    if (!candles || candles.length < 2) return buf;

    function _resample(srcCandles, periodSecs) {
        const buckets = {};
        for (const c of srcCandles) {
            const bucket = Math.floor(c.time / periodSecs) * periodSecs;
            if (!buckets[bucket]) {
                buckets[bucket] = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
            } else {
                buckets[bucket].high  = Math.max(buckets[bucket].high, c.high);
                buckets[bucket].low   = Math.min(buckets[bucket].low,  c.low);
                buckets[bucket].close = c.close;
            };
        };
        return Object.values(buckets).sort((a, b) => a.time - b.time);
    };

    buf.m1  = _resample(candles, 60);
    buf.m5  = _resample(candles, 300);
    buf.m15 = _resample(candles, 900);
    return buf;
};

function _runPhantom(bot, bar, atr, rsi) {
    const session = PhantomStrategy.getSession();
    _updatePhantomBadge(bot.id, session);

    if (session.mode === 'halted') return;

    const observerOnly = (session.mode === 'observer');

    if (bot.openSignal?.isPhantom) {
        _applyTrailingStop(bot, atr);
        const shouldExit = PhantomReversalCheck(bot.candles, bot.openSignal, rsi);
        if (shouldExit) {
            const c = bot.candles[bot.candles.length - 2];
            log(`👻 PHANTOM reversal exit @ ${c.close.toFixed(4)}`, 'neutral');
            const pnlAmt = Math.abs(c.close - bot.openSignal.entry);
            const outcome = bot.openSignal.type === 'BUY'
                ? (c.close > bot.openSignal.entry ? 'TP' : 'SL')
                : (c.close < bot.openSignal.entry ? 'TP' : 'SL');
            _phantomCloseTrade(bot, outcome, pnlAmt, c);
        };
        return;
    };

    if (bot.openSignal) return;

    const now = Date.now();
    const cooldownMs = 2 * (bot.config.tf || 300) * 1000;
    if ((now - bot.lastFiredMs) < cooldownMs) return;

    const buf    = _buildPhantomTFBuffers(bot);
    const signal = PhantomStrategy.checkEntry(buf.m1, buf.m5, buf.m15, bot.id);
    if (!signal) return;

    if (observerOnly) {
        log(`👻 PHANTOM [OBSERVER] ${signal.type} @ ${bar.close.toFixed(4)} [${signal.tfNames} ${signal.score}] — target hit, watching`, 'neutral');
        return;
    };

    bot.lastFiredMs = now;
    log(`👻 PHANTOM ${signal.type} @ ${bar.close.toFixed(4)} — ${signal.tfNames} | score ${signal.score} | ${signal.tfCount} TF${signal.tfCount > 1 ? 's' : ''}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.factors.length) log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');

    fireSignal(bot, signal, bar, atr, rsi, null);
};

// ─────────────────────────────────────────────────────────────
// NOVA RUNNER
// ─────────────────────────────────────────────────────────────
function _buildNovaTFBuffers(bot) {
    const candles = bot.candles;
    if (!candles || candles.length < 2) return { m1: [], m5: [], m15: [] };
    function _resample(src, periodSecs) {
        const buckets = {};
        for (const c of src) {
            const b = Math.floor(c.time / periodSecs) * periodSecs;
            if (!buckets[b]) buckets[b] = { time: b, open: c.open, high: c.high, low: c.low, close: c.close };
            else {
                buckets[b].high  = Math.max(buckets[b].high, c.high);
                buckets[b].low   = Math.min(buckets[b].low,  c.low);
                buckets[b].close = c.close;
            };
        };
        return Object.values(buckets).sort((a, b) => a.time - b.time);
    };
    return { m1: _resample(candles, 60), m5: _resample(candles, 300), m15: _resample(candles, 900) };
};

function _runNova(bot, bar, atr, rsi) {
    const symCfg = novaSymbolConfig(bot.config.symbol);
    if (!symCfg) {
        log(`NOVA: ${bot.config.symbol} is not a supported Crash/Boom symbol`, 'warn');
        return;
    };

    const spike = detectSpike(bot.candles, atr);
    if (spike) {
        NovaStrategy.recordSpike(bot.id, spike, bot.config.tf || 300);
        log(`💥 NOVA spike detected — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR on ${symCfg.name}`, 'neutral');
        if (bot.openSignal?.isNova) {
            const c       = bot.candles[bot.candles.length - 2];
            const adverse = (bot.openSignal.type === 'BUY'  && spike.direction === 'down')
                         || (bot.openSignal.type === 'SELL' && spike.direction === 'up');
            if (adverse) {
                log(`💥 NOVA spike exit — closing trade to avoid spike wipeout`, 'warn');
                const pnlAmt = Math.abs(c.close - bot.openSignal.entry);
                const outcome = bot.openSignal.type === 'BUY'
                    ? (c.close > bot.openSignal.entry ? 'TP' : 'SL')
                    : (c.close < bot.openSignal.entry ? 'TP' : 'SL');
                _novaCloseTrade(bot, outcome, pnlAmt, c);
                return;
            };
        };
    };

    if (bot.openSignal?.isNova) { _applyTrailingStop(bot, atr); return; };
    if (bot.openSignal) return;
    if (NovaStrategy.inCooldown(bot.id)) return;

    const now = Date.now();
    const cooldownMs = 2 * (bot.config.tf || 300) * 1000;
    if ((now - bot.lastFiredMs) < cooldownMs) return;

    const buf         = _buildNovaTFBuffers(bot);
    const spikeState  = NovaStrategy.getSpikeState(bot.id);
    const recentSpike = spikeState.spike || null;

    const signal = NovaStrategy.checkEntry(bot.config.symbol, buf.m1, buf.m5, buf.m15, recentSpike);
    if (!signal) return;

    bot.lastFiredMs = now;
    log(`💥 NOVA ${signal.type} @ ${bar.close.toFixed(4)} — ${signal.tfNames} | score ${signal.score} | ${signal.tfCount} TF${signal.tfCount > 1 ? 's' : ''}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.factors.length) log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');

    fireSignal(bot, signal, bar, atr, rsi, null);
};

function _novaCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    if (outcome === 'TP') {
        log(`💥 NOVA ✓ exit  +${pnlAmt.toFixed(4)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'nova', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
    } else {
        log(`💥 NOVA ✗ exit  -${pnlAmt.toFixed(4)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'nova', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
    };
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'nova',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    bot.openSignal = null;
};

// ─────────────────────────────────────────────────────────────
// PULSE — RUN + CLOSE
// ─────────────────────────────────────────────────────────────
function _runPulse(bot, bar, atr, rsi) {
    const cfg = pulseSymbolConfig(bot.config.symbol);
    if (!cfg) {
        log(`PULSE: ${bot.config.symbol} not supported. Use Boom 1000, Crash 1000, or Step Index.`, 'warn');
        return;
    };

    if (cfg.type === 'crash_boom') {
        const spike = detectSpike(bot.candles, atr);
        if (spike) {
            PulseStrategy.recordSpike(bot.id, spike, bot.config.tf || 60);
            log(`⚡ PULSE spike — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR`, 'neutral');
            if (bot.openSignal?.isPulse) {
                const c = bot.candles[bot.candles.length - 2];
                const adverse = (bot.openSignal.type === 'BUY'  && spike.direction === 'down')
                             || (bot.openSignal.type === 'SELL' && spike.direction === 'up');
                if (adverse) {
                    log(`⚡ PULSE spike exit`, 'warn');
                    const lotSize = bot.config.lotSize || 0.01;
                    const pnlAmt  = lotSize * _pointValue(bot.config.symbol) * Math.abs(c.close - bot.openSignal.entry);
                    _pulseCloseTrade(bot, 'SL', pnlAmt, c);
                    return;
                };
            };
        };
    };

    if (bot.openSignal?.isPulse) { _applyTrailingStop(bot, atr); return; };
    if (bot.openSignal) return;
    if (PulseStrategy.inCooldown(bot.id)) return;

    const cooldownMs = (bot.config.tf || 60) * 2 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    if (PulseStrategy.getMode() !== 'active') {
        const mode = PulseStrategy.getMode();
        if (mode === 'target_hit') log('⚡ PULSE target reached — session complete', 'buy');
        if (mode === 'halted')     log('⚡ PULSE halted — daily loss limit hit', 'warn');
        return;
    };

    const spikeState  = PulseStrategy.getSpikeState(bot.id);
    const recentSpike = spikeState.spike || null;
    const signal      = PulseStrategy.checkEntry(bot.config.symbol, bot.candles, recentSpike);
    if (!signal) return;

    bot.lastFiredMs = Date.now();
    const level = signal.compoundLevel;
    log(`⚡ PULSE ${signal.type} @ ${bar.close.toFixed(4)} | lot ${(bot.config.lotSize || 0.01).toFixed(2)} | level ${level} | ${signal.factors.join(' · ')}`, signal.type === 'BUY' ? 'buy' : 'sell');

    fireSignal(bot, signal, bar, atr, rsi, null);
};

function _pulseCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    const session  = PulseStrategy.recordTrade(bot.id, outcome, pnlAmt);
    const newStake = session.currentStake;
    const level    = session.compoundLevel;

    if (outcome === 'TP') {
        log(`⚡ PULSE ✓ +$${pnlAmt.toFixed(2)} | level ${level} | total $${session.realizedPnL.toFixed(2)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'pulse', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        log(`⚡ PULSE ✗ -$${pnlAmt.toFixed(2)} | total $${session.realizedPnL.toFixed(2)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'pulse', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    };
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'pulse',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    bot.openSignal = null;
};

// ─────────────────────────────────────────────────────────────
// VORTEX — RUN + CLOSE
// ─────────────────────────────────────────────────────────────
function _vortexBaseline(bot) {
    const candles = bot.candles;
    if (!candles || candles.length < 35) return null;
    const samples = [];
    for (let offset = 20; offset >= 1; offset--) {
        const slice = candles.slice(0, candles.length - offset);
        if (slice.length < 11) continue;
        const trs = [];
        for (let i = slice.length - 10; i < slice.length; i++) {
            const c = slice[i], p = slice[i - 1];
            if (!c || !p) continue;
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        };
        if (trs.length === 10) samples.push(trs.reduce((a, b) => a + b) / 10);
    };
    return samples.length ? samples.reduce((a, b) => a + b) / samples.length : null;
};

function _runVortex(bot, bar, atr, rsi) {
    if (!atr) return;

    const tfMins = bot.config.tf ? Math.round(bot.config.tf / 60) : 5;
    VortexStrategy.setTf(bot.id, tfMins);
    VortexStrategy.setNewsOptions(bot.id, {
        newsBlackout: Settings.get('vortexNewsBlackout') !== false,
        fomcBlackout: Settings.get('vortexFomcBlackout') === true,
    });

    const baseline = _vortexBaseline(bot);
    if (!baseline) return;

    const volRatio = atr / baseline;

    const chaos = VortexStrategy.detectChaos(bot.candles, atr, baseline);
    if (chaos) {
        VortexStrategy.recordChaos(bot.id, chaos.direction);
        log(`🌀 VORTEX chaos detected — vol×${chaos.volRatio.toFixed(1)} | waiting for retrace`, 'warn');
        if (bot.openSignal?.isVortex) {
            const adverse = (bot.openSignal.type === 'BUY'  && chaos.direction === 'down')
                         || (bot.openSignal.type === 'SELL' && chaos.direction === 'up');
            if (adverse) {
                log(`🌀 VORTEX chaos exit`, 'warn');
                const lotSize = bot.config.lotSize || 0.01;
                const c       = bot.candles[bot.candles.length - 2];
                const pnlAmt  = lotSize * _pointValue(bot.config.symbol) * Math.abs(c.close - bot.openSignal.entry);
                _vortexCloseTrade(bot, 'SL', pnlAmt, c);
                return;
            };
        };
    };

    if (bot.openSignal?.isVortex) { _applyTrailingStop(bot, atr); return; };
    if (bot.openSignal) return;
    if (VortexStrategy.isHalted(bot.id))      { log(`🌀 VORTEX halted — 5 consecutive losses`, 'warn'); return; };
    if (VortexStrategy.isTooFrequent(bot.id)) { log(`🌀 VORTEX rate limit — max 3 trades/hr`, 'neutral'); return; };

    const cooldownMs = (bot.config.tf || 60) * 2 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    const baseLot = parseFloat(bot.config.lotSize) || 0.01;
    const signal  = VortexStrategy.checkEntryFull(bot.id, bot.config.symbol, bot.candles, baseLot);
    if (!signal) return;

    bot.lastFiredMs = Date.now();
    log(`🌀 VORTEX ${signal.type} [${signal.mode}] @ ${bar.close.toFixed(4)} | vol×${signal.volRatio} | lot ${baseLot.toFixed(2)}`, signal.type === 'BUY' ? 'buy' : 'sell');
    log(`   ${signal.factors.join(' · ')}`, 'neutral');

    fireSignal(bot, signal, bar, atr, rsi, null);
};

function _vortexCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    const mode = bot.openSignal.mode || '';
    VortexStrategy.recordOutcome(bot.id, outcome, type);
    if (outcome === 'TP') {
        log(`🌀 VORTEX ✓ +$${pnlAmt.toFixed(2)} [${mode}]`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'vortex', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        log(`🌀 VORTEX ✗ -$${pnlAmt.toFixed(2)} [${mode}]`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'vortex', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    };
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'vortex',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    bot.openSignal = null;
};

// ─────────────────────────────────────────────────────────────
// KISMET RUNNER - FIXED + VOLATILITY INDICES SUPPORT
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// KISMET RUNNER - FULLY FIXED + VOLATILITY INDICES SUPPORT
// ─────────────────────────────────────────────────────────────
function _runKismet(bot, bar, atr, rsi) {
    const symbol = bot.config.symbol;

    // === 1. VOLATILITY INDICES (V10-V150, JD10-JD150) - NEW STRATEGY ===
    const isVolatilityIndex = /^(V|JD)(10|25|50|75|100|150)/.test(symbol);

    if (isVolatilityIndex) {
        if (typeof KismetVolatilityIndices?.checkEntry !== 'function') {
            log(`[KISMET VOL] Strategy not loaded`, 'warn');
            return;
        }

        const signal = KismetVolatilityIndices.checkEntry(symbol, bot.candles, atr, bot.id);

        if (!signal) return;

        // Check halt status
        if (typeof KismetVolatilityIndices.isHalted === 'function' && 
            KismetVolatilityIndices.isHalted(bot.id)) {
            log(`🎯 KISMET VOL — Halted (6 consecutive losses)`, 'warn');
            return;
        }

        bot.lastFiredMs = Date.now();
        log(`🎯 KISMET VOL ${signal.type} @ ${bar.close.toFixed(4)} | ${signal.mode} | Score ${signal.score}`, 
            signal.type === 'BUY' ? 'buy' : 'sell');

        fireSignal(bot, signal, bar, atr, rsi, null);
        return;
    }

    // === 2. LEGACY KISMET (Crash 1000, Boom 1000, Step Index, etc.) ===
    const cfg = kismetSymbolConfig ? kismetSymbolConfig(symbol) : null;
    
    if (!cfg) {
        log(`🎯 KISMET: ${symbol} not supported in legacy mode`, 'warn');
        return;
    }

    const spike = KismetStrategy?.detectSpike?.(bot.candles, atr);
    if (spike) {
        KismetStrategy.recordSpike?.(bot.id, spike, bot.config.tf || 60);
        log(`🎯 KISMET spike — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR`, 'neutral');
        
        if (bot.openSignal?.isKismet) {
            if (KismetStrategy.checkAdverseSpike?.(bot.openSignal, spike)) {
                log(`🎯 KISMET adverse spike — emergency exit`, 'warn');
                const lotSize = bot.config.lotSize || 0.01;
                const c = bot.candles[bot.candles.length - 2];
                const pnlAmt = lotSize * _pointValue(bot.config.symbol) * Math.abs(c.close - bot.openSignal.entry);
                _kismetCloseTrade(bot, 'SL', pnlAmt, c);
                return;
            }
        }
    }

    if (bot.openSignal?.isKismet) { 
        _applyTrailingStop(bot, atr); 
        return; 
    }
    if (bot.openSignal) return;

    if (KismetStrategy?.isHalted?.(bot.id)) {
        log(`🎯 KISMET halted — 6 consecutive losses reached`, 'warn');
        return;
    }

    const cooldownMs = (bot.config.tf || 300) * 3 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    const signal = KismetStrategy?.checkEntry?.(symbol, bot.candles, atr, bot.id);
    if (!signal) return;

    if (signal.mode === 'drift_reentry' && signal.score < 70) return;

    bot.lastFiredMs = Date.now();
    log(`🎯 KISMET ${signal.type} [${signal.mode}] @ ${bar.close.toFixed(4)} | score ${signal.score}`, 
        signal.type === 'BUY' ? 'buy' : 'sell');

    fireSignal(bot, signal, bar, atr, rsi, null);
}

// ─────────────────────────────────────────────────────────────
// CIPHER RUNNER
// ─────────────────────────────────────────────────────────────
function _runCipher(bot, bar, atr, rsi) {
    if (!isCipherSymbol(bot.config.symbol)) {
        log(`⚡ CIPHER: ${bot.config.symbol} not supported. Use cryBTCUSD or BTCUSD.`, 'warn');
        return;
    };
 
    if (bot.openSignal?.isCipher) {
        _applyTrailingStop(bot, atr);
        return;
    };
    if (bot.openSignal) return;
 
    if (CipherStrategy.isHalted(bot.id)) {
        log(`⚡ CIPHER halted — 5 consecutive losses`, 'warn');
        return;
    };
 
    const signal = CipherStrategy.checkEntry(bot.candles, bot.h4Candles, atr, bot.id);
    if (!signal) return;
 
    CipherStrategy.recordTrade(bot.id);
    log(`⚡ CIPHER ${signal.type} @ ${bar.close.toFixed(2)} | score ${signal.score} | ${signal.factors.join(' · ')}`, signal.type === 'BUY' ? 'buy' : 'sell');
 
    fireSignal(bot, signal, bar, atr, rsi, null);
};

// ─────────────────────────────────────────────────────────────
// ULTRA SCALPER RUNNER
// ─────────────────────────────────────────────────────────────
function _runUltraScalper(bot, bar, atr, rsi) {
    // Apply trailing stop if in trade
    if (bot.openSignal?.isUltraScalper) {
        const pnl = bot.openSignal.entry ? 
            (bot.openSignal.type === 'BUY' ? bar.close - bot.openSignal.entry : bot.openSignal.entry - bar.close) : 0;
        const newSL = UltraScalper.applyTrailingStop(bot.openSignal, bar.close, atr, pnl);
        if (newSL) {
            bot.openSignal.sl = newSL;
            const eng = _engineFor(bot.id);
            if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
        };
        return;
    };
    
    if (bot.openSignal) return;
    
    const signal = UltraScalper.checkEntry(bot.candles, atr, bot.config.symbol);
    if (!signal) return;
    
    bot.lastFiredMs = Date.now();
    log(`⚡ ULTRA SCALPER ${signal.type} @ ${bar.close.toFixed(4)} | Score: ${signal.score} | ${signal.factors.join(' · ')}`, signal.type === 'BUY' ? 'buy' : 'sell');
    
    fireSignal(bot, signal, bar, atr, rsi, null);
};

// ─────────────────────────────────────────────────────────────
// CLOSE TRADE FUNCTIONS
// ─────────────────────────────────────────────────────────────
function _cipherCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    CipherStrategy.recordOutcome(bot.id, outcome);
 
    if (outcome === 'TP') {
        log(`⚡ CIPHER ✓ +$${pnlAmt.toFixed(2)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'cipher', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        log(`⚡ CIPHER ✗ -$${pnlAmt.toFixed(2)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'cipher', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    };
 
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'cipher',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
 
    bot.openSignal = null;
};

function _ultraScalperCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    
    // Pass detailed info to UltraScalper for logging
    UltraScalper.recordOutcome(bot.config.symbol, outcome, pnlAmt, entry, sl, tp, bar.close);
    UltraScalper.removeTrade(bot.config.symbol);
    
    if (outcome === 'TP') {
        log(`⚡ ULTRA SCALPER ✓ +$${pnlAmt.toFixed(2)} | ${type} on ${bot.config.symbol} | Entry: ${entry.toFixed(4)} → Exit: ${bar.close.toFixed(4)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'ultra_scalp', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        const lossAmount = Math.abs(pnlAmt);
        const pointsLost = Math.abs(entry - bar.close);
        log(`⚡ ULTRA SCALPER ✗ -$${lossAmount.toFixed(2)} | ${type} on ${bot.config.symbol} | Entry: ${entry.toFixed(4)} → SL hit: ${bar.close.toFixed(4)} | Lost ${pointsLost.toFixed(4)} points`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'ultra_scalp', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    };
    
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'ultra_scalp',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    
    bot.openSignal = null;
};

function _kismetCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    KismetStrategy.recordOutcome(bot.id, outcome);
    if (outcome === 'TP') {
        log(`🎯 KISMET ✓ +$${pnlAmt.toFixed(2)} [${bot.openSignal.mode || ''}]`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'kismet', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        log(`🎯 KISMET ✗ -$${pnlAmt.toFixed(2)} [${bot.openSignal.mode || ''}]`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'kismet', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    };
    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'kismet',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    bot.openSignal = null;
};

function _phantomCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    if (outcome === 'TP') {
        log(`👻 PHANTOM ✓ exit  +${pnlAmt.toFixed(4)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'phantom', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
    } else {
        log(`👻 PHANTOM ✗ exit  -${pnlAmt.toFixed(4)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'phantom', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
    };

    const lotSize        = bot.config.phantomLot || bot.config.lotSize || 0.01;
    const updatedSession = PhantomStrategy.recordTrade(bot.id, outcome, pnlAmt * lotSize);
    PhantomStrategy.recordOutcome(bot.id, type, outcome);
    _updatePhantomBadge(bot.id, updatedSession);

    if (updatedSession.mode === 'observer') {
        log(`👻 PHANTOM — Daily target $${updatedSession.profitTarget} reached! Switching to Observer Mode 👁`, 'buy');
    } else if (updatedSession.mode === 'halted') {
        log(`👻 PHANTOM — Loss limit -$${updatedSession.lossLimit} hit. Session halted. 🛑`, 'sell');
    };

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'phantom',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });
    bot.openSignal = null;
};

function _updatePhantomBadge(botId, session) {
    const card = document.querySelector(`.bot-card[data-bot-id="${botId}"]`);
    if (!card) return;
    const badge = card.querySelector('.phantom-session-badge');
    if (!badge) return;

    if (!session.configured) { badge.style.display = 'none'; return; };
    badge.style.display = 'block';

    const pnl    = session.realizedPnL;
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    const pnlCol = pnl >= 0 ? '#34d399' : '#f87171';

    let modeHtml = '';
    if (session.mode === 'observer') modeHtml = ' &nbsp;<span style="color:#a78bfa;">👁 OBSERVING</span>';
    if (session.mode === 'halted')   modeHtml = ' &nbsp;<span style="color:#f87171;">🛑 HALTED</span>';

    badge.innerHTML =
        `<span style="color:${pnlCol};font-weight:700;">${pnlStr}</span>` +
        `<span style="color:var(--text-muted);margin:0 5px;">·</span>` +
        `<span style="color:var(--text-muted);">${session.wins}W / ${session.losses}L</span>` +
        (session.profitTarget > 0
            ? `<span style="color:var(--text-muted);margin:0 5px;">·</span><span style="color:rgba(167,139,250,0.7);">Target $${session.profitTarget}</span>`
            : '') +
        modeHtml;
};

// ─────────────────────────────────────────────────────────────
// FIRE SIGNAL WITH POSITION SIZING
// ─────────────────────────────────────────────────────────────
async function fireSignal(bot, signal, bar, atr, rsi, isTrending) {
    // ✅ FIX 1: Properly extract type with fallbacks
    let type = signal?.type || signal?.direction;
    
    // Convert LONG/SHORT to BUY/SELL for display and trading
    if (type === 'LONG') type = 'BUY';
    if (type === 'SHORT') type = 'SELL';
    
    // Final fallback - if still no type, try to infer or default
    if (!type || type === 'BUY/SELL') {
        console.warn('[fireSignal] Unknown signal type:', signal);
        type = 'BUY'; // Default fallback
    };
    
    const label = signal.label || type;

    let confidence;
    if (signal.isPhantom || signal.isNova || signal.isPulse || signal.isKismet || signal.isVortex || signal.isUltraScalper || signal.isJump75) {
        confidence = {
            score:   signal.score || 50,
            grade:   signal.score >= 70 ? 'A' : signal.score >= 55 ? 'B' : 'C',
            color:   signal.score >= 70 ? '#34d399' : signal.score >= 55 ? '#fbbf24' : '#a78bfa',
            factors: signal.factors || [],
        };
        log(`SIGNAL ${type} @ ${bar.close.toFixed(4)} — ${label}`, type === 'BUY' ? 'buy' : 'sell');
        if (signal.factors?.length) log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');
    } else {
        confidence = ConfidenceEngine.score({
            type,
            candles:      bot.candles,
            h4Candles:    bot.h4Candles,
            rsi,
            atr,
            overlayState: overlayState[bot.id] || {},
        });
        const confLabel = `${label} [${confidence.grade}${confidence.score}]`;
        log(`SIGNAL ${type} @ ${bar.close.toFixed(4)} — ${confLabel}`, type === 'BUY' ? 'buy' : 'sell');
        if (confidence.factors.length) log(`Confluence: ${confidence.factors.slice(0, 3).join(' · ')}`, 'neutral');
    };

    window.registerBotSignal(bot.id, type, bar.close.toFixed(4), label, confidence);

    const liveConf = SessionState.get().liveConfidence || {};
    liveConf[bot.id] = {
        botId:    bot.id,
        symbol:   bot.config.symbol,
        strategy: bot.config.strategy,
        type,
        score:    confidence.score,
        grade:    confidence.grade,
        color:    confidence.color,
        factors:  confidence.factors,
        time:     Date.now(),
        price:    bar.close,
    };
    SessionState.set({ liveConfidence: liveConf });

    if (!atr) return;

    // ✅ FIX 2: Calculate slDist and tpDist BEFORE using slMult in position sizing
    let slDist, tpDist;
    let slMult = 1.0;  // Define defaults
    let tpMult = 1.5;  // Define defaults

    // If the signal provides explicit distances, use them
    if (signal._slDist && signal._tpDist) {
        slDist = signal._slDist;
        tpDist = signal._tpDist;
        slMult = slDist / atr;
        tpMult = tpDist / atr;
    } else {
        tpMult = signal.tpMultiplier || 1.5;
        slMult = signal.slMultiplier || 1.0;
        slDist = atr * slMult;
        tpDist = atr * tpMult;
    };

    const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
    const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

    console.log(`[FireSignal] ${type} | Entry: ${bar.close.toFixed(2)} | SL: ${sl.toFixed(2)} (${slDist.toFixed(2)} away) | TP: ${tp.toFixed(2)} (${tpDist.toFixed(2)} away)`);

    // ── POSITION SIZING CALCULATION ──────────────────────────────
    let riskPercent = 0.75;
    if (signal.isPhantom) riskPercent = 0.5;
    if (signal.isNova) riskPercent = 0.65;
    if (signal.isCipher) riskPercent = 0.7;
    if (signal.isUltraScalper) riskPercent = 0.5;
    if (signal.isJump75) riskPercent = 0.6;
    
    const accountEquity = bot.accountEquity || SessionState.get().accountEquity || 10000;
    
    // FORCE RESET position sizing to clear any stale loss streak
    try {
        PositionSizing.resetSession(accountEquity);
        PositionSizing.reset();
    } catch(e) {
        log(`Position sizing reset failed: ${e.message}`, 'warn');
    };
    
    let lotSize = 0.01; // Default fallback
    
    try {
        const sizing = PositionSizing.calculateLotSize({
            symbol: bot.config.symbol,
            accountEquity: accountEquity,
            atr: atr,
            slMultiplier: slMult,  // ✅ Now slMult is defined!
            riskPercent: riskPercent,
            useStreakScaling: false
        });
        
        if (sizing.allowed && sizing.lotSize > 0) {
            lotSize = Math.max(0.01, sizing.lotSize);
            log(`📊 Position sizing: ${lotSize.toFixed(2)} lots | Risk: $${sizing.riskAmount.toFixed(2)} (${sizing.riskPercent}%)`, 'info');
        } else {
            log(`Position sizing not available (${sizing.reason || 'unknown'}) - using fixed 0.01 lot`, 'warn');
            lotSize = 0.01;
        };
    } catch(e) {
        log(`Position sizing error: ${e.message} - using fixed 0.01 lot`, 'warn');
        lotSize = 0.01;
    };
    
    // Final safety clamp
    lotSize = Math.min(0.1, Math.max(0.01, lotSize));

    bot.openSignal = { type, sl, tp, entry: bar.close, lotSize: lotSize, strategy: bot.config.strategy };
    if (signal.isJump75) {
        bot.openSignal.isJump75 = true;
        bot.openSignal.factors = signal.factors || [];
    };
    bot.lastConfidence = confidence;

    const sigEngine = _engineFor(bot.id);
    if (sigEngine) {
        sigEngine.addMarker(bar.time, type, label);
        sigEngine.drawTradeLevels(sl, tp);
    };

    // Auto-log training data
    if (document.getElementById('auto-log')?.checked) {
        try {
            const ema8  = MomentumStrategy._ema(bot.candles.slice(0, -1), 8);
            const ema21 = MomentumStrategy._ema(bot.candles.slice(0, -1), 21);
            const isVol = MomentumStrategy._isVolatileEnough(bot.candles, atr);
            const c1    = bot.candles[bot.candles.length - 4];
            const c2    = bot.candles[bot.candles.length - 3];
            const c3    = bot.candles[bot.candles.length - 2];
            if (c1 && c2 && c3) {
                const { bullEngulf, bearEngulf } = MomentumStrategy._isEngulfing(c2, c3);
                const { allBull, allBear }       = MomentumStrategy._isThreeConsecutive(c1, c2, c3);
                const bigBull = c3.close > c3.open && MomentumStrategy._isBigBody(c3, atr);
                const bigBear = c3.close < c3.open && MomentumStrategy._isBigBody(c3, atr);
                const bScore  = (bullEngulf?1:0) + (allBull?1:0) + (bigBull?1:0);
                const seScore = (bearEngulf?1:0) + (allBear?1:0) + (bigBear?1:0);
                DataLogger.logSignal(type, bar, atr, rsi, ema8, ema21,
                    isTrending, isVol, bScore, seScore, bot.config.symbol, bot.config.tf);
            };
        } catch(e) {};
    };

       // MT5 Push — Send to LOCAL BRIDGE (bridge.cjs)
    if (document.getElementById('auto-mt5')?.checked) {
        const derivDisplay = symbolMap[bot.config.symbol] || SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
        const mt5Symbol = MT5_SYMBOL_MAP[bot.config.symbol] 
                       || MT5_SYMBOL_MAP[derivDisplay] 
                       || derivDisplay;

        const clampedLot = Math.max(0.01, parseFloat((Math.round(lotSize / 0.01) * 0.01).toFixed(2)));

        const signalMsg = {
            action: type.toLowerCase(),
            symbol: mt5Symbol,
            price: parseFloat(bar.close.toFixed(5)),
            sl: parseFloat(sl.toFixed(5)),
            tp: parseFloat(tp.toFixed(5)),
            lotSize: clampedLot,
            label: label || type,
            timestamp: Date.now()
        };

        if (!renderWS || renderWS.readyState !== WebSocket.OPEN) {
            console.warn(`[MT5] Local bridge not ready (state: ${renderWS ? renderWS.readyState : 'undefined'})`);
            pendingSignals.push(signalMsg);
            connectRenderWebSocket();
            log(`MT5 signal QUEUED for ${mt5Symbol}`, 'warn');
        } else {
            try {
                renderWS.send(JSON.stringify(signalMsg));
                console.log(`[MT5] Sent to local bridge → ${type} ${mt5Symbol} | lot ${clampedLot}`);
                log(`→ MT5 (Bridge): ${type} ${mt5Symbol} | lot ${clampedLot}`, 'info');
            } catch (e) {
                console.error('[MT5] Send to bridge failed:', e);
                pendingSignals.push(signalMsg);
            }
        }
    }
};

// ─────────────────────────────────────────────────────────────
// SHARED TRAILING STOP
// ─────────────────────────────────────────────────────────────
function _applyTrailingStop(bot, atr) {
    const sig = bot.openSignal;
    if (!sig || !atr) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed) return;

    const { type, entry, tp } = sig;
    const tpDist   = Math.abs(tp - entry);
    const halfway  = tpDist * 0.5;
    const price    = closed.close;
    const inProfit = type === 'BUY' ? price - entry : entry - price;

    if (inProfit < halfway) return;

    if (!sig.trailActivated) {
        sig.trailActivated = true;
        sig.trailSL = entry;
        sig.sl      = entry;
        log(`📈 Trail activated — SL → breakeven @ ${entry.toFixed(4)}`, 'neutral');
        const eng = _engineFor(bot.id);
        if (eng) eng.drawTradeLevels(sig.sl, sig.tp);
        _pushMT5Modify(bot, sig.sl, sig.tp);
        return;
    }

    const candidate = type === 'BUY' ? price - atr : price + atr;
    let moved = false;
    if (type === 'BUY' && candidate > sig.trailSL) { 
        sig.trailSL = candidate; 
        sig.sl = candidate; 
        moved = true; 
    } else if (type === 'SELL' && candidate < sig.trailSL) { 
        sig.trailSL = candidate; 
        sig.sl = candidate; 
        moved = true; 
    }

    if (moved) {
        const eng = _engineFor(bot.id);
        if (eng) eng.drawTradeLevels(sig.sl, sig.tp);
        _pushMT5Modify(bot, sig.sl, sig.tp);
    }
}

async function _pushMT5Modify(bot, newSL, tp) {
    if (!Settings.get('mt5Enabled')) return;
    const mt5Symbol = bot.config.mt5Symbol || bot.config.symbol;
    try {
        await fetch('/api/signal', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action:    'modify',
                symbol:    mt5Symbol,
                sl:        parseFloat(newSL.toFixed(5)),
                tp:        parseFloat(tp.toFixed(5)),
                magic:     987654,
                timestamp: Date.now(),
            })
        });
        log(`→ MT5 modify: SL → ${newSL.toFixed(4)}`, 'neutral');
    } catch(e) {
        log('MT5 modify push failed', 'warn');
    };
};

// ─────────────────────────────────────────────────────────────
// CHECK OUTCOME
// ─────────────────────────────────────────────────────────────
function checkOutcome(bot) {
    if (!bot.openSignal) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
    bot.openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry, lotSize: signalLotSize } = bot.openSignal;
    let hit = null;

    if (type === 'BUY') {
        if (closed.low  <= sl) hit = 'SL';
        else if (closed.high >= tp) hit = 'TP';
    } else {
        if (closed.high >= sl) hit = 'SL';
        else if (closed.low  <= tp) hit = 'TP';
    };

    if (!hit) return;

    // ── JUMP75 EXIT HANDLING ─────────────────────────────────────
    if (bot.openSignal.isJump75) {
        const latestM5 = bot.m5Candles[bot.m5Candles.length - 1];
        if (latestM5) {
            const closeSignal = Jump75Strategy.checkClose(latestM5, bot.openSignal);
            if (closeSignal) {
                if (closeSignal.action === 'CLOSE') {
                    const lotSizeUsed = signalLotSize || bot.config.lotSize || 0.01;
                    const pv = _pointValue(bot.config.symbol);
                    const priceDist = Math.abs(latestM5.close - entry);
                    const pnlAmt = lotSizeUsed * pv * priceDist;
                    
                    log(`🦘 JUMP75 ${closeSignal.reason} — closing trade @ ${latestM5.close.toFixed(4)}`, closeSignal.reason === 'TP' ? 'buy' : 'sell');
                    
                    if (closeSignal.reason === 'TP') {
                        window.registerBotWin(bot.id, pnlAmt);
                        UIManager.registerWin(pnlAmt);
                        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
                        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'jump75', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
                        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
                    } else {
                        window.registerBotLoss(bot.id, pnlAmt);
                        UIManager.registerLoss(pnlAmt);
                        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
                        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'jump75', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
                        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
                    };
                    
                    SessionState.pushTrade({
                        time: Date.now(), symbol: bot.config.symbol, strategy: 'jump75',
                        type, entry, sl, tp, outcome: closeSignal.reason, pnl: pnlAmt,
                        confidence: bot.lastConfidence || null,
                    });
                    
                    bot.openSignal = null;
                    const outcomeEngine = _engineFor(bot.id);
                    if (outcomeEngine) {
                        outcomeEngine.clearMarkers();
                        outcomeEngine.clearPriceLines();
                    };
                    return;
                } else if (closeSignal.action === 'UPDATE_SL') {
                    bot.openSignal.sl = closeSignal.newSL;
                    log(`🦘 JUMP75 updating SL to ${closeSignal.newSL.toFixed(4)}`, 'neutral');
                    const eng = _engineFor(bot.id);
                    if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
                    _pushMT5Modify(bot, bot.openSignal.sl, bot.openSignal.tp);
                    return;
                };
            };
        };
    };

    // ── PHANTOM SCALE-OUT ─────────────────────────────────────
    if (bot.openSignal.isPhantom && hit === 'TP' && !bot.openSignal.scaleOutDone) {
        const lotSize   = signalLotSize || bot.config.phantomLot || bot.config.lotSize || 0.01;
        const pv        = _pointValue(bot.config.symbol);
        const halfPnl   = lotSize * pv * Math.abs(tp - entry) * 0.5;
        bot.openSignal.scaleOutDone = true;
        bot.openSignal.sl = entry;
        const atr = Indicators.calculateATR(bot.candles) || Math.abs(tp - entry);
        bot.openSignal.tp = type === 'BUY' ? entry + atr * 2.5 : entry - atr * 2.5;

        log(`👻 PHANTOM scale-out — 50% closed +${halfPnl.toFixed(4)} | SL → breakeven, trailing remainder`, 'buy');
        window.registerBotWin(bot.id, halfPnl);
        UIManager.registerWin(halfPnl);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'phantom', type, entry, sl, tp, outcome: 'TP', pnl: halfPnl });
        PhantomStrategy.recordTrade(bot.id, 'TP', halfPnl);
        _updatePhantomBadge(bot.id, PhantomStrategy.getSession());

        const eng = _engineFor(bot.id);
        if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
        return;
    };

    // ── PnL calculation using signal lotSize ───────────────────
    const lotSizeUsed = signalLotSize || bot.config.lotSize || bot.config.phantomLot || 0.01;
    const pv          = _pointValue(bot.config.symbol);
    const slPriceDist = Math.abs(entry - sl);
    const tpPriceDist = Math.abs(tp - entry);
    const pnlAmt      = hit === 'TP'
        ? lotSizeUsed * pv * tpPriceDist
        : lotSizeUsed * pv * slPriceDist;

    // Update Position Sizing with outcome
    const newEquity = (SessionState.get().sessionPnL || 0) + (hit === 'TP' ? pnlAmt : -pnlAmt);
    PositionSizing.updateAfterTrade(hit, hit === 'TP' ? pnlAmt : -pnlAmt, newEquity + 10000);

    if (bot.openSignal.isPhantom) { _phantomCloseTrade(bot, hit, pnlAmt, closed); return; };
    if (bot.openSignal.isNova)    { _novaCloseTrade(bot, hit, pnlAmt, closed);    return; };
    if (bot.openSignal.isPulse)   { _pulseCloseTrade(bot, hit, pnlAmt, closed);   return; };
    if (bot.openSignal.isKismet)  { _kismetCloseTrade(bot, hit, pnlAmt, closed);  return; };
    if (bot.openSignal.isVortex)  { _vortexCloseTrade(bot, hit, pnlAmt, closed);  return; };
    if (bot.openSignal.isCipher)  { _cipherCloseTrade(bot, hit, pnlAmt, closed);  return; };
    if (bot.openSignal.isUltraScalper) { _ultraScalperCloseTrade(bot, hit, pnlAmt, closed); return; };

    if (hit === 'TP') {
        log(`✓ TP hit  +${pnlAmt.toFixed(4)}`, 'buy');
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        DataLogger.logOutcome('TP', entry, sl, tp, closed.time);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: bot.config.strategy, type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
    } else {
        log(`✗ SL hit  -${pnlAmt.toFixed(4)}`, 'sell');
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        DataLogger.logOutcome('SL', entry, sl, tp, closed.time);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: bot.config.strategy, type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        bot.strategy.registerLoss(bot.config.strategy);
    };

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: bot.config.strategy,
        type, entry, sl, tp, outcome: hit, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
        overlays: Object.keys(overlayState[bot.id] || {}).filter(k => overlayState[bot.id][k]),
    });

    const state   = SessionState.get();
    const wins    = state.wins   + (hit === 'TP' ? 1 : 0);
    const losses  = state.losses + (hit === 'SL' ? 1 : 0);
    const pnl     = state.sessionPnL + (hit === 'TP' ? pnlAmt : -pnlAmt);
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
    SessionState.set({ wins, losses, sessionPnL: pnl, winRate, accountEquity: newEquity + 10000 });

    if (!Auth.isGuest()) {
        Auth.syncTrades(SessionState.get().trades).catch(() => {});
    };

    const outcomeEngine = _engineFor(bot.id);
    if (outcomeEngine) {
        outcomeEngine.clearMarkers();
        outcomeEngine.clearPriceLines();
    };

    bot.openSignal = null;

    if (hit === 'SL') {
        bot.lastSLTimeMs = Date.now();
        bot.lastSLBarIdx = bot.candles.length;
    };

    // ── LOSS PROTECTION (UPDATED: excludes ultra_scalp and jump75) ────────
    if (hit === 'SL' && Settings.get('lossProtection') && 
        bot.config.strategy !== 'phantom' && 
        bot.config.strategy !== 'nova' && 
        bot.config.strategy !== 'pulse' && 
        bot.config.strategy !== 'kismet' && 
        bot.config.strategy !== 'vortex' && 
        currentPnL <= -maxDailyLoss) {
        log(`Daily loss limit $${maxDailyLoss} hit — stopping all bots.`, 'warn');
        _showRiskAlert(`Daily loss limit of $${maxDailyLoss} reached. All bots stopped.`);
        Object.keys(bots).forEach(bid => window.stopBot(bid));
    };
};

// ─────────────────────────────────────────────────────────────
// STRATEGY STATUS POLLING
// ─────────────────────────────────────────────────────────────

// ============================================================
// STRATEGY STATUS POLLING - DEBUGGING FIXED VERSION
// ============================================================
// FIX #3: Strategy Status Polling - Debug & Fix
// Problem: Status only shows heartbeat, never detects signals
// Solution: Enhanced logging, better error handling, proper initialization

let pollInterval = null;
let consecutiveErrors = 0;
let isPolling = false;
let pollCount = 0;

async function _pollStrategyStatus() {
    if (isPolling) return;
    isPolling = true;
    pollCount++;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        // ✅ FIX: Remove 'pragma' header - it's not allowed by CORS
        const response = await fetch('https://nexus-api-khvt.onrender.com/api/strategy-status', {
            signal: controller.signal,
            headers: { 
                'Accept': 'application/json'
                // Removed: 'Cache-Control': 'no-cache'
                // Removed: 'Pragma': 'no-cache'  ← This was causing CORS error
            },
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.warn(`[Status] HTTP ${response.status}`);
            throw new Error(`HTTP ${response.status}`);
        };
        
        const status = await response.json();
        consecutiveErrors = 0;
        
        // Log all status updates to console for debugging
        console.log(`[Poll #${pollCount}] Status:`, status.status || status.currentState || 'IDLE', {
            h4Breaks: status.h4Breaks || status.h4BreaksDetected || 0,
            retests: status.retests || status.retestCount || 0,
            entries: status.entries || status.entriesFired || 0
        });
        
        _updateStatusUI(status);
        
    } catch(e) {
        consecutiveErrors++;
        console.warn(`[Status] Poll #${pollCount} failed:`, e.message, `(${consecutiveErrors} consecutive)`);
        
        // Update UI to show connection status
        const statusEl = document.getElementById('strategy-status');
        const lastEventEl = document.getElementById('last-event-text');
        
        if (consecutiveErrors <= 2) {
            // First couple failures are normal (server cold start)
            if (statusEl && consecutiveErrors === 1) {
                statusEl.textContent = 'CONNECTING...';
                statusEl.style.color = '#f59e0b';
            };
            if (lastEventEl && consecutiveErrors === 1) {
                lastEventEl.textContent = 'Connecting to server...';
                lastEventEl.style.color = '#f59e0b';
            };
        } else if (consecutiveErrors > 3) {
            // After 3 failures, show offline
            if (statusEl) {
                statusEl.textContent = 'OFFLINE';
                statusEl.style.color = '#ef4444';
            };
            
            if (lastEventEl) {
                lastEventEl.textContent = `Server offline (${consecutiveErrors} fails) - retrying...`;
                lastEventEl.style.color = '#ef4444';
            };
        };
        
    } finally {
        isPolling = false;
    };
};

function _updateStatusUI(status) {
    if (!status) {
        console.warn('[Status] No status data received');
        return;
    };
    
    // Get DOM elements
    const statusEl = document.getElementById('strategy-status');
    const breaksEl = document.getElementById('stat-breaks');
    const retestsEl = document.getElementById('stat-retests');
    const entriesEl = document.getElementById('stat-entries');
    const timeEl = document.getElementById('status-time');
    const lastEventEl = document.getElementById('last-event-text');
    
    // Safely get status text with fallbacks
    const statusText = status.status || status.currentState || 'IDLE';
    
    // Update main status
    if (statusEl) {
        statusEl.textContent = statusText;
        
        // Color coding based on status
        if (statusText.includes('ENTRY') || statusText === 'ENTRY_SIGNAL_FIRED') {
            statusEl.style.color = '#10b981';
            statusEl.style.textShadow = '0 0 5px rgba(16,185,129,0.3)';
        } else if (statusText.includes('BREAK') || statusText === 'H4_BREAK_DETECTED') {
            statusEl.style.color = '#f59e0b';
            statusEl.style.textShadow = '0 0 5px rgba(245,158,11,0.3)';
        } else if (statusText.includes('CONFIRMATION') || statusText === 'CONFIRMATION_CANDLE') {
            statusEl.style.color = '#8b5cf6';
            statusEl.style.textShadow = '0 0 5px rgba(139,92,246,0.3)';
        } else if (statusText.includes('ACTIVE') || statusText === 'ACTIVE_SETUP') {
            statusEl.style.color = '#ec4899';
            statusEl.style.textShadow = '0 0 5px rgba(236,72,153,0.3)';
        } else if (statusText === 'OFFLINE') {
            statusEl.style.color = '#ef4444';
            statusEl.style.textShadow = 'none';
        } else {
            statusEl.style.color = 'var(--text-primary)';
            statusEl.style.textShadow = 'none';
        };
    };
    
    // Update stats counters with fallback property names
    if (breaksEl) {
        const breakCount = status.h4Breaks || status.h4BreaksDetected || 0;
        breaksEl.textContent = breakCount;
        if (breakCount > 0) breaksEl.style.color = '#f59e0b';
        else breaksEl.style.color = '';
    };
    
    if (retestsEl) {
        const retestCount = status.retests || status.retestsDetected || status.retestCount || 0;
        retestsEl.textContent = retestCount;
        if (retestCount > 0) retestsEl.style.color = '#8b5cf6';
        else retestsEl.style.color = '';
    };
    
    if (entriesEl) {
        const entryCount = status.entries || status.entriesFired || 0;
        entriesEl.textContent = entryCount;
        if (entryCount > 0) entriesEl.style.color = '#10b981';
        else entriesEl.style.color = '';
    };
    
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
    
    // Update active setup display
    const setupDiv = document.getElementById('active-setup');
    if (setupDiv) {
        const isActiveSetup = (statusText === 'ACTIVE_SETUP' || status.currentState === 'ACTIVE_SETUP');
        const hasBreakLevel = (status.lastBreakLevel || status.breakLevel);
        
        if (isActiveSetup && hasBreakLevel) {
            setupDiv.style.display = 'block';
            const setupDetails = document.getElementById('signal-details');
            if (setupDetails) {
                const level = status.lastBreakLevel || status.breakLevel || '?';
                const dir = status.lastBreakDirection || status.direction || '?';
                const age = (status.setupAge || 0).toFixed(1);
                const retests = status.retestCount || 0;
                const maxRetests = status.maxRetests || 3;
                
                setupDetails.innerHTML = `
                    ${dir} @ ${parseFloat(level).toFixed(4)} | ${retests}/${maxRetests} retests | ${age}h old
                `;
                
                console.log('[UI] Setup display updated:', { dir, level, retests, age });
            };
            
            const setupTimer = document.getElementById('setup-timer');
            if (setupTimer) {
                const age = (status.setupAge || 0);
                setupTimer.textContent = `${age.toFixed(1)}h`;
                setupTimer.style.color = age > 1.5 ? '#ef4444' : '#f59e0b';
            };
        } else {
            setupDiv.style.display = 'none';
        };
    };
    
    // Update last signal display
    const signalDiv = document.getElementById('last-signal');
    if (signalDiv) {
        const isEntrySignal = (statusText === 'ENTRY_SIGNAL_FIRED');
        const hasDirection = (status.direction || status.type);
        
        if (isEntrySignal && hasDirection) {
            signalDiv.style.display = 'block';
            const signalDetails = document.getElementById('signal-details');
            if (signalDetails) {
                const dir = status.direction || status.type || '?';
                const price = status.entryPrice || '?';
                const rr = status.rr || '?';
                const sl = status.sl || '?';
                const tp = status.tp || '?';
                
                signalDetails.innerHTML = 
                    `${dir} @ ${parseFloat(price).toFixed(4)} | ` +
                    `R:R ${parseFloat(rr).toFixed(2)}:1 | ` +
                    `SL: ${parseFloat(sl).toFixed(4)} TP: ${parseFloat(tp).toFixed(4)}`;
                
                console.log('[UI] Signal display updated:', { dir, price, rr });
            };
            
            const signalTime = document.getElementById('signal-time');
            if (signalTime && status.timeDetected) {
                signalTime.textContent = new Date(status.timeDetected).toLocaleTimeString();
            };
            
            // Trigger glow animation
            signalDiv.style.animation = 'none';
            signalDiv.offsetHeight; // Force reflow
            setTimeout(() => { signalDiv.style.animation = 'glowPulse 0.5s ease-in-out'; }, 10);
            
        } else {
            signalDiv.style.display = 'none';
        };
    };
    
    // Update last event text
    if (lastEventEl) {
        let eventText = statusText;
        if (status.direction) eventText += ` (${status.direction})`;
        if (status.rr) eventText += ` | R:R ${parseFloat(status.rr).toFixed(2)}`;
        if (status.callCount) eventText += ` | Calls: ${status.callCount}`;
        
        lastEventEl.textContent = eventText;
        
        // Color coding for last event
        if (statusText.includes('ENTRY') || statusText.includes('SIGNAL')) {
            lastEventEl.style.color = '#10b981';
        } else if (statusText.includes('OFFLINE')) {
            lastEventEl.style.color = '#ef4444';
        } else if (statusText.includes('BREAK')) {
            lastEventEl.style.color = '#f59e0b';
        } else {
            lastEventEl.style.color = '#8b5cf6';
        };
    };
};

function _startStatusPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    };
    
    console.log('[Status Polling] Starting... polling every 5 seconds');
    
    // Poll every 5 seconds for faster response
    pollInterval = setInterval(() => {
        _pollStrategyStatus().catch(e => console.error('[Status] Poll error:', e));
    }, 5000);
    
    // Initial poll immediately
    _pollStrategyStatus().catch(e => console.error('[Status] Initial poll error:', e));
};

function _stopStatusPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log('[Status Polling] Stopped');
    };
};

// Add CSS animation if not already present
if (!document.querySelector('#status-glow-style')) {
    const style = document.createElement('style');
    style.id = 'status-glow-style';
    style.textContent = `
        @keyframes glowPulse {
            0% { border-left-color: #10b981; box-shadow: 0 0 0px rgba(16,185,129,0); };
            50% { border-left-color: #10b981; box-shadow: 0 0 10px rgba(16,185,129,0.5); };
            100% { border-left-color: #10b981; box-shadow: 0 0 0px rgba(16,185,129,0); };
        };
        
        #strategy-status {
            transition: color 0.2s ease, text-shadow 0.2s ease;
        };
        
        .stat-value {
            transition: color 0.2s ease;
        };
    `;
    document.head.appendChild(style);
};

// Initialize polling with proper DOM ready handling
if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            console.log('[Init] Starting status polling on DOMContentLoaded');
            _startStatusPolling();
        });
    } else {
        console.log('[Init] Starting status polling immediately');
        _startStatusPolling();
    };
};

// Stop polling when page unloads
window.addEventListener('beforeunload', _stopStatusPolling);

// Optional: Expose for debugging
window._debugStatusPolling = {
    stop: _stopStatusPolling,
    start: _startStatusPolling,
    poll: _pollStrategyStatus,
    getStats: () => ({ pollCount, consecutiveErrors, isPolling })
};

// ─────────────────────────────────────────────────────────────
// OVERLAYS
// ─────────────────────────────────────────────────────────────
function redrawOverlays() {
    if (!focusedBotId || !bots[focusedBotId]) return;
    const bot    = bots[focusedBotId];
    const engine = _engineFor(focusedBotId);
    if (!engine) return;
    _drawOverlaysOnEngine(engine, bot);
};

function _drawOverlaysOnEngine(engine, bot) {
    const series = engine.getCandleSeries();
    OverlayManager.clearAll(series, engine);
    if (document.getElementById('show-asian')?.checked)  OverlayManager.drawAsianRange(series, bot.candles);
    if (document.getElementById('show-pdhpdl')?.checked) OverlayManager.drawPDHPDL(series, bot.h4Candles);
    if (document.getElementById('show-fvg')?.checked)    OverlayManager.drawFVG(series, bot.candles, engine);
    if (document.getElementById('show-h4')?.checked)     OverlayManager.drawH4Kiss(series, bot.h4Candles);
    if (document.getElementById('show-major')?.checked)  OverlayManager.drawMajorSR(series, bot.candles);
    if (document.getElementById('show-orb')?.checked)    OverlayManager.drawORBRange(series, bot.candles);
    if (document.getElementById('show-ob')?.checked)     OverlayManager.drawOrderBlocks(series, bot.candles, engine);
    if (document.getElementById('show-bos')?.checked)    OverlayManager.drawBreakOfStructure(series, bot.candles);
};

function redrawAllSplitOverlays() {
    if (!ChartManager.isSplitMode()) return;
    Object.values(bots).forEach(bot => {
        if (!bot.isActive) return;
        const eng = ChartManager.get(bot.id);
        if (!eng) return;
        const saved = overlayState[bot.id] || {};
        const current = {};
        OVERLAY_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) { current[id] = el.checked; el.checked = saved[id] || false; };
        });
        _drawOverlaysOnEngine(eng, bot);
        OVERLAY_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = current[id];
        });
    });
};

// ─────────────────────────────────────────────────────────────
// RISK ALERT
// ─────────────────────────────────────────────────────────────
function _showRiskAlert(message) {
    let alert = document.getElementById('risk-alert');
    if (!alert) {
        alert = document.createElement('div');
        alert.id = 'risk-alert';
        alert.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: #ef4444; color: white; padding: 12px 24px; border-radius: 8px;
            font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; z-index: 9999;
            box-shadow: 0 8px 24px rgba(239,68,68,0.4); animation: riskSlideIn 0.3s ease;
        `;
        document.body.appendChild(alert);
    };
    alert.textContent = '⚠ ' + message;
    alert.style.display = 'block';
    clearTimeout(alert._timer);
    alert._timer = setTimeout(() => { alert.style.display = 'none'; }, 6000);
};

// ─────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────
function logout() {
    api?.forgetAll();
    api?.disconnect();
    Storage.clearToken();
    authorised = false;
    Object.keys(bots).forEach(id => delete bots[id]);
    SessionState.set({ connected: false, mt5Connected: false, activeBots: 0, botConfigs: [] });
    document.documentElement.removeAttribute('data-authed');
    document.getElementById('auth-overlay').style.display     = 'flex';
    document.getElementById('api-token').value                = '';
    document.getElementById('connection-indicator').className = 'status-dot status-offline';
    document.getElementById('conn-label').textContent         = 'Offline';
    document.getElementById('mt5-indicator').className        = 'status-dot status-offline';
    const botList = document.getElementById('bot-list');
    if (botList) botList.innerHTML = '';
    Object.keys(bots).forEach(id => ChartManager.removeBot(id));
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph) ph.style.display = 'flex';
    log('Logged out', 'warn');
    const trades = SessionState.get().trades;
    Auth.syncTrades(trades).finally(() => Auth.logout());
};


// ─────────────────────────────────────────────────────────────
// QUALITY MODE SELECTOR - CLEAN & RELIABLE
// ─────────────────────────────────────────────────────────────
function setupQualityModeSelector(card, botId) {
    const stratSelect = card.querySelector('.bot-strategy-select');
    const modeContainer = card.querySelector('.quality-mode-selector');
    const modeSelect = card.querySelector('.quality-mode-select');
    const modeBadge = card.querySelector('.quality-mode-badge');
    const modeInfo = card.querySelector('.quality-mode-info');

    if (!modeContainer || !modeSelect) return;

    if (!window._botQualityModes) window._botQualityModes = {};

    const modesConfig = {
        jump75: {
            0: { name: 'QUANTITY', emoji: '🚀', minScore: 55, color: '#ec4899' },
            1: { name: 'BALANCED', emoji: '⚖️', minScore: 65, color: '#2563eb' },
            2: { name: 'QUALITY',  emoji: '🎯', minScore: 75, color: '#059669' },
            3: { name: 'ULTRA',    emoji: '👑', minScore: 85, color: '#9333ea' }
        }
    };

    function updateUI() {
        const strategy = stratSelect.value;
        const modes = modesConfig[strategy];
        
        if (!modes) {
            modeContainer.style.display = 'none';
            return;
        }

        modeContainer.style.display = 'block';

        // Populate dropdown if empty
        if (modeSelect.options.length <= 1) {
            modeSelect.innerHTML = '';
            Object.entries(modes).forEach(([value, mode]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = `${mode.emoji} ${mode.name} (Score ≥${mode.minScore})`;
                modeSelect.appendChild(opt);
            });
        }

        // Load saved mode for this specific bot
        const savedMode = window._botQualityModes[botId] ?? 1;
        modeSelect.value = savedMode;

        // Update badge & info
        const currentMode = modes[savedMode];
        if (modeBadge && currentMode) {
            modeBadge.textContent = `${currentMode.emoji} ${currentMode.name}`;
            modeBadge.style.background = currentMode.color + '22';
            modeBadge.style.color = currentMode.color;
        }
        if (modeInfo && currentMode) {
            modeInfo.innerHTML = `Min Score: <b>${currentMode.minScore}</b>`;
        }
    }

    // Listen for changes
    stratSelect.addEventListener('change', updateUI);
    modeSelect.addEventListener('change', () => {
        window._botQualityModes[botId] = parseInt(modeSelect.value);
        updateUI();
        log(`🎯 Bot ${botId} quality mode updated`, 'info');
    });

    // Initial update
    setTimeout(updateUI, 100);
}

// ============================================================
// HELPER FUNCTION: Update bot instance mode when bot starts
// ============================================================

// Call this function AFTER creating a bot instance but BEFORE starting it
function applySavedQualityModeToBot(botId, botInstance) {
    if (!botInstance) return false;
    
    const savedMode = window._botQualityModes ? window._botQualityModes[botId] : null;
    if (savedMode === undefined) return false;
    
    // Get strategy from the card
    const card = document.querySelector(`.bot-card[data-bot-id="${botId}"]`);
    if (!card) return false;
    
    const strategy = card.querySelector('.bot-strategy-select')?.value;
    
    if (strategy === 'jump75' || strategy === 'range_boundary') {
        if (typeof botInstance.setMode === 'function') {
            botInstance.setMode(savedMode);
            console.log(`[Bot ${botId}] Loaded saved quality mode: ${savedMode}`);
            return true;
        } else if (botInstance.QUALITY_MODE !== undefined) {
            botInstance.QUALITY_MODE = savedMode;
            console.log(`[Bot ${botId}] Loaded saved QUALITY_MODE: ${savedMode}`);
            return true;
        }
    }
    
    return false;
}

// ============================================================
// OVERRIDE YOUR EXISTING _saveBotConfigs (if it exists)
// ============================================================

// Find your existing _saveBotConfigs and add qualityMode to it
// If you can't find it, this will enhance it:

if (typeof window._saveBotConfigs === 'function') {
    const originalSave = window._saveBotConfigs;
    window._saveBotConfigs = function() {
        // Call original first
        originalSave();
        
        // Save quality modes
        if (window._botQualityModes) {
            localStorage.setItem('botQualityModes', JSON.stringify(window._botQualityModes));
        }
    };
} else {
    window._saveBotConfigs = function() {
        const configs = {};
        document.querySelectorAll('.bot-card').forEach(card => {
            const botId = card.dataset.botId;
            if (botId) {
                configs[botId] = {
                    strategy: card.querySelector('.bot-strategy-select')?.value,
                    symbol: card.querySelector('.bot-symbol-select')?.value,
                    tf: card.querySelector('.bot-tf-select')?.value,
                    lotSize: card.querySelector('.bot-lot-input')?.value,
                    phantomLot: card.querySelector('.phantom-lot-input')?.value,
                    qualityMode: window._botQualityModes ? window._botQualityModes[botId] : 1
                };
            }
        });
        localStorage.setItem('botConfigs', JSON.stringify(configs));
        
        // Save quality modes separately
        if (window._botQualityModes) {
            localStorage.setItem('botQualityModes', JSON.stringify(window._botQualityModes));
        }
    };
}

// ============================================================
// LOAD SAVED QUALITY MODES ON PAGE LOAD
// ============================================================

function loadSavedQualityModes() {
    const saved = localStorage.getItem('botQualityModes');
    if (saved) {
        try {
            window._botQualityModes = JSON.parse(saved);
            console.log('✅ Loaded saved quality modes:', window._botQualityModes);
        } catch(e) {
            console.warn('Failed to load quality modes:', e);
            window._botQualityModes = {};
        }
    } else {
        window._botQualityModes = {};
    }
}

// Call this when your page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSavedQualityModes);
} else {
    loadSavedQualityModes();
}

// ─────────────────────────────────────────────────────────────
// CREATE BOT CARD
// ─────────────────────────────────────────────────────────────
function _createBotCard(id, savedConfig) {
    const template = document.getElementById('bot-card-template');
    if (!template) { console.error('bot-card-template missing'); return; }
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.bot-card');
    if (!card) { console.error('.bot-card missing from template'); return; }
    
    card.dataset.botId = id;
    
    const stratSelect = card.querySelector('.bot-strategy-select');
    stratSelect.innerHTML = '';
    STRATEGY_GROUPS.forEach(group => {
        const og = document.createElement('optgroup');
        og.label = group.label;
        og.title = group.desc;
        group.strategies.forEach(({ value, label }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            og.appendChild(opt);
        });
        stratSelect.appendChild(og);
    });
    
    const symbolSelect = card.querySelector('.bot-symbol-select');
    Object.entries(SYMBOL_MAP).forEach(([val, name]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = name.replace(' Index', '').trim();
        symbolSelect.appendChild(opt);
    });
    
    if (savedConfig) {
        stratSelect.value = savedConfig.strategy;
        symbolSelect.value = savedConfig.symbol;
        const tfSelect = card.querySelector('.bot-tf-select');
        if (tfSelect) tfSelect.value = savedConfig.tf;
        const lotInput = card.querySelector('.bot-lot-input');
        if (lotInput && savedConfig.lotSize) lotInput.value = savedConfig.lotSize;
        const phantomLotInput = card.querySelector('.phantom-lot-input');
        if (phantomLotInput && savedConfig.phantomLot) phantomLotInput.value = savedConfig.phantomLot;
    }
    
    const updateLabel = () => {
        const labelEl = card.querySelector('.bot-symbol-label');
        if (labelEl) {
            labelEl.textContent = (SYMBOL_MAP[symbolSelect.value] || symbolSelect.value).replace(' Index', '').trim();
        }
    };
    symbolSelect.addEventListener('change', updateLabel);
    updateLabel();
    
    const phantomPanel = card.querySelector('.phantom-settings');
    const tfSelect = card.querySelector('.bot-tf-select');
    const showHidePhantom = () => {
        if (phantomPanel) phantomPanel.style.display = stratSelect.value === 'phantom' ? 'block' : 'none';
        const isM1Strat = stratSelect.value === 'nova' || stratSelect.value === 'kismet';
        let m1Notice = card.querySelector('.m1-notice');
        if (isM1Strat) {
            if (tfSelect) { tfSelect.value = '300'; tfSelect.disabled = true; }
            if (!m1Notice) {
                m1Notice = document.createElement('div');
                m1Notice.className = 'm1-notice';
                m1Notice.style.cssText = 'font-size:9px;color:#f59e0b;margin-top:4px;opacity:0.8;';
                m1Notice.textContent = '📊 M5 locked — NOVA/KISMET run on M5 for correct R:R';
                tfSelect?.closest('.bot-field-group')?.appendChild(m1Notice);
            }
        } else {
            if (tfSelect) tfSelect.disabled = false;
            if (m1Notice) m1Notice.remove();
        }
    };
    stratSelect.addEventListener('change', showHidePhantom);
    showHidePhantom();
    
    
    // ✅ SETUP QUALITY MODE SELECTOR FOR JUMP75 - ADD THIS LINE
    setupQualityModeSelector(card, id);
    
    const configureBtn = card.querySelector('.phantom-configure-btn');
    if (configureBtn) {
        configureBtn.onclick = () => {
            const targetInput = card.querySelector('.phantom-target-input');
            const lossInput = card.querySelector('.phantom-loss-input');
            const target = parseFloat(targetInput?.value) || 0;
            const loss = parseFloat(lossInput?.value) || 0;
            if (target <= 0 && loss <= 0) {
                log('PHANTOM: enter a profit target or loss limit first', 'warn');
                return;
            }
            const session = PhantomStrategy.configureSession(target, loss);
            _updatePhantomBadge(id, session);
            configureBtn.textContent = '✓ SESSION CONFIGURED';
            configureBtn.style.color = '#34d399';
            setTimeout(() => {
                configureBtn.textContent = 'SET SESSION TARGETS';
                configureBtn.style.color = '#a78bfa';
            }, 2000);
            log(`👻 PHANTOM session set — Target: $${target} | Limit: $${loss}`, 'info');
        };
    }
    
    if (savedConfig?.strategy === 'phantom') {
        _updatePhantomBadge(id, PhantomStrategy.getSession());
    }
    
    const toggleBtn = card.querySelector('.bot-toggle-btn');
    toggleBtn.onclick = () => {
        if (card.classList.contains('stopped')) {
            window.startBot(id);
        } else {
            window.stopBot(id);
        }
    };
    
    card.querySelector('.bot-remove-btn').onclick = (e) => {
        e.stopPropagation();
        window.stopBot(id);
        card.remove();
        delete bots[id];
        _saveBotConfigs();
    };
    
    card.onclick = (e) => {
        if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
            window.focusBot(id);
            document.querySelectorAll('.bot-card').forEach(c => c.style.outline = 'none');
            card.style.outline = '2px solid var(--accent-light)';
        }
    };
    
    document.getElementById('bot-list').appendChild(card);
    if (!savedConfig) log('Bot card created — select a symbol and strategy', 'info');
}
window._botQualityModes = window._botQualityModes || {};
window.QUALITY_MODE_DESCRIPTIONS = {
    0: { name: 'QUANTITY', emoji: '🚀', minScore: 55, minMomentum: 0.15 },
    1: { name: 'BALANCED', emoji: '⚖️', minScore: 65, minMomentum: 0.25 },
    2: { name: 'QUALITY', emoji: '🎯', minScore: 75, minMomentum: 0.40 },
    3: { name: 'ULTRA', emoji: '👑', minScore: 85, minMomentum: 0.60 }
};

// ─────────────────────────────────────────────────────────────
// WINDOW HELPERS
// ─────────────────────────────────────────────────────────────
window.getBotConfig = function(id) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return null;
    const strategy = card.querySelector('.bot-strategy-select').value;
    const tfRaw    = parseInt(card.querySelector('.bot-tf-select').value);
    const tf       = (strategy === 'nova' || strategy === 'kismet') ? 300 : tfRaw;
    return {
        strategy,
        symbol:              card.querySelector('.bot-symbol-select').value,
        tf,
        lotSize:             parseFloat(card.querySelector('.bot-lot-input')?.value)     || 0.01,
        phantomLot:          parseFloat(card.querySelector('.phantom-lot-input')?.value) || 0.01,
        phantomCooldownBars: 3,
    };
};

window.setBotRunning = function(id, isRunning) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const btn = card.querySelector('.bot-toggle-btn');
    const dot = card.querySelector('.bot-status-dot');
    if (isRunning) {
        card.classList.replace('stopped', 'running');
        btn.textContent = 'STOP BOT';
        dot.className   = 'status-dot status-online bot-status-dot';
    } else {
        card.classList.replace('running', 'stopped');
        btn.textContent = 'START BOT';
        dot.className   = 'status-dot status-offline bot-status-dot';
    };
    const activeEl = document.getElementById('stat-active');
    if (activeEl) {
        const count = document.querySelectorAll('.bot-card.running').length;
        activeEl.textContent = count;
        activeEl.style.color = count >  0 ? 'var(--accent)' : 'var(--text-muted)';
    };
};

window.setBotOnline = function(id) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const dot = card.querySelector('.bot-status-dot');
    if (dot) dot.className = 'status-dot status-online bot-status-dot';
};

window.registerBotSignal = function(id, type, price, label, confidence) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (card && confidence) {
        let badge = card.querySelector('.bot-confidence-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'bot-confidence-badge';
            badge.style.cssText = `
                font-size:0.58rem;font-weight:700;letter-spacing:0.06em;
                padding:3px 8px;border-radius:6px;margin-top:6px;
                text-align:center;font-family:var(--font-mono);
            `;
            const wlRow = card.querySelector('.bot-card-stats');
            if (wlRow) wlRow.parentNode.insertBefore(badge, wlRow);
        };
        badge.textContent = `SIGNAL ${type} · ${confidence.grade} (${confidence.score}%)`;
        badge.style.background = confidence.color + '22';
        badge.style.color      = confidence.color;
        badge.style.border     = `1px solid ${confidence.color}55`;
        badge.style.borderRadius = '6px';
        badge.style.padding = '3px 8px';
        badge.style.fontSize = '0.65rem';
        badge.style.fontWeight = '600';
        clearTimeout(badge._timer);
        badge._timer = setTimeout(() => { badge.textContent = ''; badge.style.background = 'none'; badge.style.border = 'none'; }, 60000);
    };
};

window.registerBotWin = function(id, pnl) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const bot = bots[id];
    if (bot) { bot.wins++; bot.pnl += pnl; };
    const winsEl = card.querySelector('.bot-wins');
    const pnlEl  = card.querySelector('.bot-pnl');
    if (winsEl && bot) winsEl.textContent = bot.wins;
    if (pnlEl  && bot) {
        pnlEl.textContent = bot.pnl.toFixed(2);
        pnlEl.style.color = bot.pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    };
};

window.registerBotLoss = function(id, pnl) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const bot = bots[id];
    if (bot) { bot.losses++; bot.pnl -= pnl; };
    const lossEl = card.querySelector('.bot-losses');
    const pnlEl  = card.querySelector('.bot-pnl');
    if (lossEl && bot) lossEl.textContent = bot.losses;
    if ( pnlEl  && bot) {
        pnlEl.textContent = bot.pnl.toFixed(2);
        pnlEl.style.color = bot.pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    };
};

function log(msg, type = 'neutral') { UIManager.log(msg, type); };

document.addEventListener('DOMContentLoaded', init);
