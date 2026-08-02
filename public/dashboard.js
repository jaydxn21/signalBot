// public/dashboard.js — Browser-side WebSocket client for the engine
//
// Connects to the engine's ws-server (port 4000) and binds incoming
// state messages to the dashboard UI.  All candle processing and trade
// execution have been removed from this file; those now live entirely
// inside engine/strategy-runner.js on the Mac.
//
// Configuration:
//   window.ENGINE_WS_URL — set this before the script loads, e.g.:
//       <script>window.ENGINE_WS_URL = 'ws://192.168.1.42:4000';</script>
//   Falls back to ws://<current-hostname>:4000.

(function () {
    'use strict';

    // ── config ───────────────────────────────────────────────────────────

    const WS_URL =
        window.ENGINE_WS_URL ??
        `ws://${location.hostname}:4000`;

    let ws            = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    const MAX_DELAY    = 30_000;

    // Chart series registry: { [botId]: { chart, candleSeries } }
    const _charts = {};

    // ── connect ──────────────────────────────────────────────────────────

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        _setStatus('connecting');
        ws = new WebSocket(WS_URL);

        ws.addEventListener('open', () => {
            console.log('[Dashboard] Connected to engine');
            reconnectDelay = 2000;
            _setStatus('online');
            _log('info', 'Connected to engine at ' + WS_URL);
        });

        ws.addEventListener('message', (ev) => {
            try {
                const { type, data } = JSON.parse(ev.data);
                _dispatch(type, data);
            } catch (e) {
                console.error('[Dashboard] Parse error:', e);
            }
        });

        ws.addEventListener('close', () => {
            _setStatus('offline');
            _log('warn', `Engine disconnected — reconnecting in ${reconnectDelay / 1000}s…`);
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
                connect();
            }, reconnectDelay);
        });

        ws.addEventListener('error', () => {
            // 'close' will fire next; errors are surfaced there
        });
    }

    // ── message dispatcher ───────────────────────────────────────────────

    function _dispatch(type, data) {
        switch (type) {
            case 'bots_list':     _onBotsList(data);     break;
            case 'candle_update': _onCandleUpdate(data); break;
            case 'trade_event':   _onTradeEvent(data);   break;
            case 'signal':        _onSignal(data);       break;
            case 'log_line':      _onLogLine(data);      break;
            default: break;
        }
    }

    // ── bots_list ────────────────────────────────────────────────────────

    function _onBotsList({ bots, session }) {
        // Update session stats bar
        _setText('stat-wins',    session.wins);
        _setText('stat-losses',  session.losses);
        _setText('stat-wr',      session.winRate + '%');
        _setText('stat-pnl',     (session.sessionPnL >= 0 ? '+' : '') + '$' + session.sessionPnL.toFixed(2));
        _setText('stat-equity',  '$' + session.accountEquity.toFixed(2));
        _setText('stat-active',  bots.filter(b => b.isActive).length);

        // Rebuild bot cards
        const container = document.getElementById('bot-list');
        if (!container) return;

        for (const b of bots) {
            let card = container.querySelector(`[data-bot-id="${b.id}"]`);
            if (!card) {
                card = _createBotCard(b);
                container.appendChild(card);
            }
            _updateBotCard(card, b);
        }

        // Remove cards for bots no longer registered
        const currentIds = new Set(bots.map(b => String(b.id)));
        container.querySelectorAll('[data-bot-id]').forEach(el => {
            if (!currentIds.has(el.dataset.botId)) el.remove();
        });
    }

    // ── candle_update ────────────────────────────────────────────────────

    function _onCandleUpdate({ botId, bar, isNew }) {
        const entry = _charts[botId];
        if (!entry) return;

        const { candleSeries } = entry;
        // lightweight-charts expects { time, open, high, low, close }
        if (isNew) {
            candleSeries.update(bar);
        } else {
            candleSeries.update(bar); // update() handles both new and in-progress bars
        }
    }

    // ── trade_event ──────────────────────────────────────────────────────

    function _onTradeEvent(data) {
        const { botId, outcome, pnl, type, symbol } = data;
        const icon = outcome === 'TP' ? '✅' : '❌';
        _log(
            outcome === 'TP' ? 'buy' : 'sell',
            `${icon} ${outcome} — ${type} ${symbol}  ${outcome === 'TP' ? '+' : '-'}$${pnl.toFixed(2)}`
        );

        // Flash the bot card
        const card = document.querySelector(`[data-bot-id="${botId}"]`);
        if (card) {
            card.classList.add(outcome === 'TP' ? 'flash-win' : 'flash-loss');
            setTimeout(() => card.classList.remove('flash-win', 'flash-loss'), 1500);
        }

        // Clear trade-level lines on the chart
        const entry = _charts[botId];
        if (entry?.chart) {
            entry.chart.priceScale('right').applyOptions({});
        }
    }

    // ── signal ───────────────────────────────────────────────────────────

    function _onSignal(data) {
        const { botId, type, symbol, price, label, confidence } = data;
        const icon = type === 'BUY' ? '🟢' : '🔴';
        _log(
            type === 'BUY' ? 'buy' : 'sell',
            `${icon} ${type} signal — ${symbol} @ ${price.toFixed(4)}  [${label}]  ${confidence.grade}(${confidence.score}%)`
        );

        // Update confidence badge on card
        const card = document.querySelector(`[data-bot-id="${botId}"]`);
        if (card) {
            let badge = card.querySelector('.bot-confidence-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'bot-confidence-badge';
                const statsRow = card.querySelector('.bot-card-stats');
                if (statsRow) statsRow.parentNode.insertBefore(badge, statsRow);
            }
            badge.textContent = `${type} · ${confidence.grade} (${confidence.score}%)`;
            badge.style.cssText =
                `font-size:.58rem;font-weight:700;letter-spacing:.06em;padding:3px 8px;` +
                `border-radius:6px;margin-top:6px;text-align:center;font-family:monospace;` +
                `background:${confidence.color}22;color:${confidence.color};border:1px solid ${confidence.color}55;`;
            clearTimeout(badge._clearTimer);
            badge._clearTimer = setTimeout(() => {
                badge.textContent = '';
                badge.style.background = badge.style.border = '';
            }, 60_000);
        }
    }

    // ── log_line ─────────────────────────────────────────────────────────

    function _onLogLine({ level, msg }) {
        _log(level, msg);
    }

    // ── bot card helpers ─────────────────────────────────────────────────

    function _createBotCard(b) {
        const card = document.createElement('div');
        card.className = 'bot-card stopped';
        card.dataset.botId = b.id;
        card.innerHTML = `
            <div class="bot-card-header">
                <span class="bot-status-dot status-dot status-offline"></span>
                <span class="bot-symbol-label">${b.config.symbol}</span>
                <span class="bot-strategy-label">${b.config.strategy}</span>
            </div>
            <div class="bot-card-stats">
                W:<span class="bot-wins">0</span>
                L:<span class="bot-losses">0</span>
                PnL:$<span class="bot-pnl">0.00</span>
            </div>
        `;

        // Initialise a lightweight-charts panel if the library is loaded
        if (typeof LightweightCharts !== 'undefined') {
            const chartDiv = document.createElement('div');
            chartDiv.className = 'bot-mini-chart';
            chartDiv.style.cssText = 'height:120px;width:100%;margin-top:6px;';
            card.appendChild(chartDiv);

            const chart = LightweightCharts.createChart(chartDiv, {
                width:  chartDiv.offsetWidth || 240,
                height: 120,
                layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
                grid:   { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
                timeScale: { timeVisible: true },
            });
            const candleSeries = chart.addCandlestickSeries();
            _charts[b.id] = { chart, candleSeries };
        }

        return card;
    }

    function _updateBotCard(card, b) {
        card.className = `bot-card ${b.isActive ? 'running' : 'stopped'}`;
        _setCardText(card, '.bot-wins',   b.wins);
        _setCardText(card, '.bot-losses', b.losses);
        _setCardText(card, '.bot-pnl',    b.pnl.toFixed(2));

        const dot = card.querySelector('.bot-status-dot');
        if (dot) {
            dot.className = `status-dot bot-status-dot ${b.isActive ? 'status-online' : 'status-offline'}`;
        }
    }

    // ── UI utilities ─────────────────────────────────────────────────────

    function _setStatus(state) {
        const dot   = document.getElementById('connection-indicator');
        const label = document.getElementById('conn-label');
        if (dot)   dot.className   = `status-dot status-${state === 'online' ? 'online' : 'offline'}`;
        if (label) label.textContent = state === 'online' ? 'Online' : state === 'connecting' ? 'Connecting…' : 'Offline';
    }

    function _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function _setCardText(card, selector, val) {
        const el = card.querySelector(selector);
        if (el) el.textContent = val;
    }

    function _log(level, msg) {
        const container = document.getElementById('log-container');
        if (!container) { console.log(`[${level}] ${msg}`); return; }

        const line = document.createElement('div');
        line.className = `log-line log-${level}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        container.appendChild(line);

        // Keep at most 200 lines
        while (container.children.length > 200) {
            container.removeChild(container.firstChild);
        }
        container.scrollTop = container.scrollHeight;
    }

    // ── boot ─────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', connect);
    } else {
        connect();
    }

    // Expose for debugging
    window._dashboardWs = () => ws;
})();
