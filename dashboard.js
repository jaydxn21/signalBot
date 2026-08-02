import { initChartManager, ChartManager } from './js/chart-manager.js';
import { UIManager } from './js/ui-manager.js';
import { Indicators } from './js/indicators.js';

const SYMBOL_MAP = {
    R_100: 'Volatility 100 Index',
    R_75: 'Volatility 75 Index',
    R_50: 'Volatility 50 Index',
    R_25: 'Volatility 25 Index',
    R_10: 'Volatility 10 Index',
    JD10: 'Jump 10 Index',
    JD25: 'Jump 25 Index',
    JD50: 'Jump 50 Index',
    JD75: 'Jump 75 Index',
    JD100: 'Jump 100 Index',
    CRASH1000: 'Crash 1000 Index',
    BOOM1000: 'Boom 1000 Index',
    CRASH500: 'Crash 500 Index',
    BOOM500: 'Boom 500 Index',
    cryBTCUSD: 'BTCUSD',
    cryETHUSD: 'ETHUSD',
    frxEURUSD: 'EURUSD',
    frxGBPUSD: 'GBPUSD',
    frxUSDJPY: 'USDJPY',
};

const TF_LABEL = {
    60: 'M1',
    120: 'M2',
    300: 'M5',
    600: 'M10',
    900: 'M15',
    1800: 'M30',
    3600: 'H1',
    14400: 'H4',
};

