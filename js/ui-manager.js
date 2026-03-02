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
            el.innerText  = `${rate}% (${this._wins}W / ${this._losses}L)`;
            el.className  = `text-right font-mono text-xs ${
                total === 0       ? 'text-white' :
                rate >= 50        ? 'text-emerald-400' : 'text-red-400'
            }`;
        }
    },

    _updateSessionTimer() {
        if (!this._startTime) return;
        const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
        const hrs  = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const mins = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        const el   = document.getElementById('session-timer');
        if (el) el.innerText = `${hrs}:${mins}:${secs}`;
        const pnlEl = document.getElementById('session-pnl');
        if (pnlEl) {
            pnlEl.innerText = `Est. P&L: ${this._signalPnL >= 0 ? '+' : ''}${this._signalPnL.toFixed(2)}`;
            pnlEl.className = `text-xs font-mono ${this._signalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
        }
    },

    updateHUD(rsi, atr, marketCondition) {
        if (rsi !== null && rsi !== undefined) {
            document.getElementById('rsi-value').innerText = rsi.toFixed(1);
        }
        if (atr !== null && atr !== undefined) {
            document.getElementById('atr-value').innerText = atr.toFixed(4);
        }
        if (marketCondition !== undefined) {
            const el = document.getElementById('daily-bias');
            if (el) {
                el.innerText  = marketCondition;
                el.className  = `text-right font-mono text-xs ${
                    marketCondition === 'TRENDING' ? 'text-emerald-400' :
                    marketCondition === 'RANGING'  ? 'text-amber-400'   : 'text-slate-500'
                }`;
            }
        }
    },

    log(msg, classes = '') {
        const container = document.getElementById('logs');
        if (!container) return;
        const div = document.createElement('div');
        div.className = `py-1 border-b border-slate-800 text-[10px] ${classes}`;
        div.innerHTML = `<span class="opacity-50 mr-2">[${new Date().toLocaleTimeString()}]</span> ${msg}`;
        container.prepend(div);
        if (container.children.length > 50) container.lastChild.remove();
    },

    setConnectionStatus(connected) {
        const dot = document.getElementById('connection-indicator');
        if (dot) dot.className = connected ?
            'w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_10px_#22d3ee]' :
            'w-3 h-3 rounded-full bg-red-500 shadow-[0_0_10px_red]';
    },

    addTradeHistory(type, entry, sl, tp, outcome) {
        const empty = document.getElementById('trade-history-empty');
        if (empty) empty.style.display = 'none';

        const container = document.getElementById('trade-history');
        if (!container) return;

        const pnl   = outcome === 'TP'
            ? (type === 'BUY' ? tp - entry : entry - tp)
            : (type === 'BUY' ? sl - entry : entry - sl);
        const color = outcome === 'TP' ? 'text-emerald-400' : 'text-red-400';
        const row   = document.createElement('div');
        row.className = `grid grid-cols-5 gap-1 text-[9px] font-mono py-1 border-b border-slate-800/50 ${color}`;
        row.innerHTML = `
            <span>${new Date().toLocaleTimeString()}</span>
            <span>${type}</span>
            <span>${parseFloat(entry).toFixed(2)}</span>
            <span class="font-bold">${outcome}</span>
            <span>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>
        `;
        container.prepend(row);
        if (container.children.length > 10) container.lastChild.remove();
    }
};