// storage.js — Deriv token + misc local persistence helpers

const TOKEN_KEY = 'deriv_token';

export const Storage = {
    getToken() {
        return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
    },

    saveToken(token, remember = true) {
        if (remember) {
            localStorage.setItem(TOKEN_KEY, token);
        } else {
            sessionStorage.setItem(TOKEN_KEY, token);
        }
    },

    clearToken() {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
    },

    // Generic helpers
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw !== null ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    },

    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    },

    remove(key) {
        localStorage.removeItem(key);
    }
};