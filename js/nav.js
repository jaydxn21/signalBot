// js/nav.js
// Shared across every page.
// Handles: nav rail, clock, wave canvas, heartbeat indicator.
// SessionState lives in session-state.js to avoid duplicate module issues.

export { SessionState } from './session-state.js';
import { SessionState } from './session-state.js';
import { Auth }         from './auth.js';

// Guard — redirect to login if not authenticated (guest mode passes through)
// Runs immediately but only on non-login pages
const _onLoginPage = window.location.pathname.endsWith('login.html') ||
                     window.location.pathname === '/login.html';
if (!_onLoginPage) {
    Auth.guard();
}

// ─────────────────────────────────────────────────────────────
// NAV RAIL — highlights current page
// ─────────────────────────────────────────────────────────────
function initNav() {
    const path = window.location.pathname;

    const pageMap = {
        'index.html':     'terminal',
        '/':              'terminal',
        'market.html':    'market',
        'analytics.html': 'analytics',
        'journal.html':   'history',
        'backtest.html':  'backtest',
        'strategy-builder.html': 'builder',
        'settings.html':  'settings',
    };

    const current = Object.entries(pageMap).find(([k]) => path.endsWith(k))?.[1] || 'terminal';

    document.querySelectorAll('.nav-item[data-page]').forEach(el => {
        if (el.dataset.page === current) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
        el.style.cursor = 'pointer';
        el.onclick = () => {
            const pageFile = Object.entries(pageMap).find(([, v]) => v === el.dataset.page)?.[0];
            if (pageFile && !pageFile.startsWith('/')) {
                window.location.href = pageFile;
            }
        };

        el.addEventListener('mouseenter', () => {
            let tip = document.getElementById('nexus-nav-tip');
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'nexus-nav-tip';
                tip.style.cssText = `
                    position: fixed;
                    background: #0f172a;
                    color: #f1f5f9;
                    font-size: 0.58rem;
                    font-weight: 600;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    padding: 5px 10px;
                    border-radius: 6px;
                    pointer-events: none;
                    z-index: 99999;
                    white-space: nowrap;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                    transition: opacity 0.1s;
                    font-family: 'DM Mono', monospace;
                `;
                document.body.appendChild(tip);
            }
            const label = el.querySelector('.nav-tooltip')?.textContent
                || el.dataset.page || '';
            tip.textContent = label;
            tip.style.opacity = '0';
            tip.style.display = 'block';

            const rect = el.getBoundingClientRect();
            tip.style.left = (rect.right + 10) + 'px';
            tip.style.top  = (rect.top + (rect.height - tip.offsetHeight) / 2) + 'px';
            tip.style.opacity = '1';
        });

        el.addEventListener('mouseleave', () => {
            const tip = document.getElementById('nexus-nav-tip');
            if (tip) tip.style.display = 'none';
        });
    });

    _updateStatusDots();
}

function _updateStatusDots() {
    const state = SessionState.get();
    const connDot   = document.getElementById('connection-indicator');
    const connLabel = document.getElementById('conn-label');
    const mt5Dot    = document.getElementById('mt5-indicator');

    if (connDot) {
        connDot.className = state.connected
            ? 'status-dot status-online'
            : 'status-dot status-offline';
    }
    if (connLabel) {
        connLabel.textContent = state.connected ? 'Online' : 'Offline';
    }
    if (mt5Dot) {
        mt5Dot.className = state.mt5Connected
            ? 'status-dot status-online'
            : 'status-dot status-offline';
    }
}

