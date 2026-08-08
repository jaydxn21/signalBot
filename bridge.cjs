// ═══════════════════════════════════════════════════════════════════════════
// NEXUS Signal Queue Bridge v3.0 - FIRESTORE DIRECT SYNC EDITION
// ═══════════════════════════════════════════════════════════════════════════
// NEW (v3.0):
// - Direct sync with Firebase Firestore for bot state (pause, resume, emergency stop)
// - Eliminates local control endpoints and tunnel dependency
// - Full real-time synchronization via admin.firestore().onSnapshot()

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const WS_PORT = 3000;
const HTTP_PORT = 8080;
const RENDER_URL = 'wss://nexus-api-khvt.onrender.com/mt5';
const TRADE_HISTORY_FILE = path.join(__dirname, 'mt5_trades.json');

// ═════════════════════════════════════════════════════════════════════════
// FIREBASE ADMIN INITIALIZATION & FIRESTORE CONTROL
// ═════════════════════════════════════════════════════════════════════════
const serviceAccount = require(path.join(__dirname, 'firebase-service-account.json'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Real-time local state tracking
let botState = {
    tradingPaused: false,   // pause new trades only
    emergencyStop: false,   // stop-all — blocks new trades AND flattens
    lastCommandAt: null,
    lastCommandSource: null
};

// Listen to Firestore document 'botControl/status'
console.log('[FIRESTORE] Listening for control state updates on botControl/status...');
db.collection('botControl').doc('status').onSnapshot(docSnapshot => {
    if (docSnapshot.exists) {
        const data = docSnapshot.data();
        const prevStopped = botState.emergencyStop;
        
        botState.tradingPaused = !!data.isPaused;
        botState.emergencyStop = !!data.isStopped;
        botState.lastCommandAt = data.updatedAt || Date.now();
        botState.lastCommandSource = data.updatedBy || 'firestore';

        log(`State Updated -> Paused: ${botState.tradingPaused} | Emergency Stop: ${botState.emergencyStop}`, 'control');

        // Trigger action on transition to Emergency Stop
        if (!prevStopped && botState.emergencyStop) {
            log('EMERGENCY STOP RECEIVED FROM FIRESTORE -> Flushing queue & broadcasting flatten command', 'warn');
            signalQueue.clear();
            broadcastCommand({ type: 'command', action: 'flatten_all', timestamp: Date.now() });
        }
    } else {
        log('botControl/status doc missing. Creating initial status document...', 'warn');
        db.collection('botControl').doc('status').set({
            isPaused: false,
            isStopped: false,
            updatedAt: Date.now(),
            updatedBy: 'system'
        });
    }
}, err => {
    log(`Firestore Sync Error: ${err.message}`, 'error');
});

// ═════════════════════════════════════════════════════════════════════════
// SYMBOL MINIMUM LOT MAPPING (Matches EA v9.6)
// ═════════════════════════════════════════════════════════════════════════
const SYMBOL_MIN_LOTS = {
    'Volatility 50 Index': 4.0, 'Volatility 25 Index': 2.0, 'Volatility 10 Index': 1.0,
    'Volatility 75 Index': 0.01, 'Volatility 100 Index': 4.0,
    'Jump 50 Index': 4.0, 'Jump 25 Index': 2.0, 'Jump 10 Index': 1.0,
    'Jump 75 Index': 0.01, 'Jump 100 Index': 4.0,
    'Crash 500 Index': 0.01, 'Crash 1000 Index': 0.01,
    'Boom 500 Index': 0.01, 'Boom 1000 Index': 0.01,
    'Step Index 100': 0.01,
    'EURUSD': 0.01, 'GBPUSD': 0.01, 'USDJPY': 0.01, 'AUDUSD': 0.01,
    'USDCAD': 0.01, 'USDCHF': 0.01, 'BTCUSD': 0.01, 'ETHUSD': 0.01,
    'XAUUSD': 0.01, 'XAGUSD': 0.01
};

function getAdjustedLotSize(symbol, requestedLot) {
    const minLot = SYMBOL_MIN_LOTS[symbol] || 0.01;
    const adjustedLot = Math.max(requestedLot, minLot);
    if (adjustedLot !== requestedLot) {
        console.log(`[VOLUME] Adjusted lot for ${symbol}: ${requestedLot} → ${adjustedLot} (min: ${minLot})`);
    }
    const maxLot = 10.0;
    if (adjustedLot > maxLot) {
        console.log(`[VOLUME] Capping lot for ${symbol}: ${adjustedLot} → ${maxLot}`);
        return maxLot;
    }
    return adjustedLot;
}

// ═════════════════════════════════════════════════════════════════════════
// PERSISTENT TRADE STORAGE
// ═════════════════════════════════════════════════════════════════════════
class TradeHistory {
    constructor() { this.trades = []; this.load(); }
    load() {
        try {
            if (fs.existsSync(TRADE_HISTORY_FILE)) {
                const data = fs.readFileSync(TRADE_HISTORY_FILE, 'utf8');
                this.trades = JSON.parse(data);
                console.log(`[STORAGE] Loaded ${this.trades.length} trades from disk`);
            }
        } catch (e) {
            console.error('[STORAGE] Failed to load trades:', e.message);
            this.trades = [];
        }
    }
    save() {
        try {
            if (this.trades.length > 2000) this.trades = this.trades.slice(-2000);
            fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(this.trades, null, 2));
        } catch (e) { console.error('[STORAGE] Failed to save trades:', e.message); }
    }
    addTrade(trade) {
        this.trades.unshift({ ...trade, received_at: Date.now() });
        this.save();
        console.log(`[STORAGE] Added trade #${this.trades.length}: ${trade.symbol} ${trade.action} PnL: ${trade.pnl}`);
    }
    getAllTrades() { return this.trades; }
    getRecentTrades(limit = 100) { return this.trades.slice(0, limit); }
    getStats() {
        const closed = this.trades.filter(t => t.pnl !== undefined && t.pnl !== null);
        const wins = closed.filter(t => t.pnl > 0);
        const losses = closed.filter(t => t.pnl < 0);
        const netPnL = closed.reduce((s, t) => s + (t.pnl || 0), 0);
        return {
            total_trades: closed.length,
            wins: wins.length,
            losses: losses.length,
            win_rate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
            net_pnl: netPnL,
            avg_win: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
            avg_loss: losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0,
            profit_factor: losses.length && wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))) : wins.length ? 999 : 0,
            best_trade: wins.length ? Math.max(...wins.map(t => t.pnl)) : 0,
            worst_trade: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
            last_update: Date.now()
        };
    }
}
const tradeHistory = new TradeHistory();

