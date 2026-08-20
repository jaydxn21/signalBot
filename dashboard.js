import { SessionState } from './js/session-state.js';
import { UIManager } from './js/ui-manager.js';
import { ChartManager, initChartManager } from './js/chart-manager.js';
import { OverlayManager } from './js/overlays.js';
import { API_BASE, Auth } from './js/auth.js';
import { SessionHydrator } from './js/session-hydrator.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Guard route
    Auth.guard();

    // 2. Fully restore UI, chart, trade journal, and settings
    await SessionHydrator.init();
});

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
const HTF_GRAN_MAP = { 60: 1800, 120: 3600, 180: 3600, 300: 3600, 600: 7200, 900: 14400, 1800: 14400, 3600: 86400, 14400: 604800 };
const DEFAULT_CONFIG = { strategy: 'breakout_trend', symbol: 'R_100', tf: 300, lotSize: 0.01 };
const OVERLAY_IDS = ['show-asian', 'show-pdhpdl', 'show-fvg', 'show-h4', 'show-major', 'show-orb', 'show-ob', 'show-bos'];

let strategies = ['breakout_trend'];
const bots = new Map();
let focusedBotId = null;
let socket = null;
let reconnectTimer = null;
const overlayState = new Map();
let pendingSignals = [];
let signalPollTimer = null;

// NOTE: this WebSocket engine (port 4000) is a separate local process, not
// the Render API (bot.atomicprod.shop). It will not resolve when this
// dashboard is loaded from Vercel/production unless that engine is deployed
// somewhere reachable and this URL is updated accordingly. Flagging for you —
// left unchanged since I don't know where/if that engine is meant to run.
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
  try {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  } catch {}
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
  if (event.type === 'signal' && event.signal) {
    registerBotSignal(event.botId, event.signal.type, event.signal.entry, event.signal.label, event.signal.confidence);
  }
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

  for (const staleId of bots.keys()) {
    if (!nextIds.has(staleId)) removeBotCard(staleId);
  }

  for (const bot of nextBots) {
    const id = String(bot.id);
    const existing = bots.get(id) || { candles: [], h4Candles: [], htfCandles: [] };
    bots.set(id, { ...existing, ...bot, id });
    if (!document.querySelector(`.bot-card[data-bot-id="${id}"]`)) createBotCard(id, bots.get(id));
    hydrateBotCard(id, bots.get(id));
    if (bots.get(id).isActive) ensureChart(id, bots.get(id));
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
    const isRunning = bots.get(id)?.isActive;
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
  bots.delete(id);
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
  ChartManager.updateLabel(id, symbolLabel, TF_LABEL[bot.config.tf] || bot.config.tf);
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
  const bot = bots.get(id);
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
  const bot = bots.get(String(botId));
  if (!bot) return;
  bot.candles = candles;
  bot.h4Candles = h4Candles;
  bot.htfCandles = htfCandles;
  bot.htfGran = HTF_GRAN_MAP[bot.config?.tf] || 14400;
  const engine = engineFor(String(botId));
  if (engine && candles.length) {
    engine.setData(candles);
    engine.chart.timeScale().fitContent();
  }
  redrawOverlays();
}

function applyCandleUpdate(botId, candle, granularity) {
  const bot = bots.get(String(botId));
  if (!bot || !candle) return;
  if (!bot.htfGran) bot.htfGran = HTF_GRAN_MAP[bot.config?.tf] || 14400;

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

function registerBotSignal(id, type, price, label, confidence) {
  const card = document.querySelector(`.bot-card[data-bot-id="${id}"]`);
  if (!card || !confidence) return;
  let badge = card.querySelector('.bot-confidence-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'bot-confidence-badge';
    badge.style.cssText = 'font-size:0.58rem;font-weight:700;letter-spacing:0.06em;padding:3px 8px;border-radius:6px;margin-top:6px;text-align:center;font-family:var(--font-mono);';
    const wlRow = card.querySelector('.bot-card-stats');
    if (wlRow) wlRow.parentNode.insertBefore(badge, wlRow);
  }
  badge.textContent = `${label || 'SIGNAL'} ${type} · ${confidence.grade} (${confidence.score}%) @ ${Number(price).toFixed(2)}`;
  badge.style.background = confidence.color + '22';
  badge.style.color = confidence.color;
  badge.style.border = `1px solid ${confidence.color}55`;
}

window.registerBotSignal = registerBotSignal;

function engineFor(botId) {
  if (!ChartManager.isSplitMode() && focusedBotId === botId) return ChartManager.mainEngine();
  return ChartManager.get(botId);
}

function redrawOverlays() {
  if (!focusedBotId || !bots.has(focusedBotId)) return;
  const bot = bots.get(focusedBotId);
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
  const nextState = {};
  OVERLAY_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) nextState[id] = el.checked;
  });
  overlayState.set(botId, nextState);
}

function loadOverlayState(botId) {
  const state = overlayState.get(botId) || {};
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
    // Fixed: was a relative fetch('/api/strategy-manifest'), which 404'd on
    // Vercel because the frontend and API no longer share an origin.
    const response = await fetch(`${API_BASE}/api/strategy-manifest`);
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

function startSignalPolling() {
  if (signalPollTimer) clearInterval(signalPollTimer);

  // Poll for signals every 5 seconds
  signalPollTimer = setInterval(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/signals/pending`);
      if (!response.ok) return;

      const signals = await response.json();
      if (!Array.isArray(signals)) return;

      pendingSignals = signals;
      displaySignals(signals);
    } catch (error) {
      console.error('Failed to fetch signals:', error);
    }
  }, 5000);
}

function displaySignals(signals) {
  // Show signals in dashboard
  const container = document.getElementById('signal-list');
  if (!container) return;

  container.innerHTML = '';
  signals.forEach((signal) => {
    const el = document.createElement('div');
    const typeClass = String(signal.signal_type || 'unknown').toLowerCase();
    el.className = `signal-item signal-${typeClass}`;
    el.dataset.signalId = String(signal.id || '');

    const type = signal.signal_type || 'UNKNOWN';
    const price = signal.price ?? '—';
    const createdAt = signal.created_at ? new Date(signal.created_at).toLocaleTimeString() : '—';

    el.innerHTML = `
      <span class="signal-type">${type}</span>
      <span class="signal-price">${price}</span>
      <span class="signal-time">${createdAt}</span>
      <button type="button">✓</button>
    `;

    const ackBtn = el.querySelector('button');
    ackBtn?.addEventListener('click', () => acknowledgeSignal(signal.id));
    container.prepend(el);
  });
}

async function acknowledgeSignal(signalId) {
  try {
    await fetch(`${API_BASE}/api/signals/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalId }),
    });
  } catch (error) {
    console.error('Failed to acknowledge signal:', error);
    return;
  }

  pendingSignals = pendingSignals.filter((s) => String(s.id) !== String(signalId));

  // Remove from UI
  const el = document.querySelector(`[data-signal-id="${signalId}"]`);
  if (el) el.remove();
}

async function init() {
  await loadStrategies();
  initChartManager();
  initOverlayPanel();
  initUi();
  startSignalPolling();
  UIManager.log('Dashboard ready — waiting for engine', 'info');
  SessionState.set({ connected: false, mt5Connected: false, activeBots: 0, botConfigs: [], trades: [] });
  connectSocket();
}

init();