// signal-bot.js — Multi-instance runner v2.0
// Each bot instance has its own: candles, h4Candles, rsiState, ATR, strategy engine
// All instances share one Deriv WebSocket connection
// All instances push to the same MT5 EA via server

import { DerivAPI }          from './js/deriv-api.js';
import { ChartEngine }       from './js/chart-engine.js';
import { StrategyEngine }    from './js/strategy-engine.js';
import { Indicators }        from './js/indicators.js';
import { Storage }           from './js/storage.js';
import { OverlayManager }    from './js/overlays.js';
import { MomentumStrategy }  from './js/strategies/momentum.js';
import { DataLogger }        from './js/data-logger.js';
import { UIManager }         from './js/ui-manager.js';

// ─────────────────────────────────────────────────────────────
// SYMBOL MAP  (Deriv internal → MT5 broker name)
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

// All 15 strategies exposed to the UI
const STRATEGY_OPTIONS = [
    { value: 'momentum',        label: 'Momentum Scalper'     },
    { value: 'h4_kiss',         label: 'KISS H4'              },
    { value: 'synthetic_scalp', label: 'BB+RSI Synthetic'     },
    { value: 'crypto_scalp',    label: 'Crypto Scalper'       },
    { value: 'rsi_fade',        label: 'RSI Fade Scalper'     },
    { value: 'range_boundary',  label: 'Range Boundary'       },
    { value: 'vwap_reversion',  label: 'VWAP Reversion'       },
    { value: 'candle_speed',    label: 'Candle Speed'         },
    { value: 'london_breakout', label: 'London Breakout'      },
    { value: 'news_fade',       label: 'News Fade'            },
    { value: 'ultra_scalp',     label: 'Ultra Scalper'        },
    { value: 'scalp',           label: 'Classic Scalp'        },
    { value: 'swing',           label: 'Swing'                },
    { value: 'trend',           label: 'Trend Follow'         },
    { value: 'orb',             label: 'ORB'                  },
];

const TF_LABEL = {
    60:'M1',120:'M2',300:'M5',600:'M10',
    900:'M15',1800:'M30',3600:'H1',14400:'H4',86400:'D1'
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
        this.openSignal   = null;
        this.lastFiredMs  = 0;
        this.isActive     = false;
        this.sessionStart = null;
        this.wins         = 0;
        this.losses       = 0;
        this.pnl          = 0;
    }
}

// ─────────────────────────────────────────────────────────────
// SHARED SINGLETONS
// ─────────────────────────────────────────────────────────────
let api          = null;
let chart        = null;
let symbolMap    = {};
let focusedBotId = null;
let authorised   = false;

