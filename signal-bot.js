// signal-bot.js — Multi-instance runner v2.0
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

// Strategies grouped by compatible symbol type.
// Used to build categorized <optgroup> dropdowns in bot cards.
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
        desc:  'JD10, JD25, JD100 etc.',
        strategies: [
            { value: 'scalp',           label: 'Classic Scalp'     },
            { value: 'ultra_scalp',     label: 'Ultra Scalper'     },
            { value: 'range_boundary',  label: 'Range Boundary'    },
            { value: 'rsi_fade',        label: 'RSI Fade Scalper'  },
        ]
    },
];

// Flat list used where a simple array is still needed
const STRATEGY_OPTIONS = STRATEGY_GROUPS.flatMap(g => g.strategies);

const TF_LABEL = {
    60:'M1', 120:'M2', 300:'M5', 600:'M10',
    900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1'
};

// ─────────────────────────────────────────────────────────────
// BOT STATE CLASS
// ─────────────────────────────────────────────────────────────
class BotState {
    constructor(id, config) {
        this.id           = id;
        this.config       = config;
        this.candles      = [];
        this.h4Candles    = [];
        this.htfCandles   = [];   // real HTF candles for VORTEX HTF filter
        this.htfGran      = 14400; // HTF granularity in seconds (dynamic per TF)
        this.rsiState     = { prevAvgGain: 0, prevAvgLoss: 0, initialized: false };
        this.strategy     = new StrategyEngine();
        this.openSignal      = null;
        this.lastFiredMs     = 0;
        this.lastSLTimeMs    = 0;   // timestamp of last SL hit (for cooldown)
        this.lastSLBarIdx    = 0;   // candle index of last SL (for re-entry delay)
        this.h4KissCandidate = null; // {dir, bar} — first touch, waiting for confirmation
        this.isActive        = false;
        this.sessionStart    = null;
        this.wins            = 0;
        this.losses          = 0;
        this.pnl             = 0;
    }
}

// ─────────────────────────────────────────────────────────────
// SHARED SINGLETONS
// ─────────────────────────────────────────────────────────────
let api       = null;
let symbolMap = {};

