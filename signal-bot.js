// signal-bot.js — Multi-instance runner v3.0 with AUTO-DISCOVERY
// PATCH v3.1: Single strategy support (breakout_trend)
// PATCH v3.2: Fixed relative /api/strategy-manifest fetch (404'd once frontend
//             moved to Vercel and no longer shares an origin with the API).



console.log('🔍 Strategy Auto-Discovery enabled');

// ─── API BASE (Render backend) ─────────────────────────────────────────────
// The frontend lives on Vercel; the API lives on Render. Any relative
// fetch('/api/...') here will 404 once these are different origins.
const NEXUS_API_BASE = 'https://bot.atomicprod.shop';

// ─── STRATEGY AUTO-LOADER ──────────────────────────────────────────────────

class StrategyAutoLoader {
    constructor() {
        this.strategies = {};
        this.modules = {};
        this.loaded = false;
        this.loading = false;
    }

    async discoverStrategies() {
        try {
            // Try to get manifest from server
            const response = await fetch(`${NEXUS_API_BASE}/api/strategy-manifest`);
            if (response.ok) {
                const manifest = await response.json();
                console.log(`📦 Found ${manifest.count} strategies from manifest`);
                return manifest.strategies.map(s => s.name);
            }
        } catch (e) {
            console.log('No manifest available, scanning folder...');
        }

        // If manifest fails, manually check for strategies
        const possibleStrategies = ['breakout_trend'];
        const found = [];
        
        for (const name of possibleStrategies) {
            try {
                const module = await import(`./js/strategies/${name}.js`);
                if (module) {
                    found.push(name);
                    console.log(`✅ Found strategy: ${name}`);
                }
            } catch (e) {
                // Strategy doesn't exist
            }
        }
        
        return found;
    }

    async loadStrategy(strategyName) {
        if (this.modules[strategyName]) {
            return this.modules[strategyName];
        }

        try {
            const module = await import(`./js/strategies/${strategyName}.js`);
            
            // Try to get the default export
            let Strategy = module.default;
            
            // If no default, find the main export
            if (!Strategy) {
                const keys = Object.keys(module);
                for (const key of keys) {
                    if (typeof module[key] === 'function') {
                        Strategy = module[key];
                        break;
                    }
                }
            }
            
            if (!Strategy) {
                console.warn(`No strategy class found in ${strategyName}.js`);
                return null;
            }
            
            this.modules[strategyName] = Strategy;
            console.log(`✅ Loaded strategy: ${strategyName}`);
            return Strategy;
            
        } catch (error) {
            console.error(`Failed to load strategy ${strategyName}:`, error);
            return null;
        }
    }

    async loadAllStrategies() {
        if (this.loading) return this.strategies;
        if (this.loaded) return this.strategies;
        
        this.loading = true;
        
        try {
            const strategyNames = await this.discoverStrategies();
            const loaded = {};
            
            for (const name of strategyNames) {
                const Strategy = await this.loadStrategy(name);
                if (Strategy) {
                    loaded[name] = Strategy;
                }
            }
            
            // If we couldn't load any strategies, try the single one
            if (Object.keys(loaded).length === 0) {
                try {
                    const module = await import('./js/strategies/breakout_trend.js');
                    const Strategy = module.default || Object.values(module).find(v => typeof v === 'function');
                    if (Strategy) {
                        loaded['breakout_trend'] = Strategy;
                        this.modules['breakout_trend'] = Strategy;
                        console.log('✅ Loaded breakout_trend strategy');
                    }
                } catch (e) {
                    console.error('Failed to load breakout_trend:', e);
                }
            }
            
            this.strategies = loaded;
            this.loaded = true;
            console.log(`🎯 Loaded ${Object.keys(loaded).length} strategies:`, Object.keys(loaded));
            return loaded;
            
        } catch (error) {
            console.error('Failed to load strategies:', error);
            return {};
        } finally {
            this.loading = false;
        }
    }

    async getStrategy(strategyName) {
        if (!this.modules[strategyName]) {
            await this.loadStrategy(strategyName);
        }
        return this.modules[strategyName] || null;
    }

    getStrategyInfo(strategyName) {
        if (this.strategies[strategyName]) {
            return { name: strategyName, label: strategyName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) };
        }
        return null;
    }
}

// ─── INITIALIZE LOADER ────────────────────────────────────────────────────

const strategyLoader = new StrategyAutoLoader();
let STRATEGY_MODULES = {};

// ─── IMPORT CORE DEPENDENCIES ────────────────────────────────────────────

import { DerivAPI } from './js/deriv-api.js';
import { StrategyEngine } from './js/strategy-engine.js';
import { Indicators } from './js/indicators.js';
import { Storage } from './js/storage.js';
import { OverlayManager } from './js/overlays.js';
import { DataLogger } from './js/data-logger.js';
import { UIManager } from './js/ui-manager.js';
import { SessionState } from './js/session-state.js';
import { Analytics } from './js/pages/analytics.js';
import { Settings } from './js/pages/settings.js';
import { ChartManager, initChartManager } from './js/chart-manager.js';
import { ConfidenceEngine } from './js/confidence.js';
import { Auth } from './js/auth.js';
import { PositionSizing } from './js/position-sizing.js';
// import { SessionState } from './js/session-state.js';
// import { ChartManager, initChartManager } from './js/chart-manager.js';
import { API_BASE} from './js/auth.js';


// Simple EMA calculation for trend detection
function calculateEMA(data, period) {
    if (data.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
    }
    return ema;
}

// ─── ONLY IMPORT STRATEGIES THAT ACTUALLY EXIST ─────────────────────────

// Import Jump75 if it exists — wrapped in an IIFE so this doesn't block
// module evaluation with a top-level await (which was the actual cause
// of the "Add Bot" button doing nothing: DOMContentLoaded fired and
// completed before this script ever reached its own listener registration
// at the bottom of the file).
let Jump75Strategy = null;
(async () => {
    try {
        const module = await import('./js/strategies/jump75.js');
        Jump75Strategy = module.default || module;
        window.Jump75Strategy = Jump75Strategy;
        console.log('✅ Loaded Jump75Strategy');
    } catch (e) {
        console.log('ℹ️ Jump75Strategy not found (optional)');
    }
})();

