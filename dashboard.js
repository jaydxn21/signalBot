import { SessionState } from './js/session-state.js';
import { UIManager } from './js/ui-manager.js';
import { ChartManager, initChartManager } from './js/chart-manager.js';
import { OverlayManager } from './js/overlays.js';

const SYMBOL_MAP = {
  R_100: 'Volatility 100 Index', R_75: 'Volatility 75 Index', R_50: 'Volatility 50 Index', R_25: 'Volatility 25 Index', R_10: 'Volatility 10 Index',
  '1HZ100V': 'Volatility 100 (1s) Index', '1HZ75V': 'Volatility 75 (1s) Index', '1HZ50V': 'Volatility 50 (1s) Index', '1HZ25V': 'Volatility 25 (1s) Index', '1HZ10V': 'Volatility 10 (1s) Index',
  cryBTCUSD: 'BTCUSD', cryETHUSD: 'ETHUSD', cryLTCUSD: 'LTCUSD', cryXRPUSD: 'XRPUSD',
  frxXAUUSD: 'XAUUSD', frxXAGUSD: 'XAGUSD', frxEURUSD: 'EURUSD', frxGBPUSD: 'GBPUSD', frxUSDJPY: 'USDJPY', frxAUDUSD: 'AUDUSD', frxUSDCAD: 'USDCAD', frxUSDCHF: 'USDCHF', frxEURGBP: 'EURGBP', frxGBPJPY: 'GBPJPY',
  JD10: 'Jump 10 Index', JD25: 'Jump 25 Index', JD50: 'Jump 50 Index', JD75: 'Jump 75 Index', JD100: 'Jump 100 Index',
  CRASH1000: 'Crash 1000 Index', BOOM1000: 'Boom 1000 Index', CRASH500: 'Crash 500 Index', BOOM500: 'Boom 500 Index',
  stpRNG: 'Step Index', STEP: 'Step Index',
};

const TF_LABEL = { 60: 'M1', 120: 'M2', 300: 'M5', 600: 'M10', 900: 'M15', 1800: 'M30', 3600: 'H1', 14400: 'H4', 86400: 'D1' };
const DEFAULT_CONFIG = { strategy: 'breakout_trend', symbol: 'R_100', tf: 300, lotSize: 0.01 };
const OVERLAY_IDS = ['show-asian', 'show-pdhpdl', 'show-fvg', 'show-h4', 'show-major', 'show-orb', 'show-ob', 'show-bos'];

let strategies = ['breakout_trend'];
const bots = {};
let focusedBotId = null;
let socket = null;
let reconnectTimer = null;
const overlayState = {};

function wsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const secret = window.localStorage.getItem('dashboard_secret');
  const query = secret ? `?secret=${encodeURIComponent(secret)}` : '';
  return `${protocol}://${window.location.hostname}:4000${query}`;
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    UIManager.log('Dashboard is offline from the engine', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type, ...payload }));
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(wsUrl());

  socket.onopen = () => {
    UIManager.log('Connected to engine', 'info');
    document.documentElement.setAttribute('data-authed', '1');
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  };

  socket.onerror = () => {
    UIManager.log('Engine socket error', 'warn');
  };

  socket.onclose = () => {
    UIManager.setConnectionStatus(false);
    UIManager.setMT5Status(false);
    UIManager.log('Engine disconnected — retrying...', 'warn');
    reconnectTimer = setTimeout(connectSocket, 5000);
  };
}

function handleMessage(message) {
  switch (message.type) {
    case 'engine_status':
      UIManager.setConnectionStatus(Boolean(message.connected));
      UIManager.setMT5Status(Boolean(message.mt5Connected));
      break;
    case 'settings': {
      const autoMt5 = document.getElementById('auto-mt5');
      if (autoMt5) autoMt5.checked = Boolean(message.autoMt5);
      break;
    }
    case 'log_history':
      clearLogs();
      (message.lines || []).forEach((line) => appendLog(line));
      break;
    case 'log_line':
      appendLog(message);
      break;
    case 'trade_history':
      syncTrades(message.trades || []);
      break;
    case 'trade_event':
      handleTradeEvent(message);
      break;
    case 'bots_list':
      syncBots(message.bots || []);
      break;
    case 'candle_history':
      applyCandleHistory(message.botId, message.candles || [], message.h4Candles || [], message.htfCandles || []);
      break;
    case 'candle_update':
      applyCandleUpdate(message.botId, message.candle, message.granularity);
      break;
    case 'error':
      UIManager.log(message.message, 'warn');
      break;
  }
}

