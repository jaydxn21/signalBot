// signal-bot.js — Multi-instance runner v3.0 (WebSocket Integrated)
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
// WEBSOCKET CONNECTION TO RENDER
// ─────────────────────────────────────────────────────────────
let renderWS = null;
let pendingSignals = [];

function connectRenderWebSocket() {
    if (renderWS && (renderWS.readyState === WebSocket.OPEN || renderWS.readyState === WebSocket.CONNECTING)) {
        return;
    }

    console.log('[WS] Connecting to Render WebSocket...');
    renderWS = new WebSocket('wss://nexus-api-khvt.onrender.com/mt5');

    renderWS.onopen = () => {
        console.log('✅ WebSocket connected to Render');
        log('Connected to MT5 bridge', 'info');
        const indicator = document.getElementById('mt5-indicator');
        if (indicator) indicator.className = 'status-dot status-online';
        SessionState.set({ mt5Connected: true });
        
        // Flush any pending signals
        if (pendingSignals.length > 0) {
            console.log(`📤 Flushing ${pendingSignals.length} pending signals...`);
            pendingSignals.forEach(signal => {
                if (renderWS && renderWS.readyState === WebSocket.OPEN) {
                    renderWS.send(JSON.stringify(signal));
                }
            });
            pendingSignals = [];
        }
    };

    renderWS.onerror = (err) => {
        console.error('WebSocket error:', err);
        const indicator = document.getElementById('mt5-indicator');
        if (indicator) indicator.className = 'status-dot status-offline';
    };

    renderWS.onclose = () => {
        console.log('WebSocket disconnected, reconnecting in 5s...');
        const indicator = document.getElementById('mt5-indicator');
        if (indicator) indicator.className = 'status-dot status-offline';
        setTimeout(connectRenderWebSocket, 5000);
    };

    renderWS.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'trade_result') {
                log(`MT5 Trade Result: ${data.outcome} ${data.symbol} P&L: ${data.pnl}`, 'info');
            } else if (data.action) {
                console.log('📨 Signal confirmation from bridge:', data);
            }
        } catch(e) {
            console.log('WebSocket message:', event.data);
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
    { label: '🌀 VORTEX', desc: 'All symbols — trades volatility itself', strategies: [{ value: 'vortex', label: 'VORTEX (Any Symbol)' }] },
    { label: '👻 PHANTOM', desc: 'Daily target — high confidence only', strategies: [{ value: 'phantom', label: 'PHANTOM (Daily Target)' }] },
    { label: '💥 Crash & Boom', desc: 'Crash 1000, Boom 1000', strategies: [{ value: 'nova', label: 'NOVA (Crash & Boom)' }, { value: 'pulse', label: 'PULSE (Compounder)' }, { value: 'kismet', label: 'KISMET (Structure)' }] },
    { label: '⚡ Synthetic Indices', desc: 'R_100, R_75, 1HZ100V etc.', strategies: [{ value: 'synthetic_scalp', label: 'BB+RSI Synthetic' }, { value: 'ultra_scalp', label: 'Ultra Scalper' }, { value: 'candle_speed', label: 'Candle Speed' }, { value: 'range_boundary', label: 'Range Boundary' }, { value: 'rsi_fade', label: 'RSI Fade Scalper' }] },
    { label: '💱 Forex Pairs', desc: 'EURUSD, GBPUSD, USDJPY etc.', strategies: [{ value: 'momentum', label: 'Momentum Scalper' }, { value: 'h4_kiss', label: 'KISS H4' }, { value: 'london_breakout', label: 'London Breakout' }, { value: 'news_fade', label: 'News Fade' }, { value: 'vwap_reversion', label: 'VWAP Reversion' }, { value: 'swing', label: 'Swing' }, { value: 'trend', label: 'Trend Follow' }, { value: 'orb', label: 'ORB' }] },
    { label: '₿ Crypto', desc: 'BTCUSD, ETHUSD etc.', strategies: [{ value: 'crypto_scalp', label: 'Crypto Scalper' }, { value: 'momentum', label: 'Momentum Scalper' }, { value: 'rsi_fade', label: 'RSI Fade Scalper' }, { value: 'swing', label: 'Swing' }, { value: 'cipher', label: 'CIPHER (BTC Structure)' }] },
    { label: '🥇 Commodities', desc: 'XAUUSD, XAGUSD', strategies: [{ value: 'momentum', label: 'Momentum Scalper' }, { value: 'h4_kiss', label: 'KISS H4' }, { value: 'vwap_reversion', label: 'VWAP Reversion' }, { value: 'trend', label: 'Trend Follow' }, { value: 'swing', label: 'Swing' }] },
    { label: '🦘 Jump Indices', desc: 'JD10, JD25, JD75, JD100', strategies: [{ value: 'jump75', label: 'JUMP75 (Multi-TF)' }, { value: 'scalp', label: 'Classic Scalp' }, { value: 'ultra_scalp', label: 'Ultra Scalper' }, { value: 'range_boundary', label: 'Range Boundary' }, { value: 'rsi_fade', label: 'RSI Fade Scalper' }] },
];

