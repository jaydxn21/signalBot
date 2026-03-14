// js/config.js
// ─────────────────────────────────────────────────────────────
// Single place to configure the API base URL.
//
// LOCAL DEV:
//   Leave as-is — points to localhost:3000
//
// PRODUCTION (Netlify frontend + Render backend):
//   Change API_BASE to your Render web service URL, e.g.:
//   export const API_BASE = 'https://nexus-api.onrender.com';
//
// You can also set this automatically by checking the hostname:
//   const isProd = window.location.hostname !== 'localhost';
//   export const API_BASE = isProd ? 'https://nexus-api.onrender.com' : '';
// ─────────────────────────────────────────────────────────────

const _isProd = window.location.hostname !== 'localhost' &&
                window.location.hostname !== '127.0.0.1';

// ── SET YOUR RENDER URL HERE BEFORE DEPLOYING ──────────────────
const RENDER_URL = 'https://nexus-api.onrender.com'; // ← change this
// ───────────────────────────────────────────────────────────────

export const API_BASE = _isProd ? RENDER_URL : '';

// Usage in any module:
//   import { API_BASE } from '../config.js';
//   fetch(`${API_BASE}/api/auth/login`, { ... })