function appendLog(line) {
  UIManager.log(line.text, line.type || 'neutral');
}

function clearLogs() {
  const container = document.getElementById('logs');
  if (container) container.innerHTML = '';
  const countEl = document.getElementById('log-count');
  if (countEl) countEl.textContent = '0 events';
}

function syncTrades(trades) {
  SessionState.set({ trades });
  renderSessionSummary(trades);
}

function handleTradeEvent(event) {
  if (event.trade) {
    const trades = [event.trade, ...(SessionState.get().trades || [])].slice(0, 200);
    SessionState.set({ trades });
    renderSessionSummary(trades);
  }
}

function renderSessionSummary(trades) {
  const wins = trades.filter(t => t.outcome === 'TP').length;
  const losses = trades.filter(t => t.outcome === 'SL').length;
  const pnl = trades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  SessionState.set({ wins, losses, sessionPnL: pnl, winRate });

  const winRateEl = document.getElementById('session-stats');
  if (winRateEl) {
    winRateEl.textContent = wins + losses ? `${winRate}%` : '—';
    winRateEl.style.color = wins + losses ? (winRate >= 50 ? 'var(--accent2)' : 'var(--accent3)') : 'var(--text-muted)';
  }

  const pnlEl = document.getElementById('session-pnl');
  if (pnlEl) {
    pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
    pnlEl.style.color = pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)';
  }
}

function syncBots(nextBots) {
  const nextIds = new Set(nextBots.map(bot => String(bot.id)));

  for (const staleId of Object.keys(bots)) {
    if (!nextIds.has(staleId)) removeBotCard(staleId);
  }

  for (const bot of nextBots) {
    const id = String(bot.id);
    const existing = bots[id] || { candles: [], h4Candles: [], htfCandles: [] };
    bots[id] = { ...existing, ...bot, id };
    if (!document.querySelector(`.bot-card[data-bot-id="${id}"]`)) createBotCard(id, bots[id]);
    hydrateBotCard(id, bots[id]);
    if (bots[id].isActive) ensureChart(id, bots[id]);
    else removeChart(id);
  }

  const activeCount = nextBots.filter(bot => bot.isActive).length;
  SessionState.set({ activeBots: activeCount, botConfigs: nextBots.map(({ id, config }) => ({ id, config })) });
  const activeEl = document.getElementById('stat-active');
  if (activeEl) {
    activeEl.textContent = activeCount;
    activeEl.style.color = activeCount > 0 ? 'var(--accent)' : 'var(--text-muted)';
  }

  if (!focusedBotId) {
    const firstActive = nextBots.find(bot => bot.isActive);
    if (firstActive) focusBot(String(firstActive.id));
  }
}

function createBotCard(id, bot = { config: DEFAULT_CONFIG, isActive: false }) {
  const template = document.getElementById('bot-card-template');
  if (!template) return;
  const clone = template.content.cloneNode(true);
  const card = clone.querySelector('.bot-card');
  card.dataset.botId = id;

  const strategySelect = card.querySelector('.bot-strategy-select');
  strategySelect.innerHTML = '';
  strategies.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    strategySelect.appendChild(opt);
  });

  const symbolSelect = card.querySelector('.bot-symbol-select');
  symbolSelect.innerHTML = '';
  Object.entries(SYMBOL_MAP).forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label.replace(' Index', '').trim();
    symbolSelect.appendChild(opt);
  });

  const updateLabel = () => {
    const labelEl = card.querySelector('.bot-symbol-label');
    if (labelEl) labelEl.textContent = (SYMBOL_MAP[symbolSelect.value] || symbolSelect.value).replace(' Index', '').trim();
  };

  [strategySelect, symbolSelect, card.querySelector('.bot-tf-select'), card.querySelector('.bot-lot-input')].forEach((el) => {
    el?.addEventListener('change', () => send('update_bot', { id, config: getBotConfig(id) }));
  });
  symbolSelect.addEventListener('change', updateLabel);

  card.querySelector('.bot-toggle-btn').onclick = () => {
    const isRunning = bots[id]?.isActive;
    send(isRunning ? 'stop_bot' : 'start_bot', { id });
  };

  card.querySelector('.bot-remove-btn').onclick = (e) => {
    e.stopPropagation();
    send('remove_bot', { id });
  };

  card.onclick = (e) => {
    if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
      focusBot(id);
    }
  };

  document.getElementById('bot-list').appendChild(card);
  hydrateBotCard(id, bot);
  updateLabel();
}