const bots = {};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
async function init() {
    chart = new ChartEngine('chart');
    api   = new DerivAPI(96293, handleData);

    // Clear logs button
    document.getElementById('clear-logs')?.addEventListener('click', () => {
        const logs = document.getElementById('logs');
        if (logs) logs.innerHTML = '';
        const countEl = document.getElementById('log-count');
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

    document.getElementById('btn-logout').onclick = logout;
    document.getElementById('btn-add-bot').onclick = () => createBotUIInstance();

    // Overlay checkboxes (optional — if you add them back)
    ['show-asian','show-pdhpdl','show-fvg','show-major',
     'show-h4','show-orb','show-ob','show-bos']
        .forEach(id => document.getElementById(id)
            ?.addEventListener('change', redrawOverlays));
}

// ─────────────────────────────────────────────────────────────
// START / STOP BOT
// ─────────────────────────────────────────────────────────────
window.startBot = function(id) {
    const config = window.getBotConfig(id);
    if (!config) return;

    const bot        = new BotState(id, config);
    bots[id]         = bot;
    bot.isActive     = true;
    bot.sessionStart = Date.now();

    window.setBotRunning(id, true);
    UIManager.startSession();
    log(`Bot #${id} started — ${config.strategy} on ${config.symbol} ${TF_LABEL[config.tf] || 'M5'}`, 'info');

    if (api?.socket?.readyState === 1) {
        subscribeBot(bot);
    } else {
        log(`Bot #${id} queued — waiting for API connection`, 'warn');
    }

    if (!focusedBotId) window.focusBot(id);
};

window.stopBot = function(id) {
    const bot = bots[id];
    if (!bot) return;
    bot.isActive = false;
    window.setBotRunning(id, false);
    log(`Bot #${id} stopped`, 'neutral');

    if (focusedBotId === id) {
        chart.setData([]);
        document.getElementById('chart-symbol-label').textContent = 'NO ACTIVE FEED';
        document.getElementById('chart-tf-label').textContent     = '';
        focusedBotId = null;
    }
};

window.focusBot = function(id) {
    focusedBotId = id;
    const bot = bots[id];
    if (!bot) return;

    document.getElementById('chart-symbol-label').textContent = SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
    document.getElementById('chart-tf-label').textContent     = TF_LABEL[bot.config.tf] || 'M5';

    if (bot.candles.length > 0) {
        chart.setData(bot.candles);
        redrawOverlays();
    }
};

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
        log(`API Error: ${data.error.message}`, 'warn');
        return;
    }

    // ── Authorised ───────────────────────────────────────────
    if (data.msg_type === 'authorize') {
        authorised = true;
        // ✅ FIXED: use correct CSS class names
        document.getElementById('connection-indicator').className = 'status-dot status-online';
        document.getElementById('conn-label').textContent         = 'Online';
        log('Terminal authorized — connection established', 'info');
        api.fetchActiveSymbols();

        Object.values(bots).forEach(bot => {
            window.setBotOnline(bot.id);
            if (bot.isActive) subscribeBot(bot);
        });
    }

    // ── Symbol list ──────────────────────────────────────────
    if (data.msg_type === 'active_symbols') {
        data.active_symbols.forEach(s => { symbolMap[s.symbol] = s.display_name; });
        log(`${data.active_symbols.length} symbols loaded`, 'info');
    }

    // ── History candles ──────────────────────────────────────
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
            if (gran === 14400) {
                bot.h4Candles = history;
            } else if (gran === bot.config.tf) {
                bot.candles = history;
                if (bot.id === focusedBotId) {
                    chart.setData(history);
                    redrawOverlays();
                }
            }
        });
    }

    // ── Live OHLC tick ───────────────────────────────────────
    if (data.msg_type === 'ohlc') {
        const gran = data.echo_req.granularity;
        const bar  = {
            time:  parseInt(data.ohlc.open_time),
            open:  parseFloat(data.ohlc.open),
            high:  parseFloat(data.ohlc.high),
            low:   parseFloat(data.ohlc.low),
            close: parseFloat(data.ohlc.close)
        };

        Object.values(bots).forEach(bot => {
            if (bot.isActive) processBar(bot, bar, gran);
        });
    }
}