// ─────────────────────────────────────────────────────────────
// HEARTBEAT INDICATOR
// Tracks two independent things:
//  - heartbeatAt: is the tab/JS loop actually alive? (signal-bot.js pings
//    this every 5s while running). If this goes stale, the bot page itself
//    isn't running — closed tab, crashed script, laptop asleep, etc.
//  - lastCandleAt: is Deriv actually sending data? If the tab is alive but
//    no candle/tick has arrived in a while, the WebSocket has silently
//    stalled even though `connected` might still read true.
// ─────────────────────────────────────────────────────────────
function _timeAgoLabel(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function _updateHeartbeat() {
    const el = document.getElementById('heartbeat-chip');
    const dot = document.getElementById('heartbeat-dot');
    const label = document.getElementById('heartbeat-label');
    if (!el || !dot || !label) return;

    const state = SessionState.get();
    const now = Date.now();

    // "Alive" = a heartbeat ping landed within the last 12s (pings fire
    // every 5s, so this gives margin for a couple of missed ticks without
    // false-flagging).
    const tabAlive   = state.heartbeatAt && (now - state.heartbeatAt) < 12000;
    // "Data flowing" = a candle/tick arrived within the last 90s. Bots can
    // legitimately go quiet between candle closes, so this window is wider
    // than the tab-alive check.
    const dataFlowing = state.lastCandleAt && (now - state.lastCandleAt) < 90000;

    let color, text;
    if (!tabAlive) {
        color = 'status-offline';
        text  = 'Not running';
    } else if (!dataFlowing) {
        color = 'status-warn';
        text  = `No data · ${_timeAgoLabel(state.lastCandleAt)}`;
    } else {
        color = 'status-online';
        text  = `Live · ${_timeAgoLabel(state.lastCandleAt)}`;
    }

    dot.className = `status-dot ${color}`;
    label.textContent = text;
    el.title = tabAlive
        ? `Tab active · last candle ${_timeAgoLabel(state.lastCandleAt)}`
        : `Tab has not pinged since ${_timeAgoLabel(state.heartbeatAt)} — bot page may be closed or asleep`;
}

// ─────────────────────────────────────────────────────────────
// CLOCK
// ─────────────────────────────────────────────────────────────
function initClock() {
    const pad = n => String(n).padStart(2, '0');
    function tick() {
        const now = new Date();
        const ja  = new Date(now.getTime() - 5 * 60 * 60 * 1000);
        const cl  = document.getElementById('clock');
        const dt  = document.getElementById('utc-date');
        if (cl) cl.textContent = `${pad(ja.getUTCHours())}:${pad(ja.getUTCMinutes())}:${pad(ja.getUTCSeconds())}`;
        if (dt) {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            dt.textContent = `${ja.getUTCDate()} ${months[ja.getUTCMonth()]} ${ja.getUTCFullYear()} EST`;
        }
    }
    setInterval(tick, 1000);
    tick();
}

// ─────────────────────────────────────────────────────────────
// WAVE CANVAS
// ─────────────────────────────────────────────────────────────
function initWaves() {
    const canvas = document.getElementById('wave-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, t = 0;

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    const waves = [
        { amp: 35, freq: 0.0038, speed: 0.005, y: 0.22, color: 'rgba(37,99,235,0.10)',   lw: 1.2 },
        { amp: 50, freq: 0.0028, speed: 0.003, y: 0.42, color: 'rgba(148,163,184,0.13)', lw: 1.5 },
        { amp: 30, freq: 0.0055, speed: 0.008, y: 0.58, color: 'rgba(37,99,235,0.08)',   lw: 1.0 },
        { amp: 45, freq: 0.0022, speed: 0.004, y: 0.72, color: 'rgba(100,130,200,0.10)', lw: 1.6 },
        { amp: 25, freq: 0.0068, speed: 0.010, y: 0.88, color: 'rgba(148,163,184,0.09)', lw: 0.9 },
    ];

    const gridLines = Array.from({ length: 8 }, (_, i) => ({
        x:     (W / 8) * i,
        speed: 0.12 + (i % 3) * 0.06,
        color: `rgba(37,99,235,${0.03 + (i % 4) * 0.012})`,
        width: 0.5 + (i % 3) * 0.3,
    }));

    const dots = Array.from({ length: 18 }, () => ({
        x:     Math.random() * 1400,
        y:     Math.random() * 900,
        r:     0.8 + Math.random() * 1.4,
        vx:    (Math.random() - 0.5) * 0.25,
        vy:    (Math.random() - 0.5) * 0.25,
        alpha: 0.08 + Math.random() * 0.12,
    }));

    function draw() {
        ctx.clearRect(0, 0, W, H);

        gridLines.forEach(gl => {
            gl.x = (gl.x + gl.speed) % (W + 200);
            ctx.beginPath();
            ctx.strokeStyle = gl.color;
            ctx.lineWidth   = gl.width;
            ctx.moveTo(gl.x, 0);
            ctx.lineTo(gl.x - H * 0.4, H);
            ctx.stroke();
        });

        dots.forEach(d => {
            d.x += d.vx;
            d.y += d.vy;
            if (d.x < 0) d.x = W;
            if (d.x > W) d.x = 0;
            if (d.y < 0) d.y = H;
            if (d.y > H) d.y = 0;

            ctx.beginPath();
            ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(37,99,235,${d.alpha})`;
            ctx.fill();
        });

        waves.forEach(w => {
            ctx.beginPath();
            ctx.strokeStyle = w.color;
            ctx.lineWidth   = w.lw;
            ctx.moveTo(0, H * w.y + Math.sin(t * w.speed) * w.amp);
            for (let x = 0; x <= W; x += 3) {
                const y = H * w.y
                    + Math.sin(x * w.freq + t * w.speed) * w.amp
                    + Math.sin(x * w.freq * 0.5 + t * w.speed * 0.7) * (w.amp * 0.4);
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        });

        t += 1;
        requestAnimationFrame(draw);
    }
    draw();
}

// ─────────────────────────────────────────────────────────────
// SHARED HEADER HTML
// ─────────────────────────────────────────────────────────────
function injectSharedHTML() {
    const navEl = document.getElementById('nexus-nav');
    if (navEl) {
        navEl.innerHTML = `
        <nav id="nav-rail">
            <div class="nav-logo">NXS</div>
            <div class="nav-item" data-page="terminal">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                <span class="nav-tooltip">Terminal</span>
            </div>
            <div class="nav-item" data-page="market">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
                <span class="nav-tooltip">Market</span>
            </div>
            <div class="nav-item" data-page="analytics">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 10l3 3 3-3 4 4"/></svg>
                <span class="nav-tooltip">Analytics</span>
            </div>
            <div class="nav-item" data-page="history">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
                <span class="nav-tooltip">Journal</span>
            </div>
            <div class="nav-item" data-page="backtest">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="3" x2="19" y2="21"/></svg>
                <span class="nav-tooltip">Backtest</span>
            </div>
            <div class="nav-item" data-page="builder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M3 17h4m-2-2v4"/></svg>
                <span class="nav-tooltip">Strategy Builder</span>
            </div>
            <div class="nav-spacer"></div>
            <div class="nav-item" data-page="settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                <span class="nav-tooltip">Settings</span>
            </div>
        </nav>`;
    }

    const headerEl = document.getElementById('nexus-header');
    if (headerEl) {
        headerEl.innerHTML = `
        <header>
            <div style="display:flex;align-items:center;">
                <span class="nexus-logo">NEXUS</span>
                <div class="header-status">
                    <div class="status-chip">
                        <div id="connection-indicator" class="status-dot status-offline"></div>
                        <span id="conn-label">Offline</span>
                    </div>
                    <div class="status-chip">
                        <div id="mt5-indicator" class="status-dot status-offline"></div>
                        <span>MT5 Bridge</span>
                    </div>
                    <div class="status-chip" id="heartbeat-chip" title="Bot liveness">
                        <div id="heartbeat-dot" class="status-dot status-offline"></div>
                        <span id="heartbeat-label">Not running</span>
                    </div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:14px;">
                <div style="text-align:right;">
                    <div id="clock">00:00:00</div>
                    <div id="utc-date">EST</div>
                </div>
                <button id="btn-logout">Logout ×</button>
            </div>
        </header>`;
    }
}

// ─────────────────────────────────────────────────────────────
// BOOT — runs on every page
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    injectSharedHTML();
    initNav();
    initClock();
    initWaves();

    // Heartbeat: check every 2s so the badge reacts quickly if the bot
    // page/tab dies, and pick up cross-tab updates via the storage event.
    _updateHeartbeat();
    setInterval(_updateHeartbeat, 2000);
    window.addEventListener('storage', (e) => {
        if (e.key === 'nexus_session') _updateHeartbeat();
    });

    const user    = Auth.user();
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        if (user) logoutBtn.textContent = `${user.username} ×`;
        logoutBtn.onclick = () => Auth.logout();
    }
});