function hydrateBotCard(id, bot) {
  const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
  if (!card) return;

  const config = bot.config || DEFAULT_CONFIG;
  const strategySelect = card.querySelector('.bot-strategy-select');
  const symbolSelect = card.querySelector('.bot-symbol-select');
  const tfSelect = card.querySelector('.bot-tf-select');
  const lotInput = card.querySelector('.bot-lot-input');
  if (strategySelect && strategySelect.value !== config.strategy) strategySelect.value = config.strategy;
  if (symbolSelect && symbolSelect.value !== config.symbol) symbolSelect.value = config.symbol;
  if (tfSelect && String(tfSelect.value) !== String(config.tf)) tfSelect.value = config.tf;
  if (lotInput && String(lotInput.value) !== String(config.lotSize ?? 0.01)) lotInput.value = config.lotSize ?? 0.01;

  setBotRunning(id, Boolean(bot.isActive));
  const winsEl = card.querySelector('.bot-wins');
  const lossesEl = card.querySelector('.bot-losses');
  const pnlEl = card.querySelector('.bot-pnl');
  if (winsEl) winsEl.textContent = bot.wins || 0;
  if (lossesEl) lossesEl.textContent = bot.losses || 0;
  if (pnlEl) {
    pnlEl.textContent = (bot.pnl || 0).toFixed(2);
    pnlEl.style.color = (bot.pnl || 0) >= 0 ? 'var(--accent2)' : 'var(--accent3)';
  }

  const labelEl = card.querySelector('.bot-symbol-label');
  if (labelEl) labelEl.textContent = (SYMBOL_MAP[config.symbol] || config.symbol).replace(' Index', '').trim();

  if (bot.openSignal?.confidence) registerBotSignal(id, bot.openSignal.type, bot.openSignal.entry, bot.openSignal.label, bot.openSignal.confidence);
}

function removeBotCard(id) {
  removeChart(id);
  delete bots[id];
  const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
  if (card) card.remove();
  if (focusedBotId === id) {
    focusedBotId = null;
    ChartManager.splitView();
  }
}

function ensureChart(id, bot) {
  const symbolLabel = (SYMBOL_MAP[bot.config.symbol] || bot.config.symbol).replace(' Index', '').trim();
  ChartManager.addBot(id, symbolLabel, TF_LABEL[bot.config.tf] || bot.config.tf);
}

function removeChart(id) {
  try { ChartManager.removeBot(id); } catch {}
}

function getBotConfig(id) {
  const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
  if (!card) return DEFAULT_CONFIG;
  return {
    strategy: card.querySelector('.bot-strategy-select').value,
    symbol: card.querySelector('.bot-symbol-select').value,
    tf: Number(card.querySelector('.bot-tf-select').value),
    lotSize: Number(card.querySelector('.bot-lot-input').value || 0.01),
  };
}

function setBotRunning(id, isRunning) {
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
}