// ─────────────────────────────────────────────────────────────
// PROCESS EACH BAR PER BOT
// ─────────────────────────────────────────────────────────────
function processBar(bot, bar, gran) {

    // ── H4 update ────────────────────────────────────────────
    if (gran === 14400) {
        const last = bot.h4Candles[bot.h4Candles.length - 1];
        if (last && last.time === bar.time) bot.h4Candles[bot.h4Candles.length - 1] = bar;
        else bot.h4Candles.push(bar);
        if (bot.h4Candles.length > 50) bot.h4Candles.shift();
        return;
    }

    // ── Main TF update ───────────────────────────────────────
    if (gran !== bot.config.tf) return;

    const last = bot.candles[bot.candles.length - 1];
    if (last && last.time === bar.time) bot.candles[bot.candles.length - 1] = bar;
    else bot.candles.push(bar);
    if (bot.candles.length > 1000) bot.candles.shift();

    if (bot.id === focusedBotId) chart.update(bar);

    // ── Indicators ───────────────────────────────────────────
    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const atr = Indicators.calculateATR(bot.candles);

    const isTrending = bot.candles.length >= 20
        ? MomentumStrategy._isTrending(bot.candles, atr) : null;
    const marketCond = isTrending === null ? '—' : isTrending ? 'TRENDING' : 'RANGING';

    if (bot.id === focusedBotId) {
        UIManager.updateHUD(rsi, atr, marketCond);
    }

    // ── Outcome check ────────────────────────────────────────
    checkOutcome(bot);

    // ── Session filter ───────────────────────────────────────
    if (document.getElementById('auto-session')?.checked) {
        const forexStrategies = ['momentum','london_breakout','news_fade','swing','h4_kiss'];
        if (forexStrategies.includes(bot.config.strategy)) {
            const hour = new Date().getUTCHours();
            if (hour < 7 || hour > 20) return;
        }
    }

    // ── Strategy analysis ────────────────────────────────────
    const signal = bot.strategy.analyze(
        bot.config.strategy,
        bot.candles,
        bot.h4Candles,
        bot.rsiState,
        atr,
        bot.config.symbol,
        rsi
    );

    const now = Date.now();
    if (signal && (now - bot.lastFiredMs) > 30000) {
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

    log(`SIGNAL ${type} @ ${bar.close.toFixed(4)} — ${label}`, type === 'BUY' ? 'buy' : 'sell');
    window.registerBotSignal(bot.id, type, bar.close.toFixed(4), label);

    if (!atr) return;

    const tpMult = signal.tpMultiplier || 1.5;
    const slMult = signal.slMultiplier || 1.0;
    const sl = type === 'BUY' ? bar.close - atr * slMult : bar.close + atr * slMult;
    const tp = type === 'BUY' ? bar.close + atr * tpMult : bar.close - atr * tpMult;

    bot.openSignal = { type, sl, tp, entry: bar.close };

    if (bot.id === focusedBotId) {
        chart.addMarker(bar.time, type, label);
        chart.drawTradeLevels(sl, tp);
    }

    // ── Training data log ────────────────────────────────────
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
        } catch(e) { /* non-momentum strategies skip cleanly */ }
    }

    // ── MT5 push ─────────────────────────────────────────────
    if (document.getElementById('auto-mt5')?.checked) {
        const mt5Symbol = symbolMap[bot.config.symbol]
            || SYMBOL_MAP[bot.config.symbol]
            || bot.config.symbol;
        try {
            const res  = await fetch('/api/signal', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action:    type.toLowerCase(),
                    symbol:    mt5Symbol,
                    price:     bar.close,
                    sl:        parseFloat(sl.toFixed(5)),
                    tp:        parseFloat(tp.toFixed(5)),
                    label,
                    timestamp: bar.time * 1000
                })
            });
            const json = await res.json();
            if (json.status === 'ok') {
                // ✅ FIXED: correct class name
                document.getElementById('mt5-indicator').className = 'status-dot status-online';
                log(`→ MT5: ${type} ${mt5Symbol} @ ${bar.close}`, 'info');
            }
        } catch(e) {
            log('MT5 push failed — server unreachable', 'warn');
        }
    }
}

// ─────────────────────────────────────────────────────────────
// CHECK OPEN SIGNAL OUTCOME
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

    const pnlAmt = hit === 'TP'
        ? Math.abs(tp - entry)
        : Math.abs(entry - sl);

    if (hit === 'TP') {
        log(`✓ TP hit  +${pnlAmt.toFixed(4)}`, 'buy');
        window.registerBotWin(bot.id, pnlAmt);
        UIManager.registerWin(pnlAmt);
        DataLogger.logOutcome('TP', entry, sl, tp, closed.time);
        UIManager.addTradeHistory(type, entry, sl, tp, 'TP', bot.config.symbol);
    } else {
        log(`✗ SL hit  -${pnlAmt.toFixed(4)}`, 'sell');
        window.registerBotLoss(bot.id, pnlAmt);
        UIManager.registerLoss(pnlAmt);
        DataLogger.logOutcome('SL', entry, sl, tp, closed.time);
        UIManager.addTradeHistory(type, entry, sl, tp, 'SL', bot.config.symbol);
        MomentumStrategy.registerLoss();
    }

    if (bot.id === focusedBotId) {
        chart.clearMarkers();
        chart.clearPriceLines();
    }

    bot.openSignal = null;
}

// ─────────────────────────────────────────────────────────────
// OVERLAYS
// ─────────────────────────────────────────────────────────────
function redrawOverlays() {
    if (!focusedBotId || !bots[focusedBotId]) return;
    const bot    = bots[focusedBotId];
    const series = chart.getCandleSeries();
    OverlayManager.clearAll(series);
    if (document.getElementById('show-asian')?.checked)  OverlayManager.drawAsianRange(series, bot.candles);
    if (document.getElementById('show-pdhpdl')?.checked) OverlayManager.drawPDHPDL(series, bot.h4Candles);
    if (document.getElementById('show-fvg')?.checked)    OverlayManager.drawFVG(series, bot.candles);
    if (document.getElementById('show-h4')?.checked)     OverlayManager.drawH4Kiss(series, bot.h4Candles);
    if (document.getElementById('show-major')?.checked)  OverlayManager.drawMajorSR(series, bot.candles);
    if (document.getElementById('show-orb')?.checked)    OverlayManager.drawORBRange(series, bot.candles);
    if (document.getElementById('show-ob')?.checked)     OverlayManager.drawOrderBlocks(series, bot.candles);
    if (document.getElementById('show-bos')?.checked)    OverlayManager.drawBreakOfStructure(series, bot.candles);
}