// ─── STRATEGY GROUPS ──────────────────────────────────────────────────────

const STRATEGY_GROUPS = {
    trend: { 
        label: 'Trend Following', 
        strategies: {}
    },
    scalping: { label: 'Scalping', strategies: {} },
    momentum: { label: 'Momentum', strategies: {} },
    swing: { label: 'Swing', strategies: {} },
    advanced: { label: 'Advanced', strategies: {} }
};

function categorizeStrategy(strategyName) {
    const name = strategyName.toLowerCase();
    if (name.includes('scalp') || name.includes('scalper')) return 'scalping';
    if (name.includes('momentum') || name.includes('trend') || name.includes('orb')) return 'momentum';
    if (name.includes('swing') || name.includes('kiss') || name.includes('range')) return 'swing';
    return 'advanced';
}

async function buildStrategyGroups() {
    const strategies = await strategyLoader.loadAllStrategies();
    STRATEGY_MODULES = strategies;
    
    // Clear groups
    for (const group of Object.values(STRATEGY_GROUPS)) {
        group.strategies = {};
    }
    
    // Add strategies to groups
    for (const [name, StrategyClass] of Object.entries(strategies)) {
        if (!StrategyClass) continue;
        const category = categorizeStrategy(name);
        const group = STRATEGY_GROUPS[category];
        if (group) {
            const info = strategyLoader.getStrategyInfo(name);
            group.strategies[name] = {
                module: StrategyClass,
                label: info?.label || name,
                type: info?.type || category
            };
        }
    }
    
    console.log('🏷️ Strategy groups built:', Object.keys(STRATEGY_GROUPS).map(g => 
        `${g}: ${Object.keys(STRATEGY_GROUPS[g].strategies).length}`
    ).join(', '));
    
    window.STRATEGY_GROUPS = STRATEGY_GROUPS;
    window.STRATEGY_MODULES = STRATEGY_MODULES;
    
    return STRATEGY_GROUPS;
}

// ─── AI SERVER CONFIGURATION ─────────────────────────────────────────────

const AI_SERVER_URL = 'https://ai-server-production-8bc5.up.railway.app';
const USE_LOCAL_AI = false;

let aiServerReady = false;
let aiServerChecked = false;
let aiServerFailed = false;

async function checkAIServer() {
    if (aiServerChecked) return;
    
    const url = USE_LOCAL_AI ? 'http://localhost:5000' : AI_SERVER_URL;
    console.log(`%c🔍 [AI] Testing connection to ${url}...`, "color: cyan; font-weight: bold");
    
    const endpoints = ['', '/', '/predict', '/api/health', '/status'];
    let connected = false;
    
    for (const endpoint of endpoints) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const testUrl = `${url}${endpoint}`;
            const res = await fetch(testUrl, {
                method: 'GET',
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            
            clearTimeout(timeoutId);
            
            if (res.ok) {
                aiServerReady = true;
                aiServerChecked = true;
                connected = true;
                console.log(`%c✅ AI SERVER CONNECTED`, "color: lime; font-size: 16px; font-weight: bold");
                break;
            }
        } catch(e) {
            // Continue
        }
    }
    
    if (!connected) {
        console.log("%c⛔ CANNOT REACH AI SERVER", "color: red; font-weight: bold");
        aiServerReady = false;
        aiServerChecked = true;
    }
}

async function getAIWinProbability(signal, atr, rsi, isBreakout = false) {
    if (aiServerFailed || !aiServerReady || !aiServerChecked) return 50;
    
    try {
        const features = {
            rr_ratio: (signal.tpMultiplier || 2.2) / (signal.slMultiplier || 1.0),
            atr_ratio: signal.slMultiplier || 1.5,
            is_breakout: isBreakout ? 1 : 0,
            hour: new Date().getHours(),
            symbol_type: signal.symbol?.includes('75') ? 1 : signal.symbol?.includes('10') ? 2 : 3
        };
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        const res = await fetch(`${AI_SERVER_URL}/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(features),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        return data.win_probability || data.probability || 50;
    } catch(e) {
        return 50;
    }
}

window._debugAI = {
    ready: () => aiServerReady,
    url: AI_SERVER_URL,
    check: async () => {
        aiServerChecked = false;
        await checkAIServer();
        return aiServerReady;
    },
    test: async () => {
        const start = Date.now();
        try {
            const res = await fetch(`${AI_SERVER_URL}/predict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    rr_ratio: 2.5,
                    atr_ratio: 1.5,
                    is_breakout: 1,
                    hour: 12,
                    symbol_type: 1
                })
            });
            const data = await res.json();
            const latency = Date.now() - start;
            console.log(`✅ Test prediction: ${data.win_probability}% (${latency}ms)`);
            return data.win_probability;
        } catch(e) {
            console.error('❌ Test failed:', e.message);
            return null;
        }
    }
};

// ─── WEBSOCKET CONNECTION ─────────────────────────────────────────────────

let renderWS = null;
let pendingSignals = [];

function connectRenderWebSocket() {
    if (renderWS && (renderWS.readyState === WebSocket.OPEN || renderWS.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const WS_URL = 'wss://bot.atomicprod.shop';
    console.log(`[WS] Connecting to LOCAL BRIDGE: ${WS_URL}`);

    renderWS = new WebSocket(WS_URL);
    window.renderWS = renderWS;

    renderWS.onopen = () => {
        console.log("✅ Connected to LOCAL MT5 Bridge");
        log("✅ Connected to MT5 bridge", "info");
        SessionState.set({ mt5Connected: true });
        
        if (pendingSignals.length > 0) {
            pendingSignals.forEach(sig => {
                try { renderWS.send(JSON.stringify(sig)); } catch(e) {}
            });
            pendingSignals = [];
        }
    };

    renderWS.onerror = () => {
        log("Cannot connect to local bridge. Is bridge.cjs running?", "warn");
    };

    renderWS.onclose = () => {
        setTimeout(connectRenderWebSocket, 5000);
    };
}

// ─── SYMBOL MAP ────────────────────────────────────────────────────────────

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
    'OTC_NDX': 'US Tech 100',
    'OTC_SPC': 'US 500',
    'OTC_DJI': 'Wall Street 30',
};

// ─── POINT VALUE HELPER ──────────────────────────────────────────────────

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
        'OTC_NDX':  1.0,
        'OTC_SPC':  1.0,
        'OTC_DJI':  1.0,
    };
    return MAP[symbol] || 0.41;
}