const STRATEGY_OPTIONS = STRATEGY_GROUPS.flatMap(g => g.strategies);

const TF_LABEL = { 60:'M1', 120:'M2', 300:'M5', 600:'M10', 900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1' };

// ─────────────────────────────────────────────────────────────
// POINT VALUE HELPER
// ─────────────────────────────────────────────────────────────
function _pointValue(symbol) {
    const MAP = {
        'CRASH1000': 0.41, 'CRASH_1000': 0.41, 'BOOM1000': 0.41, 'BOOM_1000': 0.41,
        'CRASH500': 0.41, 'BOOM500': 0.41, 'CRASH_500': 0.41, 'BOOM_500': 0.41,
        'cryBTCUSD': 0.01, 'BTCUSD': 0.01,
        'JD10': 0.41, 'JD25': 0.41, 'JD50': 0.41, 'JD75': 0.41, 'JD100': 0.41,
        'frxEURUSD': 10.0, 'frxGBPUSD': 10.0, 'frxUSDJPY': 9.35, 'frxAUDUSD': 10.0,
        'frxUSDCAD': 10.0, 'frxUSDCHF': 10.0, 'frxEURGBP': 12.50, 'frxGBPJPY': 12.50,
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
let api = null;
let symbolMap = {};
let focusedBotId = null;
let authorised = false;
const bots = {};

const MT5_SYMBOL_MAP = {
    'stpRNG': 'Step Index', 'STEP': 'Step Index',
    'Crash 1000 Index': 'Crash 1000 Index', 'Boom 1000 Index': 'Boom 1000 Index',
    'Crash 500 Index': 'Crash 500 Index', 'Boom 500 Index': 'Boom 500 Index',
    'Volatility 10 Index': 'Volatility 10 Index', 'Volatility 25 Index': 'Volatility 25 Index',
    'Volatility 50 Index': 'Volatility 50 Index', 'Volatility 75 Index': 'Volatility 75 Index',
    'Volatility 100 Index': 'Volatility 100 Index',
    'Jump 10 Index': 'Jump 10 Index', 'Jump 25 Index': 'Jump 25 Index',
    'Jump 50 Index': 'Jump 50 Index', 'Jump 75 Index': 'Jump 75 Index', 'Jump 100 Index': 'Jump 100 Index',
};

// ── PUSH NOTIFICATIONS ──────────────────────────────────────
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

// ── OVERLAY PANEL ───────────────────────────────────────────
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

// ── SAVE/RESTORE BOT CONFIGS ────────────────────────────────
function _saveBotConfigs() {
    const active = Object.values(bots).filter(b => b.isActive).map(b => ({ id: b.id, config: b.config }));
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
    });
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph && saved.length > 0) ph.style.display = 'none';
    const firstId = saved[0]?.id;
    if (firstId) { focusedBotId = firstId; }
}