// ═════════════════════════════════════════════════════════════════════════
// SIGNAL QUEUE
// ═════════════════════════════════════════════════════════════════════════
class SignalQueue {
    constructor(maxSize = 100) { this.queue = []; this.maxSize = maxSize; this.processedCount = 0; }
    push(signal) {
        if (!signal.action || !signal.symbol) {
            console.log('[QUEUE] Invalid signal rejected:', signal);
            return false;
        }
        const normalizedSignal = {
            action: signal.action.toLowerCase(),
            symbol: signal.symbol,
            price: signal.price || 0,
            sl: signal.sl || 0,
            tp: signal.tp || 0,
            volume: signal.volume || signal.lotSize || 0.01,
            lotSize: signal.lotSize || signal.volume || 0.01,
            qualityScore: signal.qualityScore || signal.score || 50,
            aiScore: signal.aiScore || 50,
            timestamp: signal.timestamp || Date.now(),
            source: signal.source || 'unknown'
        };
        console.log(`[QUEUE] Received signal from ${normalizedSignal.source}: ${normalizedSignal.action} ${normalizedSignal.symbol} | Quality: ${normalizedSignal.qualityScore}% | AI: ${normalizedSignal.aiScore}%`);
        normalizedSignal.volume = getAdjustedLotSize(normalizedSignal.symbol, normalizedSignal.volume);
        if (this.queue.length >= this.maxSize) this.queue.shift();
        this.queue.push(normalizedSignal);
        console.log(`[QUEUE] Signal queued: ${normalizedSignal.action} ${normalizedSignal.symbol} @ ${normalizedSignal.volume} lots | Q:${normalizedSignal.qualityScore}%`);
        return true;
    }
    pop() {
        if (this.queue.length > 0) {
            const signal = this.queue.shift();
            this.processedCount++;
            console.log(`[QUEUE] Signal retrieved. Remaining: ${this.queue.length} | Quality: ${signal.qualityScore}%`);
            return signal;
        }
        return null;
    }
    size() { return this.queue.length; }
    clear() { this.queue = []; console.log(`[QUEUE] Queue cleared`); }
}
const signalQueue = new SignalQueue();

