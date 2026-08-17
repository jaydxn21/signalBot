// js/auth.js
// Client-side auth helper.
// All pages import this and call Auth.guard() at the top to ensure the user
// is logged in (or in guest mode) before the page runs.
//
// Usage in any page:
//   import { Auth } from './js/auth.js';
//   Auth.guard();   // redirects to login.html if not authenticated

// Compute API base URL once at module load.
// Empty string = same origin (localhost dev).
const _RENDER_URL = 'https://bot.atomicprod.shop'; // ← matches actual deployed Render service
const _API_BASE = (typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1')
    ? _RENDER_URL
    : '';

export const Auth = {
    // ── Read stored session ───────────────────────────────────────────────
    get() {
        try {
            const raw = localStorage.getItem('nexus_auth');
            if (!raw) return null;
            const auth = JSON.parse(raw);
            if (!auth.exp || Date.now() > auth.exp) {
                localStorage.removeItem('nexus_auth');
                return null;
            }
            return auth;
        } catch { return null; }
    },

    // ── Redirect to login if not authenticated ────────────────────────────
    guard() {
        if (!this.get()) window.location.replace('login.html');
    },

    // ── Current user info ─────────────────────────────────────────────────
    user() {
        const auth = this.get();
        return auth ? { userId: auth.userId, username: auth.username, guest: !!auth.guest } : null;
    },

    isGuest() {
        return !!this.get()?.guest;
    },

    token() {
        return this.get()?.token || null;
    },

    // ── Auth headers for API calls ────────────────────────────────────────
    headers() {
        const t = this.token();
        return t ? { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    },

    // ── Logout ────────────────────────────────────────────────────────────
    logout() {
        localStorage.removeItem('nexus_auth');
        window.location.replace('login.html');
    },

    // ── Cloud sync: push trades to server ────────────────────────────────
    async syncTrades(trades) {
        if (this.isGuest() || !trades?.length) return;
        try {
            await fetch(`${_API_BASE}/api/user/trades`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ trades }),
            });
        } catch(_) {} // silent — local storage is the source of truth
    },

    // ── Cloud sync: fetch trades from server ──────────────────────────────
    async fetchTrades() {
        if (this.isGuest()) return null;
        try {
            const r = await fetch(`${_API_BASE}/api/user/trades`, { headers: this.headers() });
            if (!r.ok) return null;
            const d = await r.json();
            return d.trades || null;
        } catch { return null; }
    },

    // ── Cloud sync: push heartbeat (device actually running bots) ─────────
    // Fires frequently (every few seconds) from whichever device has the
    // bot terminal open, so any OTHER device can tell "is a bot running
    // somewhere right now" instead of only knowing about itself.
    async syncHeartbeat({ heartbeatAt, lastCandleAt, activeBots }) {
        if (this.isGuest()) return;
        try {
            await fetch(`${_API_BASE}/api/user/heartbeat`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ heartbeatAt, lastCandleAt, activeBots }),
            });
        } catch(_) {} // silent — high frequency, failures shouldn't be noisy
    },

    // ── Cloud sync: fetch heartbeat (is ANY device running bots right now) ─
    async fetchHeartbeat() {
        if (this.isGuest()) return null;
        try {
            const r = await fetch(`${_API_BASE}/api/user/heartbeat`, { headers: this.headers() });
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    },

    // ── Cloud sync: push settings ─────────────────────────────────────────
    async syncSettings(settings) {
        if (this.isGuest()) return;
        try {
            await fetch(`${_API_BASE}/api/user/settings`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ settings }),
            });
        } catch(_) {}
    },

    // ── Cloud sync: fetch settings ────────────────────────────────────────
    async fetchSettings() {
        if (this.isGuest()) return null;
        try {
            const r = await fetch(`${_API_BASE}/api/user/settings`, { headers: this.headers() });
            if (!r.ok) return null;
            const d = await r.json();
            return d.settings || null;
        } catch { return null; }
    },

    // ── Cloud sync: save strategy ─────────────────────────────────────────
    async saveStrategy(name, strategy) {
        if (this.isGuest()) return false;
        try {
            const r = await fetch(`${_API_BASE}/api/user/strategies`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ name, strategy }),
            });
            return r.ok;
        } catch { return false; }
    },

    // ── Cloud sync: fetch strategies ──────────────────────────────────────
    async fetchStrategies() {
        if (this.isGuest()) return null;
        try {
            const r = await fetch(`${_API_BASE}/api/user/strategies`, { headers: this.headers() });
            if (!r.ok) return null;
            const d = await r.json();
            return d.strategies || null;
        } catch { return null; }
    },
};

// Exported so other modules (e.g. dashboard.js) can reuse the same base URL
// instead of hardcoding it a second time.
export const API_BASE = _API_BASE;