function _getDecimalPlaces(symbol) {
    if (/OTC_NDX|OTC_SPC|OTC_DJI|OTC_AS51|OTC_GDAXI|OTC_N225|OTC_FTSE/.test(symbol)) return 2;
    if (/OTC_HSI/.test(symbol)) return 1;
    if (/JD|BOOM|CRASH|R_|1HZ|stpRNG|RB/.test(symbol)) return 2;
    if (/cryBTC/.test(symbol)) return 2;
    return 5;
}

// ─── BOT STATE CLASS ──────────────────────────────────────────────────────

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
    }
}

// ─── SHARED SINGLETONS ────────────────────────────────────────────────────

let api = null;
let symbolMap = {};
const bots = {};
let focusedBotId = null;
let authorised = false;

const MT5_SYMBOL_MAP = {
    'stpRNG': 'Step Index',
    'STEP': 'Step Index',
    'Step Index 100': 'Step Index',
    'Step Index 200': 'Step Index 200',
    'Crash 1000 Index': 'Crash 1000 Index',
    'Boom 1000 Index': 'Boom 1000 Index',
    'Crash 500 Index': 'Crash 500 Index',
    'Boom 500 Index': 'Boom 500 Index',
    'Volatility 10 Index': 'Volatility 10 Index',
    'Volatility 25 Index': 'Volatility 25 Index',
    'Volatility 50 Index': 'Volatility 50 Index',
    'Volatility 75 Index': 'Volatility 75 Index',
    'Volatility 100 Index': 'Volatility 100 Index',
    'Jump 10 Index': 'Jump 10 Index',
    'Jump 25 Index': 'Jump 25 Index',
    'Jump 50 Index': 'Jump 50 Index',
    'Jump 75 Index': 'Jump 75 Index',
    'Jump 100 Index': 'Jump 100 Index',
    'OTC_NDX': 'US Tech 100',
    'OTC_SPC': 'US 500',
    'OTC_DJI': 'Wall Street 30',
};

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────

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
        const icon = type === 'BUY' ? '🟢' : '🔴';
        const title = `${icon} ${type} — ${symbol}`;
        const body = `${label}  ·  @ ${parseFloat(price).toFixed(4)}  ·  ${confidence?.grade || '?'}${confidence?.score || ''}`;
        try {
            const n = new Notification(title, { body, icon: '/favicon.ico', tag: `nexus-signal-${Date.now()}` });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 8000);
        } catch(e) {}
    },

    outcome(type, outcome, symbol, pnl) {
        if (!this._allowed || document.hasFocus()) return;
        const icon = outcome === 'TP' ? '✅' : '❌';
        const title = `${icon} ${outcome} — ${symbol}`;
        const body = `${type} closed  ·  P&L: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
        try {
            const n = new Notification(title, { body, icon: '/favicon.ico', tag: `nexus-outcome-${Date.now()}` });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 6000);
        } catch(e) {}
    },
};

// ─── OVERLAY FUNCTIONS ────────────────────────────────────────────────────

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
    const panel = document.getElementById('overlay-panel');
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

// ─── SAVE / RESTORE ──────────────────────────────────────────────────────

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
        const bot = new BotState(id, config);
        bots[id] = bot;
        bot.isActive = true;
        bot.sessionStart = Date.now();
        window.setBotRunning(id, true);
        const symLabel = (SYMBOL_MAP[config.symbol] || config.symbol).replace(' Index','').trim();
        ChartManager.addBot(id, symLabel, TF_LABEL[config.tf] || 'M5');
        log(`Bot #${id} restored — ${config.strategy} on ${config.symbol}`, 'info');

        // Subscribe immediately if already authorized
        if (api?.socket?.readyState === 1 && authorised) {
            subscribeBot(bot);
        }
    });
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph && saved.length > 0) ph.style.display = 'none';
    const firstId = saved[0]?.id;
    if (firstId) { focusedBotId = firstId; }
}

// ─── TF LABELS ────────────────────────────────────────────────────────────

const TF_LABEL = {
    60:'M1', 120:'M2', 300:'M5', 600:'M10',
    900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1'
};

// ─── NORMALIZE SYMBOL ────────────────────────────────────────────────────

function normalizeSymbol(raw) {
    if (!raw) return raw;
    const MAP = {
        'Jump 10 Index': 'JD10',
        'Jump 25 Index': 'JD25',
        'Jump 50 Index': 'JD50',
        'Jump 75 Index': 'JD75',
        'Jump 100 Index': 'JD100',
    };
    return MAP[raw] || raw;
}

// ─── HANDLE DATA FROM API ───────────────────────────────────────────────

function handleData(data) {
    if (data.error) {
        const req = data.echo_req || {};
        const sym = req.ticks_history || req.subscribe || '?';
        const gran = req.granularity ? ` (${TF_LABEL[req.granularity] || req.granularity})` : '';
        log(`API Error [${sym}${gran}]: ${data.error.message}`, 'warn');
        return;
    }

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
    }

    if (data.msg_type === 'active_symbols') {
        data.active_symbols.forEach(s => { symbolMap[s.symbol] = s.display_name; });
        log(`${data.active_symbols.length} symbols loaded`, 'info');
    }

    if (data.msg_type === 'candles') {
        SessionState.set({ lastCandleAt: Date.now() });
        const gran = data.echo_req.granularity;
        const rawSymbol = data.echo_req.ticks_history;
        const symbol = normalizeSymbol(rawSymbol);

        const history = data.candles.map(c => ({
            time: parseInt(c.epoch),
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        Object.values(bots).forEach(bot => {
            if (!bot.isActive || bot.config.symbol !== symbol) return;

            if (bot.config.strategy === 'jump75') {
                if (gran === 300) {
                    history.forEach(c => bot.m5Candles.push(c));
                    if (bot.m5Candles.length > 150) bot.m5Candles = bot.m5Candles.slice(-150);
                    bot.lastM5CloseTime = history[history.length-1].time;
                }
                if (gran === 900) {
                    history.forEach(c => bot.m15Candles.push(c));
                    if (bot.m15Candles.length > 80) bot.m15Candles = bot.m15Candles.slice(-80);
                    bot.lastM15CloseTime = history[history.length-1].time;
                }
                if (gran === 14400) {
                    history.forEach(c => bot.h4Candles.push(c));
                    if (bot.h4Candles.length > 50) bot.h4Candles = bot.h4Candles.slice(-50);
                    bot.lastH4CloseTime = history[history.length-1].time;
                }
            }

            if (gran === bot.config.tf) {
                bot.candles = history;
                ChartManager.setData(bot.id, history);
            }
        });
    }

    if (data.msg_type === 'ohlc') {
        SessionState.set({ lastCandleAt: Date.now() });
        const gran = data.echo_req.granularity;
        const rawSymbol = data.ohlc.symbol || data.echo_req.ticks_history;
        const symbol = normalizeSymbol(rawSymbol);

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
            }
        });
    }
}