// ── INIT ────────────────────────────────────────────────────
async function init() {
    // Connect WebSocket to Render
    connectRenderWebSocket();
    
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
    const winsEl = document.getElementById('stat-wins');
    const lossesEl = document.getElementById('stat-losses');
    const wrEl = document.getElementById('stat-winrate');
    if (winsEl) winsEl.textContent = restoredState.wins || 0;
    if (lossesEl) lossesEl.textContent = restoredState.losses || 0;
    if (wrEl) wrEl.textContent = restoredState.winRate ? `${restoredState.winRate}%` : '0%';

    document.getElementById('clear-logs')?.addEventListener('click', () => {
        const logs = document.getElementById('logs');
        const countEl = document.getElementById('log-count');
        if (logs) logs.innerHTML = '';
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

    document.getElementById('btn-logout').onclick = logout;
    document.getElementById('btn-add-bot').onclick = () => _createBotCard(Date.now(), null);

    _initOverlayPanel();
    _restoreBotCards();

    setInterval(() => {
        const hudWrap = document.getElementById('phantom-scan-hud');
        const hudEl = document.getElementById('phantom-scan-countdown');
        if (!hudEl || !hudWrap) return;
        const phantomBot = Object.values(bots).find(b => b.config?.strategy === 'phantom' && document.querySelector(`.bot-card[data-bot-id="${b.id}"]`)?.classList.contains('running'));
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
            const targetCard = document.querySelector('.bot-card.stopped') || document.querySelector('.bot-card');
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
}

// ─────────────────────────────────────────────────────────────
// START / STOP BOT
// ─────────────────────────────────────────────────────────────
window.startBot = function(id) {
    const config = window.getBotConfig(id);
    if (!config) return;

    const maxBots = Settings.get('maxBots') || 3;
    if (Object.values(bots).filter(b => b.isActive).length >= maxBots) { log(`Risk block: max ${maxBots} bots allowed.`, 'warn'); return; }

    const maxDailyLoss = Settings.get('maxDailyLoss') || 500;
    if (SessionState.get().sessionPnL <= -maxDailyLoss) { log(`Risk block: daily loss limit $${maxDailyLoss} reached.`, 'warn'); _showRiskAlert(`Daily loss limit of $${maxDailyLoss} reached.`); return; }

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
        if (bot.config.strategy === 'jump75') { api.forgetSymbol(bot.config.symbol, 300); api.forgetSymbol(bot.config.symbol, 900); }
    }

    ChartManager.removeBot(id);
    const engine = ChartManager.get(id);
    if (engine) { try { engine.clearAnalysis(); } catch(e) { console.warn('[Chart] Failed to clear analysis:', e.message); } }
    if (ChartManager.count() === 0) { const ph = document.getElementById('chart-placeholder-empty'); if (ph) ph.style.display = 'flex'; }
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
            ChartManager.loadMain(id, bot.candles);
            _drawBotAnalysis(id, bot);
            redrawOverlays();
            if (bot.openSignal) { const eng = ChartManager.mainEngine(); if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp); }
        }, 30);
    } else {
        _showOverlayPanel(true);
        _loadOverlayState(id);
        const engine = ChartManager.get(id);
        if (engine && bot.candles.length > 0) {
            engine.setData(bot.candles);
            engine.chart.timeScale().fitContent();
            _drawBotAnalysis(id, bot);
            redrawOverlays();
        }
    }
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
        }
    }
}

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
    }
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
// CREATE BOT CARD
// ─────────────────────────────────────────────────────────────
function _createBotCard(id, savedConfig) {
    const template = document.getElementById('bot-card-template');
    if (!template) { console.error('bot-card-template missing'); return; }
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.bot-card');
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
            labelEl.textContent = (SYMBOL_MAP[symbolSelect.value] || symbolSelect.value)
                .replace(' Index', '').trim();
        }
    };
    symbolSelect.addEventListener('change', updateLabel);
    updateLabel();

    const phantomPanel = card.querySelector('.phantom-settings');
    const tfSelect     = card.querySelector('.bot-tf-select');
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

    const configureBtn = card.querySelector('.phantom-configure-btn');
    if (configureBtn) {
        configureBtn.onclick = () => {
            const targetInput = card.querySelector('.phantom-target-input');
            const lossInput   = card.querySelector('.phantom-loss-input');
            const target = parseFloat(targetInput?.value) || 0;
            const loss   = parseFloat(lossInput?.value)   || 0;
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
        badge.style.color      = confidence.color;
        badge.style.border     = `1px solid ${confidence.color}55`;
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
    const pnlEl  = card.querySelector('.bot-pnl');
    if (winsEl && bot) winsEl.textContent = bot.wins;
    if (pnlEl  && bot) {
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
    const pnlEl  = card.querySelector('.bot-pnl');
    if (lossEl && bot) lossEl.textContent = bot.losses;
    if (pnlEl  && bot) {
        pnlEl.textContent = bot.pnl.toFixed(2);
        pnlEl.style.color = bot.pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
};

function log(msg, type = 'neutral') { UIManager.log(msg, type); };

document.addEventListener('DOMContentLoaded', init);