// ═════════════════════════════════════════════════════════════════════════
// FLOATING PnL STORAGE
// ═════════════════════════════════════════════════════════════════════════
let latestFloatingPnL = { equity: 0, balance: 0, floating_pnl: 0, timestamp: 0, last_heartbeat: 0 };

// ═════════════════════════════════════════════════════════════════════════
// LOGGING UTILITY
// ═════════════════════════════════════════════════════════════════════════
function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const emoji = {
        info: '✅', warn: '⚠️', error: '❌', signal: '📨', queue: '📦', poll: '🔍',
        ws: '🌐', bot: '🤖', trade: '💰', storage: '💾', heartbeat: '💓',
        floating: '📊', volume: '🔧', quality: '⭐', control: '🎛️'
    }[type] || '•';
    console.log(`[${time}] ${emoji} ${msg}`);
}

// ═════════════════════════════════════════════════════════════════════════
// EXPRESS HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════
const app = express();

app.use((req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
        req.rawBody = data;
        if (data && data.trim()) {
            try {
                let cleaned = data.trim();
                const lastBrace = cleaned.lastIndexOf('}');
                if (lastBrace !== -1 && lastBrace < cleaned.length - 1) {
                    cleaned = cleaned.substring(0, lastBrace + 1);
                }
                req.body = JSON.parse(cleaned);
            } catch (e) {
                console.log(`[PARSE ERROR] Raw data received: "${data.substring(0, 200)}"`);
                req.body = {};
            }
        } else {
            req.body = {};
        }
        next();
    });
});

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    next();
});

// ✅ MT5 POLLS FOR SIGNALS
app.get('/api/signals', (req, res) => {
    // Gatekeeper: Reject signals if paused or emergency stopped
    if (botState.emergencyStop || botState.tradingPaused) {
        res.json({ status: 'no_signal', reason: 'bot_paused_or_stopped', timestamp: Date.now() });
        return;
    }

    const signal = signalQueue.pop();
    if (signal) {
        log(`${signal.action.toUpperCase()} ${signal.symbol} | Vol:${signal.volume} | Q:${signal.qualityScore}% | AI:${signal.aiScore}%`, 'signal');
        res.json({
            status: 'signal', action: signal.action, symbol: signal.symbol,
            price: signal.price || 0, sl: signal.sl || 0, tp: signal.tp || 0,
            volume: signal.volume, lotSize: signal.lotSize || signal.volume,
            qualityScore: signal.qualityScore, aiScore: signal.aiScore,
            timestamp: signal.timestamp
        });
    } else {
        res.json({ status: 'no_signal', timestamp: Date.now() });
    }
});

// ✅ MT5 SENDS TRADE RESULTS BACK
app.post('/api/trade-result', (req, res) => {
    const trade = req.body;
    if (req.rawBody) console.log(`[RAW] Trade result raw: ${req.rawBody.substring(0, 200)}`);
    if (trade && (trade.ticket || trade.ticket === 0)) {
        log(`${trade.symbol} ${trade.action} | PnL: $${trade.pnl} | Outcome: ${trade.outcome}`, 'trade');
        tradeHistory.addTrade(trade);
        res.json({ status: 'ok', message: 'Trade recorded' });
    } else {
        log(`Invalid trade result received: ${JSON.stringify(trade)}`, 'warn');
        res.json({ status: 'error', message: 'Invalid trade data', received: trade });
    }
});

// ✅ HEARTBEAT FROM MT5
app.get('/api/heartbeat', (req, res) => {
    const now = Date.now();
    latestFloatingPnL.last_heartbeat = now;
    log(`Heartbeat received`, 'heartbeat');
    res.json({ status: 'alive', timestamp: now, trades_recorded: tradeHistory.getAllTrades().length, queue_size: signalQueue.size() });
});

// ✅ FLOATING PnL FROM MT5
app.post('/api/floating-pnl', (req, res) => {
    const { equity, balance, floating_pnl, timestamp } = req.body;
    if (equity !== undefined && balance !== undefined) {
        latestFloatingPnL = { equity: equity || 0, balance: balance || 0, floating_pnl: floating_pnl || 0, timestamp: timestamp || Date.now(), last_heartbeat: latestFloatingPnL.last_heartbeat };
        log(`Equity: $${equity} | Balance: $${balance} | Floating: $${floating_pnl || 0}`, 'floating');
        res.json({ status: 'ok' });
    } else {
        log(`Invalid floating PnL data: ${JSON.stringify(req.body)}`, 'warn');
        res.json({ status: 'error', message: 'Invalid data' });
    }
});