// ─── SUBSCRIBE BOT ──────────────────────────────────────────────────────

function subscribeBot(bot) {
    if (!bot || !bot.config) return;
    
    console.log(`[SUBSCRIBE] Bot ${bot.id} | Strategy: ${bot.config.strategy} | Symbol: ${bot.config.symbol}`);
    Notify.request();

    if (bot.config.strategy === 'jump75') {
        console.log(`[SUBSCRIBE] Jump75 → Subscribing M5 + M15 + H4 for ${bot.config.symbol}`);
        api.subscribe(bot.config.symbol, 300);
        api.subscribe(bot.config.symbol, 900);
        api.subscribe(bot.config.symbol, 14400);
        log(`✅ Subscribed ${bot.config.symbol} for Jump75: M5 + M15 + H4`, 'info');
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

// ─── PROCESS BAR ─────────────────────────────────────────────────────────

function processBar(bot, bar, gran) {
    if (bot.config.strategy === 'jump75') {
        if (gran === 300) {
            bot.m5Candles.push(bar);
            if (bot.m5Candles.length > 150) bot.m5Candles.shift();
            bot.lastM5CloseTime = bar.time;
        }
        if (gran === 900) {
            bot.m15Candles.push(bar);
            if (bot.m15Candles.length > 80) bot.m15Candles.shift();
            bot.lastM15CloseTime = bar.time;
        }
        if (gran === 14400) {
            bot.h4Candles.push(bar);
            if (bot.h4Candles.length > 50) bot.h4Candles.shift();
            bot.lastH4CloseTime = bar.time;
        }
    }

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
    }

    if (bot.config.strategy === 'jump75' && gran === 300) {
        const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
        const atr = Indicators.calculateATR(bot.candles);
        _runJump75(bot, bar, atr, rsi);
        return;
    }

    if (gran !== bot.config.tf) return;

    const last = bot.candles[bot.candles.length - 1];
    const isNewCandle = !(last && last.time === bar.time);
    if (!isNewCandle) {
        bot.candles[bot.candles.length - 1] = bar;
    } else {
        bot.candles.push(bar);
        if (bot.candles.length > 1000) bot.candles.shift();
    }

    ChartManager.update(bot.id, bar);

    if (bot.candles.length < 20) {
        console.log(`[${bot.config.symbol}] Waiting for candle history (${bot.candles.length}/20)`);
        return;
    }

    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const atr = Indicators.calculateATR(bot.candles);

    // ─── SAFE TREND DETECTION ──────────────────────────────────────────
    let isTrending = null;
    if (bot.candles.length >= 20) {
        try {
            // Simple trend check using price vs 20-period SMA
            const closes = bot.candles.map(c => c.close);
            const lastPrice = closes[closes.length - 1];
            const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            isTrending = lastPrice > sma20;
        } catch(e) {
            isTrending = null;
        }
    }
    const marketCond = isTrending === null ? '—' : isTrending ? 'TRENDING' : 'RANGING';

    ChartManager.updatePanelHUD(bot.id, rsi, atr, marketCond);
    if (bot.id === focusedBotId) UIManager.updateHUD(rsi, atr, marketCond);

    // Redraw overlays only when a genuinely new candle closed
    if (isNewCandle && bot.id === focusedBotId) redrawOverlays();

    const livePrices = SessionState.get().livePrices || {};
    const displaySym = SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
    livePrices[displaySym] = { price: bar.close, change: 0 };
    SessionState.set({ livePrices });

    checkOutcome(bot);

    // Only evaluate strategy on a confirmed closed candle
    if (isNewCandle) {
        _runStrategy(bot, bot.candles, atr, rsi);
    }
}

// ─── BOT STATUS UPDATES ──────────────────────────────────────────────────

function startStatusUpdates() {
    setInterval(() => {
        const activeBots = Object.values(bots).filter(b => b.isActive);
        
        if (activeBots.length === 0) {
            // Only log every 60 seconds if no bots
            if (!window._lastNoBotLog || Date.now() - window._lastNoBotLog > 60000) {
                log('💤 No active bots. Add a bot and start it.', 'neutral');
                window._lastNoBotLog = Date.now();
            }
            return;
        }
        
        activeBots.forEach(bot => {
            const status = [];
            const candles = bot.candles || [];
            const lastCandle = candles[candles.length - 1];
            
            status.push(`📊 ${bot.config.symbol} (${TF_LABEL[bot.config.tf] || 'M5'})`);
            status.push(`Candles: ${candles.length}`);
            
            if (lastCandle && candles.length > 1) {
                const prevClose = candles[candles.length - 2]?.close || lastCandle.close;
                const change = lastCandle.close - prevClose;
                const changePercent = prevClose !== 0 ? (change / prevClose * 100) : 0;
                status.push(`Price: ${lastCandle.close.toFixed(2)}`);
                status.push(`Change: ${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
            } else if (lastCandle) {
                status.push(`Price: ${lastCandle.close.toFixed(2)}`);
            }
            
            if (bot.openSignal) {
                const pnl = bot.openSignal.type === 'BUY' 
                    ? lastCandle?.close - bot.openSignal.entry 
                    : bot.openSignal.entry - lastCandle?.close;
                status.push(`💰 IN TRADE: ${bot.openSignal.type} @ ${bot.openSignal.entry.toFixed(2)}`);
                status.push(`PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
                status.push(`SL: ${bot.openSignal.sl.toFixed(2)} | TP: ${bot.openSignal.tp.toFixed(2)}`);
            } else {
                // Check if waiting for cooldown
                const cooldownMs = (bot.config.tf || 300) * 2 * 1000;
                const timeSinceLast = Date.now() - bot.lastFiredMs;
                if (timeSinceLast < cooldownMs && bot.lastFiredMs > 0) {
                    const waitSeconds = Math.round((cooldownMs - timeSinceLast) / 1000);
                    status.push(`⏳ Cooldown: ${waitSeconds}s remaining`);
                } else {
                    status.push(`🔍 Scanning for signals...`);
                }
            }
            
            // Show recent highs/lows being monitored
            if (candles.length > 20) {
                const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
                const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
                const range = recentHigh - recentLow;
                status.push(`📈 Range: ${recentLow.toFixed(2)} - ${recentHigh.toFixed(2)} (${range.toFixed(2)})`);
            }
            
            log(`🤖 ${status.join(' | ')}`, 'info');
        });
    }, 30000); // Every 30 seconds
}

// ─── RUN STRATEGY WITH STATUS LOGGING ──────────────────────────────────

async function _runStrategy(bot, candles, atr, rsi) {
    const strategyName = bot.config.strategy;
    const now = Date.now();

    // Evaluate against closed bars only — drop the just-opened forming candle
    const evalCandles = candles.slice(0, -1);
    const lastClosed  = evalCandles[evalCandles.length - 1];
    if (!lastClosed) return;

    // Get the strategy class
    let StrategyClass = STRATEGY_MODULES[strategyName];
    
    if (!StrategyClass) {
        StrategyClass = await strategyLoader.getStrategy(strategyName);
        if (StrategyClass) {
            STRATEGY_MODULES[strategyName] = StrategyClass;
        }
    }
    
    if (!StrategyClass) {
        log(`❌ Strategy "${strategyName}" not found`, 'error');
        return;
    }
    
    if (typeof StrategyClass.checkEntry !== 'function') {
        log(`❌ Strategy "${strategyName}" missing checkEntry method`, 'error');
        return;
    }
    
    // Check cooldown
    const cooldownMs = (bot.config.tf || 300) * 2 * 1000;
    const timeSinceLast = now - bot.lastFiredMs;
    
    // Only log every 5 candles to avoid spam
    if (!bot._lastStatusLog || now - bot._lastStatusLog > (bot.config.tf || 300) * 5 * 1000) {
        if (evalCandles.length > 20) {
            const recentHigh = Math.max(...evalCandles.slice(-20).map(c => c.high));
            const recentLow = Math.min(...evalCandles.slice(-20).map(c => c.low));
            log(`🔍 ${strategyName.toUpperCase()} monitoring ${bot.config.symbol} | Range: ${recentLow.toFixed(2)} - ${recentHigh.toFixed(2)} | Price: ${lastClosed.close.toFixed(2)}`, 'info');
            bot._lastStatusLog = now;
        }
    }
    
    if (timeSinceLast < cooldownMs && bot.lastFiredMs > 0) {
        return;
    }
    
    // Get signal from strategy — evaluated on confirmed closed candles only
    let signal = null;
    try {
        signal = await StrategyClass.checkEntry(evalCandles, atr, bot.config.symbol);
    } catch (error) {
        console.error(`Strategy ${strategyName} error:`, error);
        log(`❌ Strategy error: ${error.message}`, 'error');
        return;
    }
    
    if (!signal) {
        // Log no signal occasionally
        if (!bot._lastNoSignalLog || now - bot._lastNoSignalLog > (bot.config.tf || 300) * 10 * 1000) {
            if (evalCandles.length > 20) {
                const recentHigh = Math.max(...evalCandles.slice(-20).map(c => c.high));
                const recentLow = Math.min(...evalCandles.slice(-20).map(c => c.low));
                log(`📉 No signal | ${bot.config.symbol} | Range: ${recentLow.toFixed(2)} - ${recentHigh.toFixed(2)} | Price: ${lastClosed.close.toFixed(2)}`, 'neutral');
                bot._lastNoSignalLog = now;
            }
        }
        return;
    }
    
    // Fire the signal using the last confirmed closed bar for price/time reference
    bot.lastFiredMs = now;
    log(`🎯 ${signal.type} SIGNAL DETECTED on ${bot.config.symbol}! @ ${lastClosed.close.toFixed(4)}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.reason) {
        log(`📋 Reason: ${signal.reason}`, 'info');
    }
    if (signal.factors && signal.factors.length) {
        log(`📋 Factors: ${signal.factors.join(' | ')}`, 'info');
    }
    
    fireSignal(bot, signal, lastClosed, atr, rsi);
}


// ─── FIRE SIGNAL ──────────────────────────────────────────────────────────

async function fireSignal(bot, signal, bar, atr, rsi) {
    let type = signal?.type || signal?.direction;
    if (type === 'LONG') signal.type = 'BUY';
    if (type === 'SHORT') signal.type = 'SELL';
    if (!type || type === 'BUY/SELL') {
        console.warn('[fireSignal] Unknown signal type:', signal);
        type = 'BUY';
    }

    const label = signal.label || type;

    let confidence = {
        score: signal.score || 50,
        grade: signal.score >= 70 ? 'A' : signal.score >= 55 ? 'B' : 'C',
        color: signal.score >= 70 ? '#34d399' : signal.score >= 55 ? '#fbbf24' : '#a78bfa',
        factors: signal.factors || [],
    };

    window.registerBotSignal(bot.id, type, bar.close.toFixed(4), label, confidence);

    if (!atr) return;

    let slDist, tpDist;
    let slMult = 1.0;
    let tpMult = 1.5;

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
    }

    const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
    const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

    // Position sizing
    let riskPercent = 0.75;
    const accountEquity = bot.accountEquity || SessionState.get().accountEquity || 10000;
    
    let lotSize = 0.01;
    try {
        const sizing = PositionSizing.calculateLotSize({
            symbol: bot.config.symbol,
            accountEquity: accountEquity,
            atr: atr,
            slMultiplier: slMult,
            riskPercent: riskPercent,
            useStreakScaling: false
        });
        if (sizing.allowed && sizing.lotSize > 0) {
            lotSize = Math.max(0.01, sizing.lotSize);
        }
    } catch(e) {
        lotSize = 0.01;
    }
    lotSize = Math.min(0.05, Math.max(0.01, lotSize));

    bot.openSignal = { type, sl, tp, entry: bar.close, lotSize: lotSize, strategy: bot.config.strategy };
    bot.lastConfidence = confidence;

    const sigEngine = _engineFor(bot.id);
    if (sigEngine) {
        sigEngine.addMarker(bar.time, type, label);
        sigEngine.drawTradeLevels(sl, tp);
    }

    // MT5 Push
    if (document.getElementById('auto-mt5')?.checked) {
        const derivDisplay = symbolMap[bot.config.symbol] || SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
        const mt5Symbol = MT5_SYMBOL_MAP[bot.config.symbol] || MT5_SYMBOL_MAP[derivDisplay] || derivDisplay;
        const clampedLot = Math.max(0.01, parseFloat((Math.round(lotSize / 0.01) * 0.01).toFixed(2)));

        const signalMsg = {
            action: type.toLowerCase(),
            symbol: mt5Symbol,
            lotSize: clampedLot,
            timestamp: Date.now()
        };

        if (!renderWS || renderWS.readyState !== WebSocket.OPEN) {
            pendingSignals.push(signalMsg);
            connectRenderWebSocket();
        } else {
            try {
                renderWS.send(JSON.stringify(signalMsg));
                console.log(`[MT5] Sent to local bridge → ${type} ${mt5Symbol} | lot ${clampedLot}`);
            } catch (e) {
                pendingSignals.push(signalMsg);
            }
        }
    }
}

// ─── CHECK OUTCOME ────────────────────────────────────────────────────────

function checkOutcome(bot) {
    if (!bot.openSignal) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
    bot.openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry, lotSize: signalLotSize } = bot.openSignal;
    let hit = null;

    if (type === 'BUY') {
        if (closed.low <= sl) hit = 'SL';
        else if (closed.high >= tp) hit = 'TP';
    } else {
        if (closed.high >= sl) hit = 'SL';
        else if (closed.low <= tp) hit = 'TP';
    }

    if (!hit) return;

    const lotSizeUsed = signalLotSize || bot.config.lotSize || 0.01;
    const pv = _pointValue(bot.config.symbol);
    const slPriceDist = Math.abs(entry - sl);
    const tpPriceDist = Math.abs(tp - entry);
    const pnlAmt = hit === 'TP' ? lotSizeUsed * pv * tpPriceDist : lotSizeUsed * pv * slPriceDist;

    const newEquity = (SessionState.get().sessionPnL || 0) + (hit === 'TP' ? pnlAmt : -pnlAmt);
    PositionSizing.updateAfterTrade(hit, hit === 'TP' ? pnlAmt : -pnlAmt, newEquity + 10000);

    if (hit === 'TP') {
        log(`✓ TP hit +$${pnlAmt.toFixed(2)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: bot.config.strategy, type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
    } else {
        log(`✗ SL hit -$${pnlAmt.toFixed(2)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: bot.config.strategy, type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: bot.config.strategy,
        type, entry, sl, tp, outcome: hit, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    const state = SessionState.get();
    const wins = state.wins + (hit === 'TP' ? 1 : 0);
    const losses = state.losses + (hit === 'SL' ? 1 : 0);
    const pnl = state.sessionPnL + (hit === 'TP' ? pnlAmt : -pnlAmt);
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
    SessionState.set({ wins, losses, sessionPnL: pnl, winRate, accountEquity: newEquity + 10000 });

    const outcomeEngine = _engineFor(bot.id);
    if (outcomeEngine) {
        outcomeEngine.clearMarkers();
        outcomeEngine.clearPriceLines();
    }

    bot.openSignal = null;
}

// ─── ENGINE HELPER ────────────────────────────────────────────────────────

function _engineFor(botId) {
    if (!ChartManager.isSplitMode() && botId === focusedBotId) {
        return ChartManager.mainEngine();
    }
    return ChartManager.get(botId);
}

// ─── REDRAW OVERLAYS ─────────────────────────────────────────────────────

function redrawOverlays() {
    if (!focusedBotId || !bots[focusedBotId]) return;
    const bot = bots[focusedBotId];
    const engine = _engineFor(focusedBotId);
    if (!engine) return;
    _drawOverlaysOnEngine(engine, bot);
}

// ─── CHART CLEANUP ───────────────────────────────────────────────────────

function cleanChart(botId) {
    const engine = _engineFor(botId);
    if (!engine) return;
    
    const series = engine.getCandleSeries();
    OverlayManager.clearAll(series, engine);
    
    // Only draw H4 levels if we have data
    const bot = bots[botId];
    if (bot && bot.h4Candles && bot.h4Candles.length > 0) {
        try {
            engine.drawH4Levels(bot.h4Candles);
            log('🧹 Chart cleaned - only H4 levels shown', 'info');
        } catch(e) {
            log('⚠️ Could not draw H4 levels: ' + e.message, 'warn');
        }
    } else {
        log('🧹 Chart cleaned - all overlays removed', 'info');
    }
}

// Clean all charts
function cleanAllCharts() {
    Object.keys(bots).forEach(id => {
        if (bots[id].isActive) {
            cleanChart(id);
        }
    });
    log('🧹 All charts cleaned', 'info');
}

// Expose to window
window.cleanChart = cleanChart;
window.cleanAllCharts = cleanAllCharts;

function _drawOverlaysOnEngine(engine, bot) {
    const series = engine.getCandleSeries();
    OverlayManager.clearAll(series, engine);
    if (document.getElementById('show-asian')?.checked) OverlayManager.drawAsianRange(series, bot.candles);
    if (document.getElementById('show-pdhpdl')?.checked) OverlayManager.drawPDHPDL(series, bot.h4Candles);
    if (document.getElementById('show-fvg')?.checked) OverlayManager.drawFVG(series, bot.candles, engine);
    if (document.getElementById('show-h4')?.checked) OverlayManager.drawH4Kiss(series, bot.h4Candles);
    if (document.getElementById('show-major')?.checked) OverlayManager.drawMajorSR(series, bot.candles);
    if (document.getElementById('show-orb')?.checked) OverlayManager.drawORBRange(series, bot.candles);
    if (document.getElementById('show-ob')?.checked) OverlayManager.drawOrderBlocks(series, bot.candles, engine);
    if (document.getElementById('show-bos')?.checked) OverlayManager.drawBreakOfStructure(series, bot.candles);
}

// Called by ChartManager.setData before resetting chart data so stale price lines are removed
window.clearOverlaysForEngine = function(engine) {
    if (!engine) return;
    const series = engine.getCandleSeries?.();
    if (series) OverlayManager.clearAll(series, engine);
};

// ─── START / STOP BOT ────────────────────────────────────────────────────

window.startBot = function(id) {
    const config = window.getBotConfig(id);
    if (!config) return;
    const wasAnyBotActive = Object.values(bots).some(b => b.isActive);

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
    if (!wasAnyBotActive) {
        PositionSizing.reset();
        PositionSizing.resetSession(bot.accountEquity);
    }
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
    const tfLabel = TF_LABEL[bot.config.tf] || 'M5';

    document.getElementById('chart-symbol-label').textContent = symLabel;
    document.getElementById('chart-tf-label').textContent = tfLabel;
    ChartManager.updateLabel(id, symLabel, tfLabel);

    if (ChartManager.count() > 1) {
        ChartManager.focus(id);
        _loadOverlayState(id);
        _showOverlayPanel(true);
        setTimeout(() => {
            ChartManager.setData(id, bot.candles);
            redrawOverlays();
            if (bot.openSignal) {
                const eng = ChartManager.mainEngine();
                if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
            }
        }, 30);
    } else {
        _showOverlayPanel(true);
        _loadOverlayState(id);
        ChartManager.setData(id, bot.candles);
        const engine = ChartManager.get(id);
        if (engine && bot.candles.length > 0) {
            engine.chart.timeScale().fitContent();
            redrawOverlays();
        }
    }
};

window.onSplitView = function() {
    _showOverlayPanel(false);
};

// ─── CREATE BOT CARD ─────────────────────────────────────────────────────

function _createBotCard(id, savedConfig) {
    const template = document.getElementById('bot-card-template');
    if (!template) { console.error('bot-card-template missing'); return; }
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.bot-card');
    if (!card) { console.error('.bot-card missing from template'); return; }
    
    card.dataset.botId = id;
    
    const stratSelect = card.querySelector('.bot-strategy-select');
    stratSelect.innerHTML = '';
    
    // Build strategy options from loaded strategies
    const strategyNames = Object.keys(STRATEGY_MODULES);
    if (strategyNames.length === 0) {
        // Fallback if no strategies loaded
        const opt = document.createElement('option');
        opt.value = 'breakout_trend';
        opt.textContent = 'Breakout Trend';
        stratSelect.appendChild(opt);
    } else {
        for (const name of strategyNames) {
            const opt = document.createElement('option');
            opt.value = name;
            const label = name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            opt.textContent = label;
            stratSelect.appendChild(opt);
        }
    }
    
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
    }
    
    const updateLabel = () => {
        const labelEl = card.querySelector('.bot-symbol-label');
        if (labelEl) {
            labelEl.textContent = (SYMBOL_MAP[symbolSelect.value] || symbolSelect.value).replace(' Index', '').trim();
        }
    };
    symbolSelect.addEventListener('change', updateLabel);
    updateLabel();
    
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

// ─── WINDOW HELPERS ──────────────────────────────────────────────────────

window.getBotConfig = function(id) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return null;
    const strategy = card.querySelector('.bot-strategy-select').value;
    const tfRaw = parseInt(card.querySelector('.bot-tf-select').value);
    const tf = (strategy === 'nova' || strategy === 'kismet') ? 300 : tfRaw;
    return {
        strategy,
        symbol: card.querySelector('.bot-symbol-select').value,
        tf,
        lotSize: parseFloat(card.querySelector('.bot-lot-input')?.value) || 0.01,
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
        dot.className = 'status-dot status-online bot-status-dot';
    } else {
        card.classList.replace('running', 'stopped');
        btn.textContent = 'START BOT';
        dot.className = 'status-dot status-offline bot-status-dot';
    }
    const activeEl = document.getElementById('stat-active');
    if (activeEl) {
        const count = document.querySelectorAll('.bot-card.running').length;
        activeEl.textContent = count;
        activeEl.style.color = count > 0 ? 'var(--accent)' : 'var(--text-muted)';
    }
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
        }
        badge.textContent = `SIGNAL ${type} · ${confidence.grade} (${confidence.score}%)`;
        badge.style.background = confidence.color + '22';
        badge.style.color = confidence.color;
        badge.style.border = `1px solid ${confidence.color}55`;
        clearTimeout(badge._timer);
        badge._timer = setTimeout(() => { badge.textContent = ''; badge.style.background = 'none'; badge.style.border = 'none'; }, 60000);
    }
};

window.registerBotWin = function(id, pnl) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const bot = bots[id];
    if (bot) { bot.wins++; bot.pnl += pnl; }
    const winsEl = card.querySelector('.bot-wins');
    const pnlEl = card.querySelector('.bot-pnl');
    if (winsEl && bot) winsEl.textContent = bot.wins;
    if (pnlEl && bot) {
        pnlEl.textContent = bot.pnl.toFixed(2);
        pnlEl.style.color = bot.pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
};

window.registerBotLoss = function(id, pnl) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return;
    const bot = bots[id];
    if (bot) { bot.losses++; bot.pnl -= pnl; }
    const lossEl = card.querySelector('.bot-losses');
    const pnlEl = card.querySelector('.bot-pnl');
    if (lossEl && bot) lossEl.textContent = bot.losses;
    if (pnlEl && bot) {
        pnlEl.textContent = bot.pnl.toFixed(2);
        pnlEl.style.color = bot.pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
};

window._botQualityModes = window._botQualityModes || {};
window.QUALITY_MODE_DESCRIPTIONS = {
    0: { name: 'QUANTITY', emoji: '🚀', minScore: 55 },
    1: { name: 'BALANCED', emoji: '⚖️', minScore: 65 },
    2: { name: 'QUALITY', emoji: '🎯', minScore: 75 },
    3: { name: 'ULTRA', emoji: '👑', minScore: 85 }
};




function handleTradeEvent(event) {
    if (event.type === 'signal' && event.signal) {
        registerBotSignal(event.botId, event.signal.type, event.signal.entry, event.signal.label, event.signal.confidence);
    }
    if (event.trade) {
        const trades = [event.trade, ...(SessionState.get().trades || [])].slice(0, 200);
        SessionState.set({ trades });
        Analytics.recordTrade();
        Auth.syncTrades([event.trade]);
    }
}

// ─── LOGOUT ──────────────────────────────────────────────────────────────

function logout() {
    api?.forgetAll();
    api?.disconnect();
    Storage.clearToken();
    authorised = false;
    Object.keys(bots).forEach(id => delete bots[id]);
    SessionState.set({ connected: false, mt5Connected: false, activeBots: 0, botConfigs: [] });
    document.documentElement.removeAttribute('data-authed');
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('api-token').value = '';
    document.getElementById('connection-indicator').className = 'status-dot status-offline';
    document.getElementById('conn-label').textContent = 'Offline';
    document.getElementById('mt5-indicator').className = 'status-dot status-offline';
    const botList = document.getElementById('bot-list');
    if (botList) botList.innerHTML = '';
    Object.keys(bots).forEach(id => ChartManager.removeBot(id));
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph) ph.style.display = 'flex';
    log('Logged out', 'warn');
}

// ─── INITIALIZATION ──────────────────────────────────────────────────────

async function init() {
    console.log("%c🚀 Signal Bot initializing...", "color: violet; font-weight: bold");

    // Load strategies
    try {
        await buildStrategyGroups();
        console.log(`✅ Loaded ${Object.keys(STRATEGY_MODULES).length} strategies`);
    } catch (error) {
        console.error('Failed to load strategies:', error);
    }

    // Hydrate trades from cloud before wiring up the rest of the UI
    await SessionState.hydrateFromCloud();

    // ─── DERIV API CONNECTION ──────────────────────────────
    const APP_ID      = Settings.get('appId')      || '33XjcwFHStlck2fOZ3IND';
    const TOKEN       = Settings.get('apiToken')   || '';
    const ACCOUNT_ID  = Settings.get('accountId')  || '';
    const ACCOUNT_TYPE = Settings.get('accountType') || 'demo';

    if (!TOKEN) {
        log('No API token configured. Go to Settings and enter your Deriv token.', 'error');
        return;
    }
    if (!ACCOUNT_ID) {
        log('No Account ID configured. Go to Settings and enter your Deriv Account ID.', 'error');
        return;
    }

    api = new DerivAPI(APP_ID, handleData);
    
    try {
        await api.connect(TOKEN, ACCOUNT_ID, ACCOUNT_TYPE);
        console.log('✅ Deriv API connected successfully!');
        log('✅ Connected to Deriv API', 'success');
        
        document.documentElement.setAttribute('data-authed', '1');
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('connection-indicator').className = 'status-dot status-online';
        document.getElementById('conn-label').textContent = 'Online';
        
        setTimeout(() => api.fetchActiveSymbols(), 1000);
    } catch (error) {
        console.error('❌ Failed to connect:', error);
        log('❌ Connection failed: ' + error.message, 'error');
    }
    
    window.api = api;

    // ─── WEBSOCKET FOR MT5 BRIDGE ──────────────────────────
    // connectRenderWebSocket(); // Comment out if not using MT5

    // ─── CHART MANAGER ─────────────────────────────────────
    initChartManager();

    // ─── AI CONNECTION ─────────────────────────────────────
    setTimeout(checkAIServer, 800);
    
    // ─── POSITION SIZING ──────────────────────────────────
    PositionSizing.init(10000);
    PositionSizing.resetSession(10000);

    // ─── UI SETUP ──────────────────────────────────────────
    document.getElementById('btn-login').onclick = () => {
        const t = document.getElementById('api-token').value.trim();
        if (!t) return alert('Token required');
        Storage.saveToken(t);
        api.connect(t, ACCOUNT_ID);
    };

    document.getElementById('btn-logout').onclick = logout;
    document.getElementById('btn-add-bot').onclick = () => _createBotCard(Date.now(), null);

    _initOverlayPanel();
    _restoreBotCards();

    // ─── START STATUS UPDATES ─────────────────────────────
    startStatusUpdates();

    // ─── HEARTBEAT ──────────────────────────────────────────
    // Confirms the tab/JS loop is alive, independent of Deriv connection
    // state. Read by nav.js on every page to render the liveness badge.
    SessionState.set({ heartbeatAt: Date.now() });
    setInterval(() => {
        SessionState.set({ heartbeatAt: Date.now() });
    }, 5000);

    // ─── LOG STARTUP COMPLETE ─────────────────────────────
    log('🚀 Signal Bot ready! Add a bot and start trading.', 'success');
    console.log(`✅ Signal Bot initialized with ${Object.keys(bots).length} bots`);
}
// ─── EXPOSE TO WINDOW ─────────────────────────────────────────────────────

window.bots = bots;
window.startBot = startBot;
window.stopBot = stopBot;
window.focusBot = focusBot;
window.getBotConfig = getBotConfig;
window.setBotRunning = setBotRunning;
window.setBotOnline = setBotOnline;
window.registerBotSignal = registerBotSignal;
window.registerBotWin = registerBotWin;
window.registerBotLoss = registerBotLoss;
window._botQualityModes = window._botQualityModes || {};
window.QUALITY_MODE_DESCRIPTIONS = window.QUALITY_MODE_DESCRIPTIONS || {};
window.strategyLoader = strategyLoader;
window.STRATEGY_MODULES = STRATEGY_MODULES;
window.STRATEGY_GROUPS = STRATEGY_GROUPS;

function log(msg, type = 'neutral') { UIManager.log(msg, type); }

// ─── START ─────────────────────────────────────────────────────────────────

// Check readyState directly rather than assuming DOMContentLoaded hasn't
// fired yet — with top-level awaits removed above this should no longer
// race, but this is a safe belt-and-suspenders guard regardless.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}