const STRATEGIES = ['breakout_trend'];
const ENGINE_PORT = Number(window.localStorage.getItem('signalbot_engine_port') || 4000);
const ENGINE_SECRET = window.localStorage.getItem('signalbot_engine_secret') || '';
const ENGINE_WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:${ENGINE_PORT}/${
    ENGINE_SECRET ? `?secret=${encodeURIComponent(ENGINE_SECRET)}` : ''
}`;

const bots = new Map();
let socket = null;
let focusedBotId = null;

function log(text, type = 'neutral') {
    UIManager.log(text, type);
}

function upsertCandle(bot, candle) {
    const last = bot.candles[bot.candles.length - 1];
    if (last && last.time === candle.time) {
        bot.candles[bot.candles.length - 1] = candle;
    } else {
        bot.candles.push(candle);
        if (bot.candles.length > 1000) bot.candles.shift();
    }
}

function renderStats() {
    const allBots = Array.from(bots.values());
    const running = allBots.filter((bot) => bot.isActive).length;
    const wins = allBots.reduce((sum, bot) => sum + (bot.wins || 0), 0);
    const losses = allBots.reduce((sum, bot) => sum + (bot.losses || 0), 0);
    const pnl = allBots.reduce((sum, bot) => sum + Number(bot.pnl || 0), 0);

    const activeEl = document.getElementById('stat-active');
    if (activeEl) activeEl.textContent = String(running);

    const total = wins + losses;
    const winRate = total ? Math.round((wins / total) * 100) : 0;
    const wrEl = document.getElementById('session-stats');
    if (wrEl) wrEl.textContent = total ? `${winRate}%` : '—';

    const pnlEl = document.getElementById('session-pnl');
    if (pnlEl) {
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
        pnlEl.style.color = pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
}

function createSelectOptions(select, options, formatter = (value) => value) {
    select.innerHTML = '';
    for (const value of options) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = formatter(value);
        select.appendChild(option);
    }
}

function createCard(id, initialConfig = null, draft = false) {
    const list = document.getElementById('bot-list');
    const template = document.getElementById('bot-card-template');
    if (!list || !template) return null;

    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.bot-card');
    card.dataset.botId = String(id);
    card.classList.remove('running');
    card.classList.add('stopped');

    const strategySelect = card.querySelector('.bot-strategy-select');
    const symbolSelect = card.querySelector('.bot-symbol-select');
    const tfSelect = card.querySelector('.bot-tf-select');
    const lotInput = card.querySelector('.bot-lot-input');
    const toggleBtn = card.querySelector('.bot-toggle-btn');
    const removeBtn = card.querySelector('.bot-remove-btn');

    createSelectOptions(strategySelect, STRATEGIES, (name) => name.replace(/_/g, ' '));
    createSelectOptions(symbolSelect, Object.keys(SYMBOL_MAP), (sym) => SYMBOL_MAP[sym].replace(' Index', '').trim());
    createSelectOptions(tfSelect, Object.keys(TF_LABEL), (tf) => TF_LABEL[tf]);

    if (initialConfig) {
        strategySelect.value = initialConfig.strategy || 'breakout_trend';
        symbolSelect.value = initialConfig.symbol || 'R_100';
        tfSelect.value = String(initialConfig.tf || 300);
        lotInput.value = Number(initialConfig.lotSize || 0.01).toFixed(2);
    }

    const symbolLabelEl = card.querySelector('.bot-symbol-label');
    const refreshSymbolLabel = () => {
        const symbol = symbolSelect.value;
        symbolLabelEl.textContent = (SYMBOL_MAP[symbol] || symbol).replace(' Index', '').trim();
    };
    symbolSelect.addEventListener('change', refreshSymbolLabel);
    refreshSymbolLabel();

    if (draft) {
        toggleBtn.textContent = 'CREATE BOT';
        toggleBtn.onclick = () => {
            send({
                type: 'create_bot',
                config: {
                    strategy: strategySelect.value,
                    symbol: symbolSelect.value,
                    tf: Number(tfSelect.value),
                    lotSize: Number(lotInput.value || 0.01),
                },
            });
            card.remove();
        };
        removeBtn.onclick = () => card.remove();
    } else {
        toggleBtn.onclick = () => {
            const isRunning = card.classList.contains('running');
            send({ type: isRunning ? 'stop_bot' : 'start_bot', id: String(id) });
        };
        removeBtn.onclick = (event) => {
            event.stopPropagation();
            send({ type: 'remove_bot', id: String(id) });
        };
    }

    card.onclick = (event) => {
        if (event.target.tagName === 'BUTTON' || event.target.tagName === 'SELECT' || event.target.tagName === 'INPUT') return;
        focusBot(String(id));
    };

    list.appendChild(card);
    return card;
}

function ensureCard(bot) {
    let card = document.querySelector(`.bot-card[data-bot-id="${bot.id}"]`);
    if (!card) {
        card = createCard(bot.id, bot.config, false);
    }
    if (!card) return;

    const running = !!bot.isActive;
    card.classList.toggle('running', running);
    card.classList.toggle('stopped', !running);
    const toggleBtn = card.querySelector('.bot-toggle-btn');
    toggleBtn.textContent = running ? 'STOP BOT' : 'START BOT';

    const wins = card.querySelector('.bot-wins');
    const losses = card.querySelector('.bot-losses');
    const pnlEl = card.querySelector('.bot-pnl');
    wins.textContent = String(bot.wins || 0);
    losses.textContent = String(bot.losses || 0);
    pnlEl.textContent = Number(bot.pnl || 0).toFixed(2);
    pnlEl.style.color = Number(bot.pnl || 0) >= 0 ? 'var(--accent2)' : 'var(--accent3)';

    if (!ChartManager.get(bot.id)) {
        const symLabel = (SYMBOL_MAP[bot.config.symbol] || bot.config.symbol).replace(' Index', '').trim();
        const tfLabel = TF_LABEL[bot.config.tf] || String(bot.config.tf);
        ChartManager.addBot(bot.id, symLabel, tfLabel);
    }
}

function pruneCards(validIds) {
    const cards = document.querySelectorAll('.bot-card[data-bot-id]');
    cards.forEach((card) => {
        if (!validIds.has(card.dataset.botId)) {
            ChartManager.removeBot(card.dataset.botId);
            card.remove();
        }
    });
}

function focusBot(id) {
    focusedBotId = id;
    const bot = bots.get(id);
    if (!bot) return;

    const symLabel = (SYMBOL_MAP[bot.config.symbol] || bot.config.symbol).replace(' Index', '').trim();
    const tfLabel = TF_LABEL[bot.config.tf] || String(bot.config.tf);
    const chartSymbol = document.getElementById('chart-symbol-label');
    const chartTf = document.getElementById('chart-tf-label');
    if (chartSymbol) chartSymbol.textContent = symLabel;
    if (chartTf) chartTf.textContent = tfLabel;

    if (ChartManager.count() > 1) {
        ChartManager.focus(id);
        ChartManager.loadMain(id, bot.candles);
    } else {
        const engine = ChartManager.get(id);
        if (engine && bot.candles.length) {
            engine.setData(bot.candles);
            engine.chart.timeScale().fitContent();
        }
    }

    send({ type: 'get_candles', id });
}

function updateHUD(botId) {
    const bot = bots.get(botId);
    if (!bot || bot.candles.length < 20) return;
    const atr = Indicators.calculateATR(bot.candles);
    const rsi = Indicators.calculateRSI(bot.candles, bot.rsiState);
    const closes = bot.candles.slice(-20).map((c) => c.close);
    const sma20 = closes.reduce((sum, value) => sum + value, 0) / closes.length;
    const market = closes[closes.length - 1] > sma20 ? 'TRENDING' : 'RANGING';
    ChartManager.updatePanelHUD(botId, rsi, atr, market);
    if (focusedBotId === botId) UIManager.updateHUD(rsi, atr, market);
}

function handleBotsList(payload) {
    const validIds = new Set();
    for (const botSummary of payload.bots || []) {
        const id = String(botSummary.id);
        validIds.add(id);
        const prev = bots.get(id) || { id, candles: [], rsiState: { prevAvgGain: 0, prevAvgLoss: 0, initialized: false } };
        bots.set(id, {
            ...prev,
            ...botSummary,
            id,
            candles: prev.candles || [],
            rsiState: prev.rsiState || { prevAvgGain: 0, prevAvgLoss: 0, initialized: false },
        });
        ensureCard(bots.get(id));
    }
    pruneCards(validIds);
    for (const id of Array.from(bots.keys())) {
        if (!validIds.has(id)) bots.delete(id);
    }
    if (bots.size === 0) focusedBotId = null;
    if (!focusedBotId && bots.size > 0) {
        focusBot(Array.from(bots.keys())[0]);
    }
    renderStats();
}

function handleCandleUpdate(payload) {
    const id = String(payload.botId);
    const bot = bots.get(id);
    if (!bot) return;
    upsertCandle(bot, payload.candle);
    const engine = ChartManager.get(id);
    if (engine) engine.update(payload.candle);
    updateHUD(id);
}

function handleCandlesHistory(payload) {
    const id = String(payload.id);
    const bot = bots.get(id);
    if (!bot) return;
    bot.candles = Array.isArray(payload.candles) ? payload.candles : [];
    const engine = ChartManager.get(id);
    if (engine && bot.candles.length) {
        engine.setData(bot.candles);
        engine.chart.timeScale().fitContent();
    }
    updateHUD(id);
}

function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        log('Engine websocket is not connected', 'warn');
        return;
    }
    socket.send(JSON.stringify(payload));
}

function connectEngine() {
    socket = new WebSocket(ENGINE_WS_URL);
    socket.onopen = () => {
        UIManager.setConnectionStatus(true);
        log(`Connected to engine (${ENGINE_WS_URL})`, 'info');
    };
    socket.onclose = () => {
        UIManager.setConnectionStatus(false);
        log('Engine disconnected, retrying in 3s...', 'warn');
        setTimeout(connectEngine, 3000);
    };
    socket.onerror = () => {
        UIManager.setConnectionStatus(false);
    };
    socket.onmessage = (event) => {
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch (error) {
            log(`Invalid engine payload: ${error.message}`, 'warn');
            return;
        }
        if (payload.type === 'bots_list') handleBotsList(payload);
        else if (payload.type === 'log_line') log(payload.text, payload.logType || 'neutral');
        else if (payload.type === 'trade_event') renderStats();
        else if (payload.type === 'candle_update') handleCandleUpdate(payload);
        else if (payload.type === 'candles_history') handleCandlesHistory(payload);
        else if (payload.type === 'error') log(`Engine error: ${payload.error}`, 'warn');
    };
}

function init() {
    initChartManager();
    UIManager.startSession();
    const addBtn = document.getElementById('btn-add-bot');
    if (addBtn) {
        addBtn.onclick = () => {
            createCard(`draft-${Date.now()}`, { strategy: 'breakout_trend', symbol: 'R_100', tf: 300, lotSize: 0.01 }, true);
        };
    }
    const clearLogsBtn = document.getElementById('clear-logs');
    if (clearLogsBtn) {
        clearLogsBtn.onclick = () => {
            const logs = document.getElementById('logs');
            if (logs) logs.innerHTML = '';
            const count = document.getElementById('log-count');
            if (count) count.textContent = '0 events';
        };
    }
    document.documentElement.setAttribute('data-authed', '1');
    connectEngine();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