// ─────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────
function logout() {
    api?.socket?.close();
    Storage.clearToken();
    authorised = false;
    Object.keys(bots).forEach(id => delete bots[id]);
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('api-token').value            = '';
    // ✅ FIXED: correct class names
    document.getElementById('connection-indicator').className = 'status-dot status-offline';
    document.getElementById('conn-label').textContent         = 'Offline';
    document.getElementById('mt5-indicator').className        = 'status-dot status-offline';
    log('Logged out', 'warn');
}

// ─────────────────────────────────────────────────────────────
// CREATE BOT CARD UI INSTANCE
// ─────────────────────────────────────────────────────────────
function createBotUIInstance() {
    const id       = Date.now();
    const template = document.getElementById('bot-card-template');
    const clone    = template.content.cloneNode(true);
    const card     = clone.querySelector('.bot-card');

    card.dataset.botId = id;

    // ── Populate strategy dropdown with ALL 15 strategies ────
    const stratSelect = card.querySelector('.bot-strategy-select');
    stratSelect.innerHTML = '';
    STRATEGY_OPTIONS.forEach(({ value, label }) => {
        const opt   = document.createElement('option');
        opt.value   = value;
        opt.textContent = label;
        stratSelect.appendChild(opt);
    });

    // ── Populate symbol dropdown ──────────────────────────────
    const symbolSelect = card.querySelector('.bot-symbol-select');
    Object.entries(SYMBOL_MAP).forEach(([val, name]) => {
        const opt       = document.createElement('option');
        opt.value       = val;
        opt.textContent = name.replace(' Index', '').trim();
        symbolSelect.appendChild(opt);
    });

    // Update the symbol label when selection changes
    const updateLabel = () => {
        const label = card.querySelector('.bot-symbol-label');
        if (label) {
            const symName = SYMBOL_MAP[symbolSelect.value] || symbolSelect.value;
            label.textContent = symName.replace(' Index', '').trim();
        }
    };
    symbolSelect.addEventListener('change', updateLabel);
    updateLabel();

    // ── Start/Stop toggle ─────────────────────────────────────
    const toggleBtn = card.querySelector('.bot-toggle-btn');
    toggleBtn.onclick = () => {
        if (card.classList.contains('stopped')) {
            window.startBot(id);
        } else {
            window.stopBot(id);
        }
    };

    // ── Remove button ─────────────────────────────────────────
    card.querySelector('.bot-remove-btn').onclick = (e) => {
        e.stopPropagation();
        window.stopBot(id);
        card.remove();
        delete bots[id];
    };

    // ── Click card to focus chart ─────────────────────────────
    card.onclick = (e) => {
        if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
            window.focusBot(id);
            // Highlight focused card
            document.querySelectorAll('.bot-card').forEach(c => c.style.outline = 'none');
            card.style.outline = '2px solid var(--accent-light)';
        }
    };

    document.getElementById('bot-list').appendChild(card);
    log(`Bot card created — select a symbol and strategy`, 'info');
}

// ─────────────────────────────────────────────────────────────
// WINDOW HELPERS (called from bot card buttons)
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
        // ✅ FIXED: correct class name
        dot.className = 'status-dot status-online bot-status-dot';
    } else {
        card.classList.replace('running', 'stopped');
        btn.textContent = 'START BOT';
        // ✅ FIXED: correct class name
        dot.className = 'status-dot status-offline bot-status-dot';
    }

    // Update active bot counter
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
    // ✅ FIXED: correct class name
    if (dot) dot.className = 'status-dot status-online bot-status-dot';
};

window.registerBotSignal = function(id, type, price, label) {
    log(`[Bot #${id}] Signal: ${type} @ ${price} (${label})`, type === 'BUY' ? 'buy' : 'sell');
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

// ─────────────────────────────────────────────────────────────
// LOG HELPER
// ─────────────────────────────────────────────────────────────
function log(msg, type = 'neutral') {
    UIManager.log(msg, type);
}

// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);