app.get('/api/floating-pnl', (req, res) => res.json(latestFloatingPnL));
app.get('/api/trade-results', (req, res) => res.json(tradeHistory.getRecentTrades(parseInt(req.query.limit) || 100)));
app.get('/api/trade-stats', (req, res) => res.json(tradeHistory.getStats()));

app.get('/api/ea-status', (req, res) => {
    const now = Date.now();
    const isConnected = (now - latestFloatingPnL.last_heartbeat) < 60000;
    res.json({
        connected: isConnected, last_heartbeat: latestFloatingPnL.last_heartbeat,
        seconds_ago: isConnected ? Math.floor((now - latestFloatingPnL.last_heartbeat) / 1000) : null,
        floating_pnl: latestFloatingPnL.floating_pnl, equity: latestFloatingPnL.equity, balance: latestFloatingPnL.balance,
        queue_size: signalQueue.size(), trades_recorded: tradeHistory.getAllTrades().length
    });
});

app.get('/api/health', (req, res) => {
    const now = Date.now();
    res.json({
        status: 'ok', version: '3.0', signals_queued: signalQueue.size(), signals_processed: signalQueue.processedCount,
        trades_recorded: tradeHistory.getAllTrades().length, ea_connected: (now - latestFloatingPnL.last_heartbeat) < 60000,
        render_connected: renderWS && renderWS.readyState === WebSocket.OPEN, bot_state: botState, timestamp: now
    });
});

app.post('/api/queue-signal', (req, res) => {
    const signal = req.body;
    if (!signal.action || !signal.symbol) { res.status(400).json({ error: 'Missing action or symbol' }); return; }
    if (botState.emergencyStop || botState.tradingPaused) {
        log(`Manual signal blocked — bot is ${botState.emergencyStop ? 'stopped' : 'paused'}`, 'warn');
        res.status(423).json({ status: 'blocked', message: `Bot is ${botState.emergencyStop ? 'stopped' : 'paused'}`, botState });
        return;
    }
    if (!signal.qualityScore) signal.qualityScore = signal.score || 50;
    if (!signal.aiScore) signal.aiScore = 50;
    signalQueue.push(signal);
    res.json({ status: 'ok', message: 'Signal queued', queue_size: signalQueue.size(), qualityScore: signal.qualityScore });
});

app.get('/api/debug/last-request', (req, res) => {
    res.json({ last_heartbeat: latestFloatingPnL.last_heartbeat, queue_size: signalQueue.size(), trades_count: tradeHistory.getAllTrades().length });
});

// Read-only state check endpoint for local dashboards
app.get('/api/control/state', (req, res) => res.json(botState));

const server = http.createServer(app);

// ═════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ═════════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ port: WS_PORT });
const wsClients = new Set();

wss.on('listening', () => log(`Local WebSocket server on ws://localhost:${WS_PORT}`, 'ws'));

wss.on('connection', (ws, req) => {
    log(`WebSocket client connected`, 'ws');
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'handshake', status: 'connected', message: 'Connected to NEXUS Signal Bridge v3.0', version: '3.0', timestamp: Date.now() }));

    ws.on('message', (data) => {
        try {
            const msg = data.toString();
            let parsed;
            try { parsed = JSON.parse(msg); } catch (e) { parsed = { raw: msg }; }

            if (parsed.action && parsed.symbol) {
                if (botState.emergencyStop || botState.tradingPaused) {
                    log(`WS signal blocked — bot is ${botState.emergencyStop ? 'stopped' : 'paused'}`, 'warn');
                    ws.send(JSON.stringify({ type: 'ack', status: 'blocked', botState, timestamp: Date.now() }));
                    return;
                }
                if (!parsed.qualityScore) parsed.qualityScore = parsed.score || 50;
                if (!parsed.aiScore) parsed.aiScore = 50;
                parsed.source = 'websocket';
                signalQueue.push(parsed);
                ws.send(JSON.stringify({ type: 'ack', status: 'queued', queue_size: signalQueue.size(), qualityScore: parsed.qualityScore, timestamp: Date.now() }));
            }
        } catch (e) { log(`WebSocket error: ${e.message}`, 'error'); }
    });

    ws.on('close', () => { wsClients.delete(ws); log(`WebSocket client disconnected`, 'warn'); });
});

