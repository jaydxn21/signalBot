// js/session-state.js
// Shared session state across all pages via sessionStorage.
// P&L, wins, losses, trades are also mirrored to localStorage with a daily key
// so they survive page refreshes but reset at midnight (new trading day).

const _pnlKey = () => {
    const d = new Date();
    return `nexus_pnl_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
};

export const SessionState = {
    _key: 'nexus_session',

    _defaults() {
        return {
            connected:    false,
            mt5Connected: false,
            activeBots:   0,
            winRate:      0,
            wins:         0,
            losses:       0,
            sessionPnL:   0,
            trades:       [],
            livePrices:   {},
            botConfigs:   [],
        };
    },

    get() {
        try {
            const raw = sessionStorage.getItem(this._key);
            const state = raw ? { ...this._defaults(), ...JSON.parse(raw) } : this._defaults();

            // On a cold start (no sessionStorage), restore P&L/trades from today's localStorage
            if (!raw) {
                try {
                    const persisted = localStorage.getItem(_pnlKey());
                    if (persisted) {
                        const p = JSON.parse(persisted);
                        state.sessionPnL = p.sessionPnL ?? 0;
                        state.wins       = p.wins       ?? 0;
                        state.losses     = p.losses     ?? 0;
                        state.winRate    = p.winRate    ?? 0;
                        state.trades     = p.trades     ?? [];
                        // Write back to sessionStorage so subsequent .get() calls are fast
                        sessionStorage.setItem(this._key, JSON.stringify(state));
                    }
                } catch(_) {}
            }
            return state;
        } catch { return this._defaults(); }
    },

    set(partial) {
        try {
            const current = this.get();
            const next = { ...current, ...partial };
            sessionStorage.setItem(this._key, JSON.stringify(next));

            // Mirror P&L-related fields to localStorage for refresh persistence
            if ('sessionPnL' in partial || 'wins' in partial || 'losses' in partial || 'trades' in partial) {
                const toStore = {
                    sessionPnL: next.sessionPnL,
                    wins:       next.wins,
                    losses:     next.losses,
                    winRate:    next.winRate,
                    trades:     next.trades.slice(0, 200),
                };
                try { localStorage.setItem(_pnlKey(), JSON.stringify(toStore)); } catch(_) {}
            }
        } catch(e) { console.warn('[SessionState] write failed:', e); }
    },

    pushTrade(trade) {
        try {
            const current = this.get();
            const trades  = [trade, ...current.trades].slice(0, 200);
            this.set({ trades });
        } catch(e) { console.warn('[SessionState] pushTrade failed:', e); }
    },

    clear() {
        sessionStorage.removeItem(this._key);
        try { localStorage.removeItem(_pnlKey()); } catch(_) {}
    },
};