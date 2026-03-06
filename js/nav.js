// js/nav.js
// Shared across every page.
// Handles: nav rail, clock, wave canvas.
// SessionState lives in session-state.js to avoid duplicate module issues.

export { SessionState } from './session-state.js';
import { SessionState } from './session-state.js';

// ─────────────────────────────────────────────────────────────
// NAV RAIL — highlights current page
// ─────────────────────────────────────────────────────────────
function initNav() {
    const path = window.location.pathname;

    // Map pathname endings to nav item data-page values
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

        // Body-injected tooltip — bypasses all overflow/z-index clipping
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

    // Update connection status dots from session state
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
// CLOCK
// ─────────────────────────────────────────────────────────────
function initClock() {
    const pad = n => String(n).padStart(2, '0');
    function tick() {
        // Jamaica time = UTC-5, no DST
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

    // ── Sine waves ───────────────────────────────────────────
    const waves = [
        { amp: 35, freq: 0.0038, speed: 0.005, y: 0.22, color: 'rgba(37,99,235,0.10)',   lw: 1.2 },
        { amp: 50, freq: 0.0028, speed: 0.003, y: 0.42, color: 'rgba(148,163,184,0.13)', lw: 1.5 },
        { amp: 30, freq: 0.0055, speed: 0.008, y: 0.58, color: 'rgba(37,99,235,0.08)',   lw: 1.0 },
        { amp: 45, freq: 0.0022, speed: 0.004, y: 0.72, color: 'rgba(100,130,200,0.10)', lw: 1.6 },
        { amp: 25, freq: 0.0068, speed: 0.010, y: 0.88, color: 'rgba(148,163,184,0.09)', lw: 0.9 },
    ];

    // ── Animated grid lines ──────────────────────────────────
    // Diagonal lines that drift slowly across the background
    const gridLines = Array.from({ length: 8 }, (_, i) => ({
        x:     (W / 8) * i,
        speed: 0.12 + (i % 3) * 0.06,
        color: `rgba(37,99,235,${0.03 + (i % 4) * 0.012})`,
        width: 0.5 + (i % 3) * 0.3,
    }));

    // ── Floating dots ────────────────────────────────────────
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

        // Draw animated diagonal grid lines
        gridLines.forEach(gl => {
            gl.x = (gl.x + gl.speed) % (W + 200);
            ctx.beginPath();
            ctx.strokeStyle = gl.color;
            ctx.lineWidth   = gl.width;
            // Diagonal from top-right to bottom-left offset
            ctx.moveTo(gl.x, 0);
            ctx.lineTo(gl.x - H * 0.4, H);
            ctx.stroke();
        });

        // Draw floating dots
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

        // Draw sine waves on top
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
// Injected into every page so you only maintain it in one place.
// Each page just needs: <div id="nexus-header"></div>
//                       <div id="nexus-nav"></div>
// ─────────────────────────────────────────────────────────────
function injectSharedHTML() {
    // Nav rail
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

    // Header
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
});