function broadcastCommand(message) {
    const payload = JSON.stringify(message);
    wsClients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
}

// ═════════════════════════════════════════════════════════════════════════
// CONNECT TO RENDER
// ═════════════════════════════════════════════════════════════════════════
let renderWS = null;
let reconnectAttempts = 0;

function connectToRender() {
    log(`Connecting to Render: ${RENDER_URL}`, 'bot');
    try { renderWS = new WebSocket(RENDER_URL); }
    catch (e) { log(`Failed to create WebSocket: ${e.message}`, 'error'); setTimeout(connectToRender, 5000); return; }

    renderWS.on('open', () => {
        log(`✅ Connected to Render!`, 'bot');
        reconnectAttempts = 0;
        renderWS.send(JSON.stringify({ type: 'bridge', client: 'nexus-signal-bridge', version: '3.0', timestamp: Date.now() }));
    });

    renderWS.on('message', (data) => {
        try {
            const msg = data.toString();
            let signal;
            try { signal = JSON.parse(msg); } catch (e) { return; }
            if (signal.type === 'signal' || signal.action) {
                if (botState.emergencyStop || botState.tradingPaused) {
                    log(`Render signal blocked — bot is ${botState.emergencyStop ? 'stopped' : 'paused'}`, 'warn');
                    return;
                }
                if (!signal.qualityScore && signal.score) signal.qualityScore = signal.score;
                if (!signal.qualityScore) signal.qualityScore = 50;
                signal.source = 'render';
                signalQueue.push(signal);
                log(`Signal from bot queued | Q:${signal.qualityScore}% (queue: ${signalQueue.size()})`, 'queue');
            }
        } catch (e) { /* ignore parse errors */ }
    });

    renderWS.on('close', () => {
        log(`Render connection closed`, 'warn');
        renderWS = null;
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 60000);
        setTimeout(connectToRender, delay);
    });

    renderWS.on('error', (err) => log(`Render error: ${err.message}`, 'error'));
}

// ═════════════════════════════════════════════════════════════════════════
// STARTUP
// ═════════════════════════════════════════════════════════════════════════
console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║ NEXUS Signal Queue Bridge v3.0 - FIRESTORE DIRECT SYNC       ║');
console.log('║ Real-time control via Firestore | No Tunnels Required        ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

server.listen(HTTP_PORT, () => {
    log(`HTTP server on http://localhost:${HTTP_PORT}`, 'info');
    console.log(`\n 📡 ENDPOINTS:`);
    console.log(`   GET  /api/signals          - MT5 polls for signals`);
    console.log(`   POST /api/trade-result     - MT5 sends trade results`);
    console.log(`   GET  /api/heartbeat        - MT5 heartbeat`);
    console.log(`   POST /api/floating-pnl     - MT5 floating PnL`);
    console.log(`   GET  /api/trade-results    - Frontend trade history`);
    console.log(`   GET  /api/trade-stats      - Frontend trade stats`);
    console.log(`   GET  /api/ea-status        - EA connection status`);
    console.log(`   GET  /api/health           - Bridge health check`);
    console.log(`   GET  /api/control/state    - Current bot state\n`);
});

setTimeout(() => { connectToRender(); }, 1000);
log(`System ready - Waiting for signals...\n`, 'info');

setInterval(() => {
    const stats = tradeHistory.getStats();
    const now = Date.now();
    const eaConnected = (now - latestFloatingPnL.last_heartbeat) < 60000;
    const renderConnected = renderWS && renderWS.readyState === WebSocket.OPEN;
    log(`Queue:${signalQueue.size()} | Trades:${stats.total_trades} | PnL:$${stats.net_pnl.toFixed(2)} | WR:${stats.win_rate}% | EA:${eaConnected ? 'ON' : 'OFF'} | Render:${renderConnected ? 'ON' : 'OFF'} | Paused:${botState.tradingPaused} | Stopped:${botState.emergencyStop}`, 'info');
}, 15000);

process.on('SIGINT', () => {
    console.log('\n');
    log('Shutting down...', 'warn');
    if (renderWS) renderWS.close();
    wss.close();
    server.close();
    log('Bridge stopped', 'info');
    process.exit(0);
});

module.exports = { signalQueue, tradeHistory, latestFloatingPnL, botState };