// ── MT5 SYMBOL NAME MAP ───────────────────────────────────────
// Deriv's active_symbols display_name doesn't always match
// the exact symbol string in MT5 Market Watch.
// This map corrects known mismatches.
const MT5_SYMBOL_MAP = {
    // Deriv API key       → MT5 Market Watch name
    'stpRNG':              'Step Index',
    'STEP':                'Step Index',
    // Deriv display names (from active_symbols) → MT5 names
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
// Per-bot overlay selections stored in overlayState[botId]
// Panel only visible in focus mode; selections persist in split mode
// ─────────────────────────────────────────────────────────────
const OVERLAY_IDS = ['show-asian','show-pdhpdl','show-fvg','show-h4','show-major','show-orb','show-ob','show-bos'];
const overlayState = {}; // botId → { 'show-asian': bool, ... }

function _initOverlayPanel() {
    // Wire each checkbox to save state + redraw
    OVERLAY_IDS.forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            if (focusedBotId) _saveOverlayState(focusedBotId);
            redrawOverlays();
        });
    });

    // Collapse / expand toggle
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
// Persists active bot configs to SessionState so they survive
// navigation back to the terminal page.
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

    // ── Cloud restore: pull server trades into localStorage on login ───────
    // Only runs if this is a fresh session (no local trades yet today)
    if (!Auth.isGuest()) {
        const localTrades = SessionState.get().trades || [];
        if (localTrades.length === 0) {
            Auth.fetchTrades().then(serverTrades => {
                if (serverTrades?.length) {
                    SessionState.set({ trades: serverTrades });
                    log(`Restored ${serverTrades.length} trades from cloud`, 'info');
                    Analytics.init(); // re-render analytics with restored data
                }
            }).catch(() => {});
        }
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Restore persisted session P&L display ──────────────────
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
    // ─────────────────────────────────────────────────────────

    document.getElementById('clear-logs')?.addEventListener('click', () => {
        const logs    = document.getElementById('logs');
        const countEl = document.getElementById('log-count');
        if (logs)    logs.innerHTML      = '';
        if (countEl) countEl.textContent = '0 events';
    });

    const token = Storage.getToken();
    if (token) {
        // Token exists — overlay stays hidden (CSS default), connect immediately
        api.connect(token);
    } else {
        // No token — remove data-authed so overlay becomes visible
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

    document.getElementById('btn-logout').onclick  = logout; // nav.js also wires this; signal-bot keeps Deriv disconnect
    document.getElementById('btn-add-bot').onclick = () => _createBotCard(Date.now(), null);

    // Overlay panel — wire checkboxes and collapse toggle
    _initOverlayPanel();

    // Restore any bots that were running before navigation
    _restoreBotCards();

    // ── PHANTOM SCAN COUNTDOWN ────────────────────────────────
    // Ticks every second. Finds the active PHANTOM bot, calculates
    // seconds until the next candle closes, and updates the HUD.
    setInterval(() => {
        const hudWrap    = document.getElementById('phantom-scan-hud');
        const hudEl      = document.getElementById('phantom-scan-countdown');
        if (!hudEl || !hudWrap) return;

        // Find a running PHANTOM bot
        const phantomBot = Object.values(bots).find(b =>
            b.config?.strategy === 'phantom' &&
            document.querySelector(`.bot-card[data-bot-id="${b.id}"]`)?.classList.contains('running')
        );

        if (!phantomBot) {
            hudWrap.style.display = 'none';
            return;
        }

        const session = PhantomStrategy.getSession();

        // If halted, show status instead of countdown
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

        // If a trade is open, show trailing status
        if (phantomBot.openSignal?.isPhantom) {
            hudWrap.style.display = 'flex';
            const trailLabel = phantomBot.openSignal.scaleOutDone ? 'TRAILING ½' : 'IN TRADE';
            hudEl.textContent = trailLabel;
            hudEl.style.color = '#34d399';
            return;
        }

        // Calculate time to next candle close
        const tf = phantomBot.config.tf || 300; // seconds
        const lastCandle = phantomBot.candles?.[phantomBot.candles.length - 1];
        if (!lastCandle) {
            hudWrap.style.display = 'none';
            return;
        }

        // lastCandle.time is the open time of the current forming candle (unix seconds)
        const candleCloseAt = (lastCandle.time + tf) * 1000; // ms
        const secsLeft = Math.max(0, Math.round((candleCloseAt - Date.now()) / 1000));

        const mins = String(Math.floor(secsLeft / 60)).padStart(2, '0');
        const secs = String(secsLeft % 60).padStart(2, '0');

        hudWrap.style.display = 'flex';
        hudEl.style.color = secsLeft <= 10 ? '#fbbf24' : '#a78bfa'; // amber flash in last 10s
        hudEl.textContent = secsLeft === 0 ? 'SCANNING…' : `${mins}:${secs}`;
    }, 1000);

    // ── DEPLOY FROM STRATEGY BUILDER ──────────────────────────
    const deployRaw = sessionStorage.getItem('nexus_deploy_bot');
    if (deployRaw) {
        sessionStorage.removeItem('nexus_deploy_bot');
        try {
            const payload = JSON.parse(deployRaw);

            // Update overlay label with strategy name
            const labelEl = document.getElementById('deploy-label');
            if (labelEl) labelEl.textContent = `Deploying "${payload.name || payload.strategy}"…`;

            const id = Date.now();
            _createBotCard(id, payload);
            log(`Strategy "${payload.name || payload.strategy}" deployed from Builder — configure and start.`, 'info');

            // Flash card + dismiss overlay
            setTimeout(() => {
                const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
                if (card) {
                    card.style.transition = 'box-shadow 0.3s';
                    card.style.boxShadow = '0 0 0 2px #8b5cf6';
                    setTimeout(() => { card.style.boxShadow = ''; }, 2000);
                }
                // Fade out overlay
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

    // ── QUICK SYMBOL FROM MARKET PAGE ─────────────────────────
    const quickSym = sessionStorage.getItem('nexus_quick_sym');
    if (quickSym) {
        sessionStorage.removeItem('nexus_quick_sym');
        setTimeout(() => {
            // Prefer a stopped card; if none, create one
            const targetCard = document.querySelector('.bot-card.stopped') ||
                               document.querySelector('.bot-card');

            if (!targetCard) {
                const id = Date.now();
                _createBotCard(id, { strategy: 'momentum', symbol: quickSym, tf: 300 });
                log(`New bot created from Market with symbol ${quickSym}`, 'info');
                return; // savedConfig already sets symbol during card creation
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

    // ── RISK MANAGEMENT CHECKS ────────────────────────────────
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
    // ─────────────────────────────────────────────────────────

    const bot        = new BotState(id, config);
    bots[id]         = bot;
    bot.isActive     = true;
    bot.sessionStart = Date.now();

    window.setBotRunning(id, true);
    UIManager.startSession();
    log(`Bot #${id} started — ${config.strategy} on ${config.symbol} ${TF_LABEL[config.tf] || 'M5'}`, 'info');

    // Create chart panel for this bot
    const symLabel = (SYMBOL_MAP[config.symbol] || config.symbol).replace(' Index','').trim();
    ChartManager.addBot(id, symLabel, TF_LABEL[config.tf] || 'M5');
    // Hide empty placeholder
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
};

window.stopBot = function(id) {
    const bot = bots[id];
    if (!bot) return;
    bot.isActive = false;
    window.setBotRunning(id, false);
    log(`Bot #${id} stopped`, 'neutral');

    // Release Deriv subscriptions so restart doesn't get "already subscribed"
    if (bot.config?.symbol) {
        api.forgetSymbol(bot.config.symbol, bot.config.tf);
        api.forgetSymbol(bot.config.symbol, 14400); // H4
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

    // Always update HUD labels
    document.getElementById('chart-symbol-label').textContent = symLabel;
    document.getElementById('chart-tf-label').textContent     = tfLabel;
    ChartManager.updateLabel(id, symLabel, tfLabel);

    if (ChartManager.count() > 1) {
        // Switch to focus mode — shows #chart-main-wrap
        ChartManager.focus(id);
        _loadOverlayState(id);   // restore this bot's overlay selections
        _showOverlayPanel(true); // show overlay panel in focus mode
        // Load this bot's candles into the main engine
        setTimeout(() => {
            ChartManager.loadMain(id, bot.candles);
            redrawOverlays();
            // Restore open signal markers if this bot has an active trade
            if (bot.openSignal) {
                const eng = ChartManager.mainEngine();
                if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
            }
        }, 30);
    } else {
        // Single bot — show overlay panel always
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

// Called when user clicks Split View — hide overlay panel
window.onSplitView = function() {
    _showOverlayPanel(false);
};

// Get the correct ChartEngine for a bot — main engine if focused, split engine otherwise
function _engineFor(botId) {
    if (!ChartManager.isSplitMode() && botId === focusedBotId) {
        return ChartManager.mainEngine();
    }
    return ChartManager.get(botId);
}

function subscribeBot(bot) {
    Notify.request();
    // HTF granularity: dynamic based on entry TF
    const HTF_GRAN_MAP = {60:1800, 120:3600, 180:3600, 300:3600, 600:7200, 900:14400, 1800:14400, 3600:86400, 14400:604800};
    bot.htfGran = (bot.config.strategy === 'vortex' || bot.config.strategy === 'phantom')
        ? (HTF_GRAN_MAP[bot.config.tf] || 3600)
        : 14400; // all other strategies use H4
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

        // If H4 subscription fails, bot can still run on main TF — don't stop it
        // If main TF fails, the symbol/account type is incompatible
        if (req.granularity && req.granularity !== 14400) {
            // Main TF failed — mark affected bots as needing attention
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
        const history = data.candles.map(c => ({
            time:  parseInt(c.epoch),
            open:  parseFloat(c.open),
            high:  parseFloat(c.high),
            low:   parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        Object.values(bots).forEach(bot => {
            if (!bot.isActive) return;
            // Only accept history for symbols this bot is subscribed to
            if (gran === 14400 && data.echo_req.ticks_history === bot.config.symbol) {
                bot.h4Candles = history;
            }
            if (gran === bot.htfGran && data.echo_req.ticks_history === bot.config.symbol) {
                bot.htfCandles = history;
                if (bot.config.strategy === 'vortex') VortexStrategy.setHtfCandles(bot.id, history);
            }
            if (gran === bot.config.tf && data.echo_req.ticks_history === bot.config.symbol) {
                bot.candles = history;
                const eng = ChartManager.get(bot.id);
                if (eng) {
                    eng.setData(history);
                    if (bot.id === focusedBotId) redrawOverlays();
                    else if (ChartManager.isSplitMode()) {
                        // Draw this bot's overlays on its own panel
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
            // Only send bar to bots subscribed to this exact symbol
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

    if (gran !== bot.config.tf) return;

    const last = bot.candles[bot.candles.length - 1];
    if (last && last.time === bar.time) bot.candles[bot.candles.length - 1] = bar;
    else bot.candles.push(bar);
    if (bot.candles.length > 1000) bot.candles.shift();

    // Update whichever engine is active for this bot
    const activeEng = _engineFor(bot.id);
    if (activeEng) activeEng.update(bar);

    // In focus mode also keep the split engine data current (for when returning to split)
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
    // Also update single-mode HUD if this bot is focused
    if (bot.id === focusedBotId) UIManager.updateHUD(rsi, atr, marketCond);

    // Push live price to SessionState for market page
    const livePrices = SessionState.get().livePrices || {};
    const displaySym = SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
    const firstClose = bot.candles[0]?.close;
    livePrices[displaySym] = {
        price:  bar.close,
        change: firstClose ? parseFloat(((bar.close - firstClose) / firstClose * 100).toFixed(2)) : 0,
    };
    SessionState.set({ livePrices });

    checkOutcome(bot);

    // ── PHANTOM — dedicated routing ───────────────────────────
    if (bot.config.strategy === 'phantom') {
        _runPhantom(bot, bar, atr, rsi);
        return;
    }

    // ── NOVA — dedicated routing ──────────────────────────────
    if (bot.config.strategy === 'nova') {
        _runNova(bot, bar, atr, rsi);
        return;
    }

    // ── PULSE — dedicated routing ─────────────────────────────
    if (bot.config.strategy === 'pulse') {
        _runPulse(bot, bar, atr, rsi);
        return;
    }

    // ── KISMET — dedicated routing ────────────────────────────
    if (bot.config.strategy === 'kismet') {
        _runKismet(bot, bar, atr, rsi);
        return;
    }

    // ── VORTEX — dedicated routing ────────────────────────────
    if (bot.config.strategy === 'vortex') {
        _runVortex(bot, bar, atr, rsi);
        return;
    }

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

        // ── REC 1: VWAP REVERSION — H4 bullish confirmation for BUY signals ──
        // BUY signals had 33% WR vs SELL 80% WR. Only allow BUY if H4 trend is bullish.
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

        // ── REC 2: RANGE BOUNDARY — 30-min cooldown after SL ──
        // Three consecutive SLs in session from rapid re-entry after losses.
        if (bot.config.strategy === 'range_boundary') {
            const msSinceLastSL = now - bot.lastSLTimeMs;
            const COOLDOWN_MS   = 30 * 60 * 1000; // 30 minutes
            if (bot.lastSLTimeMs > 0 && msSinceLastSL < COOLDOWN_MS) {
                const minsLeft = Math.ceil((COOLDOWN_MS - msSinceLastSL) / 60000);
                log(`Range Boundary cooldown — ${minsLeft}m remaining after last SL`, 'neutral');
                return;
            }
        }

        // ── REC 3: H4 KISS — require 2 confirmation bars before entry ──
        // All 3 losses entered on first touch of level. Wait for close beyond level + pullback.
        if (bot.config.strategy === 'h4_kiss') {
            if (bot.h4Candles.length >= 21) {
                const k     = 2 / 22;
                let h4ema   = bot.h4Candles.slice(0,21).reduce((s,c)=>s+c.close,0) / 21;
                for (let i = 21; i < bot.h4Candles.length; i++)
                    h4ema = bot.h4Candles[i].close * k + h4ema * (1 - k);

                const candidate = bot.h4KissCandidate;
                const isNearKiss = Math.abs(bar.close - h4ema) < atr * 0.8;

                if (!candidate && isNearKiss) {
                    // First touch — record candidate, don't fire yet
                    bot.h4KissCandidate = { dir: signal.type, bar: bar.time };
                    log(`H4 Kiss first touch @ ${bar.close.toFixed(4)} — waiting for confirmation bar`, 'neutral');
                    return;
                } else if (candidate) {
                    // Second touch in same direction — confirmed, fire and clear
                    if (candidate.dir !== signal.type) {
                        // Direction changed — reset candidate
                        bot.h4KissCandidate = null;
                        return;
                    }
                    bot.h4KissCandidate = null; // clear after confirmed fire
                    log(`H4 Kiss confirmed (2-bar) @ ${bar.close.toFixed(4)}`, 'info');
                    // fall through to fire
                } else {
                    // Signal not near kiss level — don't fire
                    return;
                }
            }
        }

        // ── REC 4: SYNTHETIC SCALP — 1-candle re-entry delay after SL ──
        // Two near-identical entries 2 minutes apart. Enforce minimum 1 complete bar wait.
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
// FIRE SIGNAL
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// PHANTOM MULTI-TF CANDLE BUFFERS
// ─────────────────────────────────────────────────────────────
const _phantomBuffers = {};

function _getPhantomBuffers(botId) {
    if (!_phantomBuffers[botId]) _phantomBuffers[botId] = { m1: [], m5: [], m15: [] };
    return _phantomBuffers[botId];
}

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
            }
        }
        return Object.values(buckets).sort((a, b) => a.time - b.time);
    }

    buf.m1  = _resample(candles, 60);
    buf.m5  = _resample(candles, 300);
    buf.m15 = _resample(candles, 900);
    return buf;
}

// ─────────────────────────────────────────────────────────────
// PHANTOM RUNNER
// ─────────────────────────────────────────────────────────────
function _runPhantom(bot, bar, atr, rsi) {
    const session = PhantomStrategy.getSession();
    _updatePhantomBadge(bot.id, session);

    if (session.mode === 'halted') return;

    const observerOnly = (session.mode === 'observer');

    // ── TRAILING STOP + REVERSAL EXIT ────────────────────
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
        }
        return;
    }

    if (bot.openSignal) return;

    // ── COOLDOWN: 2 candles on the bot's own TF ───────────────
    const now = Date.now();
    const cooldownMs = 2 * (bot.config.tf || 300) * 1000;
    if ((now - bot.lastFiredMs) < cooldownMs) return;

    // ── BUILD MULTI-TF BUFFERS & CHECK ENTRY ─────────────────
    const buf    = _buildPhantomTFBuffers(bot);
    const signal = PhantomStrategy.checkEntry(buf.m1, buf.m5, buf.m15, bot.id);
    if (!signal) return;

    if (observerOnly) {
        log(`👻 PHANTOM [OBSERVER] ${signal.type} @ ${bar.close.toFixed(4)} [${signal.tfNames} ${signal.score}] — target hit, watching`, 'neutral');
        return;
    }

    bot.lastFiredMs = now;
    log(`👻 PHANTOM ${signal.type} @ ${bar.close.toFixed(4)} — ${signal.tfNames} | score ${signal.score} | ${signal.tfCount} TF${signal.tfCount > 1 ? 's' : ''}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.factors.length) log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');

    fireSignal(bot, signal, bar, atr, rsi, null);
}

// ─────────────────────────────────────────────────────────────
// NOVA RUNNER
// ─────────────────────────────────────────────────────────────

// Shared TF buffer builder (same resample logic as PHANTOM)
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
            }
        }
        return Object.values(buckets).sort((a, b) => a.time - b.time);
    }
    return { m1: _resample(candles, 60), m5: _resample(candles, 300), m15: _resample(candles, 900) };
}

function _runNova(bot, bar, atr, rsi) {
    const symCfg = novaSymbolConfig(bot.config.symbol);
    if (!symCfg) {
        log(`NOVA: ${bot.config.symbol} is not a supported Crash/Boom symbol`, 'warn');
        return;
    }

    // ── SPIKE DETECTION on every candle ──────────────────────
    const spike = detectSpike(bot.candles, atr);
    if (spike) {
        NovaStrategy.recordSpike(bot.id, spike, bot.config.tf || 300);
        log(`💥 NOVA spike detected — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR on ${symCfg.name}`, 'neutral');

        // If a trade is open and spike goes against us — emergency exit
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
            }
        }
    }

    // ── MANAGE OPEN TRADE ────────────────────────────────────
    if (bot.openSignal?.isNova) {
        _applyTrailingStop(bot, atr);
        return;
    }

    if (bot.openSignal) return;

    // ── COOLDOWN after spike ──────────────────────────────────
    if (NovaStrategy.inCooldown(bot.id)) return;

    // ── COOLDOWN after last trade ─────────────────────────────
    const now = Date.now();
    const cooldownMs = 2 * (bot.config.tf || 300) * 1000;
    if ((now - bot.lastFiredMs) < cooldownMs) return;

    // ── BUILD MULTI-TF BUFFERS & ENTRY CHECK ─────────────────
    const buf    = _buildNovaTFBuffers(bot);
    const spikeState = NovaStrategy.getSpikeState(bot.id);
    const recentSpike = spikeState.spike || null;

    const signal = NovaStrategy.checkEntry(bot.config.symbol, buf.m1, buf.m5, buf.m15, recentSpike);
    if (!signal) return;

    bot.lastFiredMs = now;
    log(`💥 NOVA ${signal.type} @ ${bar.close.toFixed(4)} — ${signal.tfNames} | score ${signal.score} | ${signal.tfCount} TF${signal.tfCount > 1 ? 's' : ''}`, signal.type === 'BUY' ? 'buy' : 'sell');
    if (signal.factors.length) log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');

    fireSignal(bot, signal, bar, atr, rsi, null);
}

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
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'nova',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    bot.openSignal = null;
}

// ─────────────────────────────────────────────────────────────
// PULSE — RUN + CLOSE
// ─────────────────────────────────────────────────────────────
function _runPulse(bot, bar, atr, rsi) {
    const cfg = pulseSymbolConfig(bot.config.symbol);
    if (!cfg) {
        log(`PULSE: ${bot.config.symbol} not supported. Use Boom 1000, Crash 1000, or Step Index.`, 'warn');
        return;
    }

    // ── SPIKE DETECTION (Crash/Boom only) ────────────────────
    if (cfg.type === 'crash_boom') {
        const spike = detectSpike(bot.candles, atr);
        if (spike) {
            PulseStrategy.recordSpike(bot.id, spike, bot.config.tf || 60);
            log(`⚡ PULSE spike — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR`, 'neutral');
            // Emergency exit if spike hits our open trade adverse
            if (bot.openSignal?.isPulse) {
                const c = bot.candles[bot.candles.length - 2];
                const adverse = (bot.openSignal.type === 'BUY'  && spike.direction === 'down')
                             || (bot.openSignal.type === 'SELL' && spike.direction === 'up');
                if (adverse) {
                    log(`⚡ PULSE spike exit`, 'warn');
                    const stake  = bot.config.stake || PulseStrategy.getCurrentStake(bot.id);
                    const pnlAmt = stake * (bot.openSignal.slMultiplier || 1.0);
                    _pulseCloseTrade(bot, 'SL', pnlAmt, c);
                    return;
                }
            }
        }
    }

    if (bot.openSignal?.isPulse) {
        _applyTrailingStop(bot, atr);
        return;
    }
    if (bot.openSignal) return;
    if (PulseStrategy.inCooldown(bot.id)) return;

    // ── COOLDOWN between trades ───────────────────────────────
    const cooldownMs = (bot.config.tf || 60) * 2 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    // Check session mode
    if (PulseStrategy.getMode() !== 'active') {
        const mode = PulseStrategy.getMode();
        if (mode === 'target_hit') log('⚡ PULSE target reached — session complete', 'buy');
        if (mode === 'halted')     log('⚡ PULSE halted — daily loss limit hit', 'warn');
        return;
    }

    // ── ENTRY CHECK ───────────────────────────────────────────
    const spikeState  = PulseStrategy.getSpikeState(bot.id);
    const recentSpike = spikeState.spike || null;
    const signal      = PulseStrategy.checkEntry(bot.config.symbol, bot.candles, recentSpike);
    if (!signal) return;

    // Use the compounded stake from the session
    const stake = bot.config.stake || PulseStrategy.getCurrentStake(bot.id);
    signal.stake = stake;

    bot.lastFiredMs = Date.now();
    const level = signal.compoundLevel;
    log(`⚡ PULSE ${signal.type} @ ${bar.close.toFixed(4)} | stake $${stake.toFixed(2)} | level ${level} | ${signal.factors.join(' · ')}`, signal.type === 'BUY' ? 'buy' : 'sell');

    fireSignal(bot, signal, bar, atr, rsi, null);
}

function _pulseCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;

    const session = PulseStrategy.recordTrade(bot.id, outcome, pnlAmt);
    const newStake = session.currentStake;
    const level    = session.compoundLevel;

    if (outcome === 'TP') {
        log(`⚡ PULSE ✓ +$${pnlAmt.toFixed(2)} | next stake $${newStake.toFixed(2)} | level ${level} | total $${session.realizedPnL.toFixed(2)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'pulse', type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
        Notify.outcome(type, 'TP', bot.config.symbol, pnlAmt);
    } else {
        log(`⚡ PULSE ✗ -$${pnlAmt.toFixed(2)} | stake reset $${newStake.toFixed(2)} | total $${session.realizedPnL.toFixed(2)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'pulse', type, entry, sl, tp, outcome: 'SL', pnl: pnlAmt });
        Notify.outcome(type, 'SL', bot.config.symbol, pnlAmt);
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'pulse',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    bot.openSignal = null;
}

// ─────────────────────────────────────────────────────────────
// VORTEX — RUN + CLOSE
// ─────────────────────────────────────────────────────────────
function _vortexBaseline(bot) {
    // Compute baseline ATR from candle history for vol ratio
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
        }
        if (trs.length === 10) samples.push(trs.reduce((a, b) => a + b) / 10);
    }
    return samples.length ? samples.reduce((a, b) => a + b) / samples.length : null;
}

function _runVortex(bot, bar, atr, rsi) {
    if (!atr) return;

    // Register entry TF and news settings on every bar (cheap, ensures always current)
    const tfMins = bot.config.tf ? Math.round(bot.config.tf / 60) : 5;
    VortexStrategy.setTf(bot.id, tfMins);
    VortexStrategy.setNewsOptions(bot.id, {
        newsBlackout: Settings.get('vortexNewsBlackout') !== false, // default ON
        fomcBlackout: Settings.get('vortexFomcBlackout') === true,  // default OFF
    });

    const baseline = _vortexBaseline(bot);
    if (!baseline) return; // not enough history yet

    const volRatio = atr / baseline;

    // ── CHAOS DETECTION on every bar ─────────────────────────
    const chaos = VortexStrategy.detectChaos(bot.candles, atr, baseline);
    if (chaos) {
        VortexStrategy.recordChaos(bot.id, chaos.direction);
        log(`🌀 VORTEX chaos detected — vol×${chaos.volRatio.toFixed(1)} | waiting for retrace`, 'warn');

        // Emergency exit if open trade and chaos goes against us
        if (bot.openSignal?.isVortex) {
            const adverse = (bot.openSignal.type === 'BUY'  && chaos.direction === 'down')
                         || (bot.openSignal.type === 'SELL' && chaos.direction === 'up');
            if (adverse) {
                log(`🌀 VORTEX chaos exit`, 'warn');
                const pnlAmt = (bot.openSignal.stake || 1.0) * (bot.openSignal.slMultiplier || 0.4);
                _vortexCloseTrade(bot, 'SL', pnlAmt, bot.candles[bot.candles.length - 2]);
                return;
            }
        }
    }

    if (bot.openSignal?.isVortex) {
        _applyTrailingStop(bot, atr);
        return;
    }
    if (bot.openSignal) return;
    if (VortexStrategy.isHalted(bot.id))      { log(`🌀 VORTEX halted — 5 consecutive losses`, 'warn'); return; }
    if (VortexStrategy.isTooFrequent(bot.id)) { log(`🌀 VORTEX rate limit — max 3 trades/hr`, 'neutral'); return; }

    // Cooldown: 2 candles minimum between entries
    const cooldownMs = (bot.config.tf || 60) * 2 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    const baseStake = parseFloat(bot.config.stake) || 1.0;
    const signal    = VortexStrategy.checkEntryFull(bot.id, bot.config.symbol, bot.candles, baseStake);
    if (!signal) return;

    bot.lastFiredMs = Date.now();
    const stakeLabel = signal.stake !== signal.baseStake
        ? `stake $${signal.stake.toFixed(2)} (scaled from $${signal.baseStake.toFixed(2)} at vol×${signal.volRatio})`
        : `stake $${signal.stake.toFixed(2)}`;

    log(`🌀 VORTEX ${signal.type} [${signal.mode}] @ ${bar.close.toFixed(4)} | vol×${signal.volRatio} | ${stakeLabel}`, signal.type === 'BUY' ? 'buy' : 'sell');
    log(`   ${signal.factors.join(' · ')}`, 'neutral');

    // Override bot stake temporarily for this trade
    const origStake = bot.config.stake;
    bot.config.stake = signal.stake;
    fireSignal(bot, signal, bar, atr, rsi, null);
    bot.config.stake = origStake;
}

function _vortexCloseTrade(bot, outcome, pnlAmt, bar) {
    const { type, entry, sl, tp } = bot.openSignal;
    const mode = bot.openSignal.mode || '';

    VortexStrategy.recordOutcome(bot.id, outcome, type); // type = 'BUY'|'SELL'

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
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'vortex',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    bot.openSignal = null;
}

// ─────────────────────────────────────────────────────────────
// KISMET — RUN + CLOSE
// ─────────────────────────────────────────────────────────────
function _runKismet(bot, bar, atr, rsi) {
    const cfg = kismetSymbolConfig(bot.config.symbol);
    if (!cfg) {
        log(`🎯 KISMET: ${bot.config.symbol} not supported. Use Boom/Crash 1000/500 or Step Index.`, 'warn');
        return;
    }

    // ── SPIKE DETECTION on every bar ─────────────────────────
    const spike = KismetStrategy.detectSpike(bot.candles, atr);
    if (spike) {
        KismetStrategy.recordSpike(bot.id, spike, bot.config.tf || 60);
        log(`🎯 KISMET spike — ${spike.direction === 'up' ? '↑' : '↓'} ${spike.magnitude.toFixed(1)}× ATR on ${cfg.name}`, 'neutral');

        // Emergency exit: close open trade if spike goes against us
        if (bot.openSignal?.isKismet) {
            if (KismetStrategy.checkAdverseSpike(bot.openSignal, spike)) {
                log(`🎯 KISMET adverse spike — emergency exit`, 'warn');
                const stake  = bot.openSignal.stake || 1.0;
                const pnlAmt = stake * (bot.openSignal.slMultiplier || 0.5);
                _kismetCloseTrade(bot, 'SL', pnlAmt, bot.candles[bot.candles.length - 2]);
                return;
            }
        }
    }

    if (bot.openSignal?.isKismet) {
        _applyTrailingStop(bot, atr);
        return;
    }
    if (bot.openSignal) return;

    // Halted for the day?
    if (KismetStrategy.isHalted(bot.id)) {
        log(`🎯 KISMET halted — 6 consecutive losses reached`, 'warn');
        return;
    }

    // Cooldown between trades (1 candle minimum)
    const cooldownMs = (bot.config.tf || 60) * 1 * 1000;
    if ((Date.now() - bot.lastFiredMs) < cooldownMs) return;

    // ── ENTRY CHECK ───────────────────────────────────────────
    const signal = KismetStrategy.checkEntry(bot.config.symbol, bot.candles, atr, bot.id);
    if (!signal) return;

    // Attach stake for emergency exit calculation
    signal.stake = bot.config.stake || 1.0;

    bot.lastFiredMs = Date.now();
    log(`🎯 KISMET ${signal.type} [${signal.mode}] @ ${bar.close.toFixed(4)} | score ${signal.score} | ${signal.factors.join(' · ')}`, signal.type === 'BUY' ? 'buy' : 'sell');

    fireSignal(bot, signal, bar, atr, rsi, null);
}

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
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'kismet',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    bot.openSignal = null;
}

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
    }

    const stakeSize = bot.config.phantomStake || 1;
    const updatedSession = PhantomStrategy.recordTrade(bot.id, outcome, pnlAmt * stakeSize);
    PhantomStrategy.recordOutcome(bot.id, type, outcome); // direction block
    _updatePhantomBadge(bot.id, updatedSession);

    if (updatedSession.mode === 'observer') {
        log(`👻 PHANTOM — Daily target $${updatedSession.profitTarget} reached! Switching to Observer Mode 👁`, 'buy');
    } else if (updatedSession.mode === 'halted') {
        log(`👻 PHANTOM — Loss limit -$${updatedSession.lossLimit} hit. Session halted. 🛑`, 'sell');
    }

    SessionState.pushTrade({
        time: Date.now(), symbol: bot.config.symbol, strategy: 'phantom',
        type, entry, sl, tp, outcome, pnl: pnlAmt,
        confidence: bot.lastConfidence || null,
    });

    bot.openSignal = null;
}

function _updatePhantomBadge(botId, session) {
    const card = document.querySelector(`.bot-card[data-bot-id="${botId}"]`);
    if (!card) return;
    const badge = card.querySelector('.phantom-session-badge');
    if (!badge) return;

    if (!session.configured) { badge.style.display = 'none'; return; }

    badge.style.display = 'block';

    const pnl    = session.realizedPnL;
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    const pnlCol = pnl >= 0 ? '#34d399' : '#f87171';

    let modeHtml = '';
    if (session.mode === 'observer') modeHtml = ' &nbsp;<span style="color:#a78bfa;">👁 OBSERVER</span>';
    if (session.mode === 'halted')   modeHtml = ' &nbsp;<span style="color:#f87171;">🛑 HALTED</span>';

    badge.innerHTML =
        `<span style="color:${pnlCol};font-weight:700;">${pnlStr}</span>` +
        `<span style="color:var(--text-muted);margin:0 5px;">·</span>` +
        `<span style="color:var(--text-muted);">${session.wins}W / ${session.losses}L</span>` +
        (session.profitTarget > 0
            ? `<span style="color:var(--text-muted);margin:0 5px;">·</span><span style="color:rgba(167,139,250,0.7);">Target $${session.profitTarget}</span>`
            : '') +
        modeHtml;
}

async function fireSignal(bot, signal, bar, atr, rsi, isTrending) {
    const type  = signal.type  || signal;
    const label = signal.label || type;

    // ── CONFIDENCE SCORE ─────────────────────────────────────
    // PHANTOM has its own scoring — skip the generic ConfidenceEngine for it
    let confidence;
    if (signal.isPhantom || signal.isNova || signal.isPulse || signal.isKismet || signal.isVortex) {
        const tag = signal.isNova ? '💥 NOVA' : signal.isPulse ? '⚡ PULSE' : signal.isKismet ? '🎯 KISMET' : signal.isVortex ? '🌀 VORTEX' : '👻 PHANTOM';
        confidence = {
            score:   signal.score || 50,
            grade:   signal.score >= 70 ? 'A' : signal.score >= 55 ? 'B' : 'C',
            color:   signal.score >= 70 ? '#34d399' : signal.score >= 55 ? '#fbbf24' : '#a78bfa',
            factors: signal.factors || [],
        };
        log(`SIGNAL ${type} @ ${bar.close.toFixed(4)} — ${label}`, type === 'BUY' ? 'buy' : 'sell');
        if (signal.factors?.length) {
            log(`Signals: ${signal.factors.slice(0, 5).join(' · ')}`, 'neutral');
        }
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
        if (confidence.factors.length) {
            log(`Confluence: ${confidence.factors.slice(0, 3).join(' · ')}`, 'neutral');
        }
    }

    window.registerBotSignal(bot.id, type, bar.close.toFixed(4), label, confidence);
    Notify.signal(type, bot.config.symbol, bar.close, label, confidence);

    // ── LIVE CONFIDENCE PREVIEW in analytics ─────────────────
    // Push to SessionState immediately so analytics page shows it without waiting for trade close
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

    const tpMult = signal.tpMultiplier || 1.5;
    const slMult = signal.slMultiplier || 1.0;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;

    const sl = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
    const tp = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

    bot.openSignal    = { type, sl, tp, entry: bar.close };
    bot.lastConfidence = confidence;

    const sigEngine = _engineFor(bot.id);
    if (sigEngine) {
        sigEngine.addMarker(bar.time, type, label);
        sigEngine.drawTradeLevels(sl, tp);
    }

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
            }
        } catch(e) {}
    }

    if (document.getElementById('auto-mt5')?.checked) {
        // Resolve MT5 symbol name: API key → display name → MT5 override → fallback
        const derivDisplay = symbolMap[bot.config.symbol] || SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
        const mt5Symbol    = MT5_SYMBOL_MAP[bot.config.symbol]  // direct API key override
                          || MT5_SYMBOL_MAP[derivDisplay]        // display name override
                          || derivDisplay;                        // fallback to display name

        // ── STAKE → LOT SIZE CONVERSION ──────────────────────
        // riskPerLot = how many dollars you lose per 1.0 lot when SL is hit.
        // Calibrated from MT5 report: ~$3 loss per lot on Boom/Crash 1000
        // at typical ATR-based SL distance. Configurable in Settings.
        const riskPerLot = parseFloat(Settings.get('mt5RiskPerLot')) || 3.0;
        const tradeStake = signal.stake
            || bot.config.stake
            || bot.config.phantomStake
            || parseFloat(document.getElementById('bt-stake')?.value)
            || 1.0;
        const rawLot  = tradeStake / riskPerLot;
        const lotSize = Math.max(0.01, parseFloat((Math.round(rawLot / 0.01) * 0.01).toFixed(2)));

        try {
            const res  = await fetch('/api/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: type.toLowerCase(), symbol: mt5Symbol,
                    price: bar.close, sl: parseFloat(sl.toFixed(5)),
                    tp: parseFloat(tp.toFixed(5)),
                    lotSize,                          // ← EA uses this for position size
                    stake: tradeStake,                // ← informational
                    label, timestamp: bar.time * 1000
                })
            });
            const json = await res.json();
            if (json.status === 'ok') {
                document.getElementById('mt5-indicator').className = 'status-dot status-online';
                SessionState.set({ mt5Connected: true });
                log(`→ MT5: ${type} ${mt5Symbol} @ ${bar.close} | lot ${lotSize} (stake $${tradeStake.toFixed(2)})`, 'info');
            }
        } catch(e) {
            log('MT5 push failed — server unreachable', 'warn');
        }
    }
}

// ─────────────────────────────────────────────────────────────
// SHARED TRAILING STOP
// Activates once price reaches 50% of TP distance from entry.
// Phase 1 (price < 50% TP): SL stays fixed.
// Phase 2 (price >= 50% TP): SL snaps to breakeven immediately.
// Phase 3 (trail active): SL walks 1×ATR behind closed candle,
//          ratcheting in trade direction — never steps back.
//          TP and trail compete — first hit closes the trade.
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

    if (inProfit < halfway) return; // haven't reached 50% of TP yet

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

    // Walk SL 1×ATR behind price — ratchet only, never retreat
    const candidate = type === 'BUY'
        ? price - atr
        : price + atr;

    let moved = false;
    if (type === 'BUY'  && candidate > sig.trailSL) {
        sig.trailSL = candidate;
        sig.sl      = candidate;
        moved = true;
    } else if (type === 'SELL' && candidate < sig.trailSL) {
        sig.trailSL = candidate;
        sig.sl      = candidate;
        moved = true;
    }

    if (moved) {
        const eng = _engineFor(bot.id);
        if (eng) eng.drawTradeLevels(sig.sl, sig.tp);
        _pushMT5Modify(bot, sig.sl, sig.tp);
    }
}

// Push a modify signal to MT5 via the server — EA calls OrderModify on receipt
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
    }
}

// ─────────────────────────────────────────────────────────────
// CHECK OUTCOME
// ─────────────────────────────────────────────────────────────
function checkOutcome(bot) {
    if (!bot.openSignal) return;

    const closed = bot.candles[bot.candles.length - 2];
    if (!closed || closed.time === bot.openSignal.lastCheckedTime) return;
    bot.openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry } = bot.openSignal;
    let hit = null;

    if (type === 'BUY') {
        if (closed.low  <= sl) hit = 'SL';
        else if (closed.high >= tp) hit = 'TP';
    } else {
        if (closed.high >= sl) hit = 'SL';
        else if (closed.low  <= tp) hit = 'TP';
    }

    if (!hit) return;

    // ── PHANTOM SCALE-OUT: on first TP, close 50% and trail the rest ──
    if (bot.openSignal.isPhantom && hit === 'TP' && !bot.openSignal.scaleOutDone) {
        const scaleStake = bot.config.stake || bot.config.phantomStake || 1;
        const halfPnl    = scaleStake * (bot.openSignal.tpMultiplier || 1.5) * 0.5;
        bot.openSignal.scaleOutDone = true;
        // Move SL to breakeven
        bot.openSignal.sl = entry;
        // Extend TP by 1.5x ATR for trailing remainder
        const atr = Indicators.calculateATR(bot.candles) || Math.abs(tp - entry);
        bot.openSignal.tp = type === 'BUY' ? entry + atr * 2.5 : entry - atr * 2.5;

        log(`👻 PHANTOM scale-out — 50% closed at 1:1 +${halfPnl.toFixed(4)} | SL → breakeven, trailing remainder`, 'buy');
        window.registerBotWin(bot.id, halfPnl);
        UIManager.registerWin(halfPnl);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: 'phantom', type, entry, sl, tp, outcome: 'TP', pnl: halfPnl });
        PhantomStrategy.recordTrade(bot.id, 'TP', halfPnl);
        _updatePhantomBadge(bot.id, PhantomStrategy.getSession());

        // Redraw levels
        const eng = _engineFor(bot.id);
        if (eng) eng.drawTradeLevels(bot.openSignal.sl, bot.openSignal.tp);
        return; // keep trade open for trailing remainder
    }

    const stake      = bot.config.stake || bot.config.phantomStake || 1;
    const slPriceDist = Math.abs(entry - sl);
    const tpPriceDist = Math.abs(tp - entry);
    // PnL = stake × (price_distance / sl_distance) × sl_multiplier
    // Simplifies to: stake × tpMultiplier on TP, stake × slMultiplier on SL
    const pnlAmt = hit === 'TP'
        ? stake * (bot.openSignal.tpMultiplier || (slPriceDist > 0 ? tpPriceDist / slPriceDist : 1.5))
        : stake * (bot.openSignal.slMultiplier || 1.0);

    // PHANTOM scale-out uses same stake logic
    // (halfPnl already handled above, this is the full close path)

    // PHANTOM full close (SL or trailed TP of remainder)
    if (bot.openSignal.isPhantom) {
        _phantomCloseTrade(bot, hit, pnlAmt, closed);
        return;
    }

    // NOVA full close
    if (bot.openSignal.isNova) {
        _novaCloseTrade(bot, hit, pnlAmt, closed);
        return;
    }

    // PULSE full close
    if (bot.openSignal.isPulse) {
        _pulseCloseTrade(bot, hit, pnlAmt, closed);
        return;
    }

    // KISMET full close
    if (bot.openSignal.isKismet) {
        _kismetCloseTrade(bot, hit, pnlAmt, closed);
        return;
    }

    // VORTEX full close
    if (bot.openSignal.isVortex) {
        _vortexCloseTrade(bot, hit, pnlAmt, closed);
        return;
    }

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
    }

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
    SessionState.set({ wins, losses, sessionPnL: pnl, winRate });

    // ── Auto cloud sync every trade (fire-and-forget) ──────────
    if (!Auth.isGuest()) {
        Auth.syncTrades(SessionState.get().trades).catch(() => {});
    }
    const outcomeEngine = _engineFor(bot.id);
    if (outcomeEngine) {
        outcomeEngine.clearMarkers();
        outcomeEngine.clearPriceLines();
    }

    bot.openSignal = null;

    // ── LOSS PROTECTION (3× SL rule) ─────────────────────────
    // Record SL timestamp and candle index for cooldown/re-entry filters
    if (hit === 'SL') {
        bot.lastSLTimeMs = Date.now();
        bot.lastSLBarIdx = bot.candles.length;
    }

    if (hit === 'SL' && Settings.get('lossProtection') && bot.config.strategy !== 'phantom' && bot.config.strategy !== 'nova' && bot.config.strategy !== 'pulse' && bot.config.strategy !== 'kismet' && bot.config.strategy !== 'vortex') {
        const recentTrades = (SessionState.get().trades || [])
            .filter(t => t.symbol === bot.config.symbol)
            .slice(0, 3);
        const consecutiveLosses = recentTrades.length >= 3
            && recentTrades.every(t => t.outcome === 'SL');
        if (consecutiveLosses) {
            log(`Loss protection: 3 consecutive SLs on ${bot.config.symbol} — bot stopped.`, 'warn');
            window.stopBot(bot.id);
            _showRiskAlert(`Bot stopped: 3 consecutive losses on ${SYMBOL_MAP[bot.config.symbol] || bot.config.symbol}.`);
            return;
        }
    }

    // ── DAILY LOSS LIMIT CHECK after every loss ───────────────
    // PHANTOM manages its own loss limit — skip global check for it
    const maxDailyLoss = Settings.get('maxDailyLoss') || 500;
    const currentPnL   = SessionState.get().sessionPnL;
    if (bot.config.strategy !== 'phantom' && bot.config.strategy !== 'nova' && bot.config.strategy !== 'pulse' && bot.config.strategy !== 'kismet' && bot.config.strategy !== 'vortex' && currentPnL <= -maxDailyLoss) {
        log(`Daily loss limit $${maxDailyLoss} hit — stopping all bots.`, 'warn');
        _showRiskAlert(`Daily loss limit of $${maxDailyLoss} reached. All bots stopped.`);
        Object.keys(bots).forEach(bid => window.stopBot(bid));
    }
}

// ─────────────────────────────────────────────────────────────
// OVERLAYS
// ─────────────────────────────────────────────────────────────
function redrawOverlays() {
    if (!focusedBotId || !bots[focusedBotId]) return;
    const bot = bots[focusedBotId];

    const engine = _engineFor(focusedBotId);
    if (!engine) return;
    _drawOverlaysOnEngine(engine, bot);
}

// Draws active overlays onto any engine (split panel or main)
function _drawOverlaysOnEngine(engine, bot) {
    const series = engine.getCandleSeries();
    OverlayManager.clearAll(series, engine);  // engine is the stable key
    if (document.getElementById('show-asian')?.checked)  OverlayManager.drawAsianRange(series, bot.candles);
    if (document.getElementById('show-pdhpdl')?.checked) OverlayManager.drawPDHPDL(series, bot.h4Candles);
    if (document.getElementById('show-fvg')?.checked)    OverlayManager.drawFVG(series, bot.candles, engine);
    if (document.getElementById('show-h4')?.checked)     OverlayManager.drawH4Kiss(series, bot.h4Candles);
    if (document.getElementById('show-major')?.checked)  OverlayManager.drawMajorSR(series, bot.candles);
    if (document.getElementById('show-orb')?.checked)    OverlayManager.drawORBRange(series, bot.candles);
    if (document.getElementById('show-ob')?.checked)     OverlayManager.drawOrderBlocks(series, bot.candles, engine);
    if (document.getElementById('show-bos')?.checked)    OverlayManager.drawBreakOfStructure(series, bot.candles);
}

// Redraws overlays on ALL active split panels using each bot's own state
function redrawAllSplitOverlays() {
    if (!ChartManager.isSplitMode()) return;
    Object.values(bots).forEach(bot => {
        if (!bot.isActive) return;
        const eng = ChartManager.get(bot.id);
        if (!eng) return;
        // Use this bot's saved overlay state
        const saved = overlayState[bot.id] || {};
        // Temporarily apply this bot's overlay state to checkboxes, draw, restore
        const current = {};
        OVERLAY_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) { current[id] = el.checked; el.checked = saved[id] || false; }
        });
        _drawOverlaysOnEngine(eng, bot);
        // Restore focused bot's state
        OVERLAY_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = current[id];
        });
    });
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
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #ef4444;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 0.72rem;
            font-weight: 600;
            letter-spacing: 0.04em;
            z-index: 9999;
            box-shadow: 0 8px 24px rgba(239,68,68,0.4);
            animation: riskSlideIn 0.3s ease;
        `;
        document.body.appendChild(alert);
    }
    alert.textContent = '⚠ ' + message;
    alert.style.display = 'block';
    clearTimeout(alert._timer);
    alert._timer = setTimeout(() => { alert.style.display = 'none'; }, 6000);
}

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
    // Clear all bot cards from the UI
    const botList = document.getElementById('bot-list');
    if (botList) botList.innerHTML = '';
    // Remove all chart panels
    Object.keys(bots).forEach(id => ChartManager.removeBot(id));
    const ph = document.getElementById('chart-placeholder-empty');
    if (ph) ph.style.display = 'flex';
    log('Logged out', 'warn');

    // Sync trades to server before logging out of NEXUS auth
    const trades = SessionState.get().trades;
    Auth.syncTrades(trades).finally(() => Auth.logout());
}

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

    // Restore saved config if provided
    if (savedConfig) {
        stratSelect.value = savedConfig.strategy;
        symbolSelect.value = savedConfig.symbol;
        const tfSelect = card.querySelector('.bot-tf-select');
        if (tfSelect) tfSelect.value = savedConfig.tf;
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

    // ── PHANTOM settings panel visibility ────────────────────
    const phantomPanel = card.querySelector('.phantom-settings');
    const tfSelect     = card.querySelector('.bot-tf-select');
    const showHidePhantom = () => {
        if (phantomPanel) phantomPanel.style.display = stratSelect.value === 'phantom' ? 'block' : 'none';

        // NOVA/KISMET: show M1 notice, lock TF visually
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

    // Configure button — sets session targets
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

    // Restore PHANTOM badge if already configured
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

// ─────────────────────────────────────────────────────────────
// WINDOW HELPERS
// ─────────────────────────────────────────────────────────────
window.getBotConfig = function(id) {
    const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
    if (!card) return null;
    const strategy = card.querySelector('.bot-strategy-select').value;
    // NOVA and KISMET run on M5 — M1 ATR too small for Deriv broker min stop levels
    const tfRaw    = parseInt(card.querySelector('.bot-tf-select').value);
    const tf       = (strategy === 'nova' || strategy === 'kismet') ? 300 : tfRaw;
    return {
        strategy,
        symbol:   card.querySelector('.bot-symbol-select').value,
        tf,
        stake:               parseFloat(card.querySelector('.bot-stake-input')?.value) || 1,
        phantomStake:        parseFloat(card.querySelector('.phantom-stake-input')?.value) || 1,
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
        // Auto-clear after 60s
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

function log(msg, type = 'neutral') { UIManager.log(msg, type); }

document.addEventListener('DOMContentLoaded', init);