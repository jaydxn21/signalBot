// js/session-state.js
// Shared session state across all pages via sessionStorage.
// Import this directly — never import SessionState from nav.js.

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
            return raw ? { ...this._defaults(), ...JSON.parse(raw) } : this._defaults();
        } catch { return this._defaults(); }
    },

    set(partial) {
        try {
            const current = this.get();
            sessionStorage.setItem(this._key, JSON.stringify({ ...current, ...partial }));
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
    },
};