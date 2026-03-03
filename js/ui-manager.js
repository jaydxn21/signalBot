export const UIManager = {
    _wins: 0,
    _losses: 0,
    _startTime: null,
    _signalPnL: 0,
    _timerInterval: null,

    startSession() {
        this._wins      = 0;
        this._losses    = 0;
        this._startTime = Date.now();
        this._signalPnL = 0;
        clearInterval(this._timerInterval);
        this._timerInterval = setInterval(() => this._updateSessionTimer(), 1000);
        this._updateWinRate();
    },

    registerWin(pnl) {
        this._wins++;
        this._signalPnL += Math.abs(pnl);
        this._updateWinRate();
    },

    registerLoss(pnl) {
        this._losses++;
        this._signalPnL -= Math.abs(pnl);
        this._updateWinRate();
    },

    _updateWinRate() {
        const total = this._wins + this._losses;
        const rate  = total === 0 ? 0 : Math.round((this._wins / total) * 100);
        const el    = document.getElementById('session-stats');
        if (el) {
            el.textContent = total === 0 ? '—' : `${rate}%`;
            el.style.color = total === 0
                ? 'var(--text-muted)'
                : rate >= 50 ? 'var(--accent2)' : 'var(--accent3)';
        }
        // Also update active bot count
        const activeEl = document.getElementById('stat-active');
        if (activeEl) {
            const running = document.querySelectorAll('.bot-card.running').length;
            activeEl.textContent = running;
            activeEl.style.color = running > 0 ? 'var(--accent)' : 'var(--text-muted)';
        }
    },

    _updateSessionTimer() {
        if (!this._startTime) return;
        const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
        const hrs  = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const mins = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');

        const timerEl = document.getElementById('session-timer');
        if (timerEl) timerEl.textContent = `${hrs}:${mins}:${secs}`;

        const pnlEl = document.getElementById('session-pnl');
        if (pnlEl) {
            pnlEl.textContent  = `${this._signalPnL >= 0 ? '+' : ''}${this._signalPnL.toFixed(2)}`;
            pnlEl.style.color  = this._signalPnL >= 0 ? 'var(--accent2)' : 'var(--accent3)';
        }
    },

    updateHUD(rsi, atr, marketCondition) {
        if (rsi !== null && rsi !== undefined) {
            const el = document.getElementById('rsi-value');
            if (el) el.textContent = rsi.toFixed(1);
        }
        if (atr !== null && atr !== undefined) {
            const el = document.getElementById('atr-value');
            if (el) el.textContent = atr.toFixed(4);
        }
        if (marketCondition !== undefined) {
            const el = document.getElementById('daily-bias');
            if (el) {
                el.textContent = marketCondition;
                el.style.color =
                    marketCondition === 'TRENDING' ? 'var(--accent2)'  :
                    marketCondition === 'RANGING'  ? 'var(--warn)'     : 'var(--text-muted)';
            }
        }
    },

    log(msg, type = 'neutral') {
        const container = document.getElementById('logs');
        if (!container) return;

        const div = document.createElement('div');

        // Map type to CSS class used in styles.css
        const classMap = {
            buy:     'log-buy',
            sell:    'log-sell',
            info:    'log-info',
            warn:    'log-warn',
            neutral: '',
        };
        const cls = classMap[type] || '';
        if (cls) div.classList.add(cls);

        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        div.innerHTML = `<span style="opacity:0.4;margin-right:8px;">[${time}]</span>${msg}`;
        container.prepend(div);

        // Cap log at 80 entries
        if (container.children.length > 80) container.lastChild.remove();

        // Update event count
        const countEl = document.getElementById('log-count');
        if (countEl) countEl.textContent = `${container.children.length} events`;
    },

    setConnectionStatus(connected) {
        const dot   = document.getElementById('connection-indicator');
        const label = document.getElementById('conn-label');
        if (dot) {
            dot.className = connected
                ? 'status-dot status-online'
                : 'status-dot status-offline';
        }
        if (label) label.textContent = connected ? 'Online' : 'Offline';
    },

    setMT5Status(connected) {
        const dot = document.getElementById('mt5-indicator');
        if (dot) {
            dot.className = connected
                ? 'status-dot status-online'
                : 'status-dot status-offline';
        }
    },

    addTradeHistory(type, entry, sl, tp, outcome, symbol = '') {
        // Update the trade history table in the Journal page
        const tbody = document.getElementById('trade-history-body');
        if (!tbody) return;

        const pnl = outcome === 'TP'
            ? (type === 'BUY' ? tp - entry : entry - tp)
            : (type === 'BUY' ? sl - entry : entry - sl);

        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const row  = document.createElement('tr');
        row.innerHTML = `
            <td>${time}</td>
            <td>${symbol || '—'}</td>
            <td>—</td>
            <td><span class="trade-badge trade-${type.toLowerCase()}">${type}</span></td>
            <td>${parseFloat(entry).toFixed(5)}</td>
            <td>—</td>
            <td>${parseFloat(sl).toFixed(5)}</td>
            <td>${parseFloat(tp).toFixed(5)}</td>
            <td><span class="trade-badge trade-${outcome.toLowerCase()}">${outcome}</span></td>
            <td style="color:${pnl >= 0 ? 'var(--accent2)' : 'var(--accent3)'}">
                ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </td>
        `;

        // Prepend so newest is at the top
        tbody.insertBefore(row, tbody.firstChild);

        // Cap at 50 rows
        if (tbody.children.length > 50) tbody.lastChild.remove();
    }
};