function focusBot(id) {
  focusedBotId = id;
  const bot = bots[id];
  if (!bot) return;

  if (!bot.isActive) {
    UIManager.log(`Bot #${id} is stopped`, 'warn');
    return;
  }

  const symLabel = (SYMBOL_MAP[bot.config.symbol] || bot.config.symbol).replace(' Index', '').trim();
  const tfLabel = TF_LABEL[bot.config.tf] || bot.config.tf;
  const symEl = document.getElementById('chart-symbol-label');
  const tfEl = document.getElementById('chart-tf-label');
  if (symEl) symEl.textContent = symLabel;
  if (tfEl) tfEl.textContent = tfLabel;

  if (ChartManager.count() > 1) {
    ChartManager.focus(id);
    loadOverlayState(id);
    showOverlayPanel(true);
    send('get_candles', { id });
    setTimeout(() => redrawOverlays(), 50);
  } else {
    showOverlayPanel(true);
    loadOverlayState(id);
    send('get_candles', { id });
  }
}

function applyCandleHistory(botId, candles, h4Candles, htfCandles) {
  const bot = bots[String(botId)];
  if (!bot) return;
  bot.candles = candles;
  bot.h4Candles = h4Candles;
  bot.htfCandles = htfCandles;
  const engine = engineFor(String(botId));
  if (engine && candles.length) {
    engine.setData(candles);
    engine.chart.timeScale().fitContent();
  }
  redrawOverlays();
}

function applyCandleUpdate(botId, candle, granularity) {
  const bot = bots[String(botId)];
  if (!bot || !candle) return;

  if (granularity === bot.config.tf) upsertCandle(bot.candles, candle, 1000);
  if (granularity === 14400) upsertCandle(bot.h4Candles, candle, 500);
  if (granularity === bot.htfGran) upsertCandle(bot.htfCandles, candle, 500);

  const engine = engineFor(String(botId));
  if (engine && granularity === bot.config.tf) {
    engine.update(candle);
    if (String(botId) === focusedBotId) redrawOverlays();
  }
}

function upsertCandle(list, candle, cap) {
  const last = list[list.length - 1];
  if (last && last.time === candle.time) list[list.length - 1] = candle;
  else {
    list.push(candle);
    if (list.length > cap) list.shift();
  }
}

function engineFor(botId) {
  if (!ChartManager.isSplitMode() && focusedBotId === botId) return ChartManager.mainEngine();
  return ChartManager.get(botId);
}

function redrawOverlays() {
  if (!focusedBotId || !bots[focusedBotId]) return;
  const bot = bots[focusedBotId];
  const engine = engineFor(focusedBotId);
  if (!engine) return;
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

function showOverlayPanel(show) {
  const panel = document.getElementById('overlay-panel');
  if (panel) panel.style.display = show ? 'block' : 'none';
}

function saveOverlayState(botId) {
  overlayState[botId] = {};
  OVERLAY_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) overlayState[botId][id] = el.checked;
  });
}

function loadOverlayState(botId) {
  const state = overlayState[botId] || {};
  OVERLAY_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(state[id]);
  });
}

function initOverlayPanel() {
  OVERLAY_IDS.forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (focusedBotId) saveOverlayState(focusedBotId);
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

async function loadStrategies() {
  try {
    const response = await fetch('/api/strategy-manifest');
    if (response.ok) {
      const manifest = await response.json();
      strategies = manifest.strategies?.map(s => s.name) || strategies;
    }
  } catch {}
}

function createNewBot() {
  send('create_bot', { config: { ...DEFAULT_CONFIG } });
}

function initUi() {
  document.documentElement.setAttribute('data-authed', '1');
  const authOverlay = document.getElementById('auth-overlay');
  if (authOverlay) authOverlay.style.display = 'none';

  const loginBtn = document.getElementById('btn-login');
  if (loginBtn) loginBtn.onclick = () => connectSocket();
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.onclick = () => connectSocket();
  const addBtn = document.getElementById('btn-add-bot');
  if (addBtn) addBtn.onclick = createNewBot;
  const autoMt5 = document.getElementById('auto-mt5');
  if (autoMt5) autoMt5.addEventListener('change', () => send('set_auto_mt5', { enabled: autoMt5.checked }));
  window.onSplitView = () => showOverlayPanel(false);
}

async function init() {
  await loadStrategies();
  initChartManager();
  initOverlayPanel();
  initUi();
  UIManager.log('Dashboard ready — waiting for engine', 'info');
  SessionState.set({ connected: false, mt5Connected: false, activeBots: 0, botConfigs: [], trades: [] });
  connectSocket();
}

init();
