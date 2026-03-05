// signal-bot.js — Multi-instance runner v2.0
if (location.hostname !== 'localhost') console.log = () => {};

import { DerivAPI }          from './js/deriv-api.js';
import { StrategyEngine }    from './js/strategy-engine.js';
import { Indicators }        from './js/indicators.js';
import { Storage }           from './js/storage.js';
import { OverlayManager }    from './js/overlays.js';
import { MomentumStrategy }  from './js/strategies/momentum.js';
import { DataLogger }        from './js/data-logger.js';
import { UIManager }         from './js/ui-manager.js';
import { SessionState }      from './js/session-state.js';
import { Analytics }         from './js/pages/analytics.js';
import { Settings }          from './js/pages/settings.js';
import { ChartManager, initChartManager } from './js/chart-manager.js';
import { ConfidenceEngine }          from './js/confidence.js';

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
};

// Strategies grouped by compatible symbol type.
// Used to build categorized <optgroup> dropdowns in bot cards.
const STRATEGY_GROUPS = [
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
let api          = null;
let symbolMap    = {};
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

    document.getElementById('clear-logs')?.addEventListener('click', () => {
        const logs    = document.getElementById('logs');
        const countEl = document.getElementById('log-count');
        if (logs)    logs.innerHTML      = '';
        if (countEl) countEl.textContent = '0 events';
    });

    const token = Storage.getToken();
    if (token) {
        document.getElementById('auth-overlay').style.display = 'none';
        api.connect(token);
    }

    document.getElementById('btn-login').onclick = () => {
        const t = document.getElementById('api-token').value.trim();
        if (!t) return alert('Token required');
        Storage.saveToken(t);
        document.getElementById('auth-overlay').style.display = 'none';
        api.connect(t);
    };

    document.getElementById('btn-logout').onclick  = logout;
    document.getElementById('btn-add-bot').onclick = () => _createBotCard(Date.now(), null);

    // Overlay panel — wire checkboxes and collapse toggle
    _initOverlayPanel();

    // Restore any bots that were running before navigation
    _restoreBotCards();
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
    api.subscribe(bot.config.symbol, bot.config.tf);
    api.subscribe(bot.config.symbol, 14400);
    log(`Subscribed: ${bot.config.symbol} ${TF_LABEL[bot.config.tf] || 'M5'} + H4`, 'info');
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
            } else if (gran === bot.config.tf && data.echo_req.ticks_history === bot.config.symbol) {
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
        return;
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
async function fireSignal(bot, signal, bar, atr, rsi, isTrending) {
    const type  = signal.type  || signal;
    const label = signal.label || type;

    // ── CONFIDENCE SCORE ─────────────────────────────────────
    const confidence = ConfidenceEngine.score({
        type,
        candles:      bot.candles,
        h4Candles:    bot.h4Candles,
        rsi,
        atr,
        overlayState: overlayState[bot.id] || {},
    });

    const confLabel = `${label} [${confidence.grade}${confidence.score}]`;
    log(`SIGNAL ${type} @ ${bar.close.toFixed(4)} — ${confLabel}`, type === 'BUY' ? 'buy' : 'sell');

    // Log top factors
    if (confidence.factors.length) {
        log(`Confluence: ${confidence.factors.slice(0, 3).join(' · ')}`, 'neutral');
    }

    window.registerBotSignal(bot.id, type, bar.close.toFixed(4), confLabel, confidence);

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
    const sl = type === 'BUY' ? bar.close - atr * slMult : bar.close + atr * slMult;
    const tp = type === 'BUY' ? bar.close + atr * tpMult : bar.close - atr * tpMult;

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
        const mt5Symbol = symbolMap[bot.config.symbol] || SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
        try {
            const res  = await fetch('/api/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: type.toLowerCase(), symbol: mt5Symbol,
                    price: bar.close, sl: parseFloat(sl.toFixed(5)),
                    tp: parseFloat(tp.toFixed(5)), label, timestamp: bar.time * 1000
                })
            });
            const json = await res.json();
            if (json.status === 'ok') {
                document.getElementById('mt5-indicator').className = 'status-dot status-online';
                SessionState.set({ mt5Connected: true });
                log(`→ MT5: ${type} ${mt5Symbol} @ ${bar.close}`, 'info');
            }
        } catch(e) {
            log('MT5 push failed — server unreachable', 'warn');
        }
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

    const pnlAmt = hit === 'TP' ? Math.abs(tp - entry) : Math.abs(entry - sl);

    if (hit === 'TP') {
        log(`✓ TP hit  +${pnlAmt.toFixed(4)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        DataLogger.logOutcome('TP', entry, sl, tp, closed.time);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
        Analytics.recordTrade({ symbol: bot.config.symbol, strategy: bot.config.strategy, type, entry, sl, tp, outcome: 'TP', pnl: pnlAmt });
    } else {
        log(`✗ SL hit  -${pnlAmt.toFixed(4)}`, 'sell');
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

    if (hit === 'SL' && Settings.get('lossProtection')) {
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
    const maxDailyLoss = Settings.get('maxDailyLoss') || 500;
    const currentPnL   = SessionState.get().sessionPnL;
    if (currentPnL <= -maxDailyLoss) {
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
    api?.disconnect();
    Storage.clearToken();
    authorised = false;
    Object.keys(bots).forEach(id => delete bots[id]);
    SessionState.set({ connected: false, mt5Connected: false, activeBots: 0, botConfigs: [] });
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
    return {
        strategy: card.querySelector('.bot-strategy-select').value,
        symbol:   card.querySelector('.bot-symbol-select').value,
        tf:       parseInt(card.querySelector('.bot-tf-select').value)
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