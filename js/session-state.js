// js/session-state.js
// Shared session state across all pages via sessionStorage.
// P&L, wins, losses, trades are also mirrored to localStorage with a daily key
// so they survive page refreshes but reset at midnight (new trading day).
//
// Trades are also synced to the cloud (Supabase, via Auth) so a login on
// another device can pick up where this one left off.

import { Auth } from './auth.js';

const _pnlKey = () => {
    const d = new Date();
    return `nexus_pnl_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
};

// Dedup key used to avoid double-counting the same trade locally vs from the cloud.
function _tradeKey(t) {
    return `${t.time ?? ''}|${t.symbol ?? ''}`;
}

function _mergeTrades(localTrades, cloudTrades) {
    const seen = new Set(localTrades.map(_tradeKey));
    const merged = [...localTrades];
    for (const t of cloudTrades) {
        const k = _tradeKey(t);
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(t);
        }
    }
    // Keep newest first, same convention as pushTrade
    merged.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    return merged.slice(0, 200);
}

export const SessionState = {
    _key: 'nexus_session',
    _hydrated: false,

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

            // Fire-and-forget cloud sync — silent on failure (guest mode, offline, etc.)
            Auth.syncTrades([trade]);
        } catch(e) { console.warn('[SessionState] pushTrade failed:', e); }
    },

    // ── Cloud sync: pull trades from the account and merge with what's local ──
    // Call this once per page load (e.g. right after Auth.guard()) so a second
    // device catches up on trades recorded elsewhere.
    async hydrateFromCloud() {
        if (this._hydrated) return this.get();
        this._hydrated = true;

        try {
            const cloudTrades = await Auth.fetchTrades();
            if (!cloudTrades || !cloudTrades.length) return this.get();

            const current = this.get();
            const merged  = _mergeTrades(current.trades, cloudTrades);

            // Recompute derived stats from the merged trade list so wins/losses/PnL
            // stay consistent after pulling in trades from another device.
            const wins    = merged.filter(t => t.outcome === 'TP').length;
            const losses  = merged.filter(t => t.outcome === 'SL').length;
            const total   = wins + losses;
            const winRate = total ? Math.round((wins / total) * 100) : 0;
            const sessionPnL = merged.reduce((s, t) => {
                if (t.outcome === 'TP') return s + (t.pnl || 0);
                if (t.outcome === 'SL') return s - (t.pnl || 0);
                return s;
            }, 0);

            this.set({ trades: merged, wins, losses, winRate, sessionPnL });
        } catch(e) {
            console.warn('[SessionState] hydrateFromCloud failed:', e);
        }
        return this.get();
    },

    clear() {
        sessionStorage.removeItem(this._key);
        try { localStorage.removeItem(_pnlKey()); } catch(_) {}
        this._hydrated = false;
    },
};