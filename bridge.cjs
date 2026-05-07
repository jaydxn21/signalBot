// ═══════════════════════════════════════════════════════════════════════════
// NEXUS Signal Queue Bridge v2.1 - COMPLETE WITH HEARTBEAT & FLOATING PnL
// ═══════════════════════════════════════════════════════════════════════════
//
// Features:
//   - Queues signals for MT5 to poll
//   - Receives trade results from MT5
//   - Stores trade history for analytics
//   - Heartbeat endpoint for EA connection monitoring
//   - Floating PnL tracking from MT5
//   - Provides API endpoints for frontend
//
// ═══════════════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');

const WS_PORT = 3000;
const HTTP_PORT = 8080;
const RENDER_URL = 'wss://nexus-api-khvt.onrender.com/mt5';
const TRADE_HISTORY_FILE = path.join(__dirname, 'mt5_trades.json');

// ═════════════════════════════════════════════════════════════════════════
// PERSISTENT TRADE STORAGE
// ═════════════════════════════════════════════════════════════════════════

class TradeHistory {
    constructor() {
        this.trades = [];
        this.load();
    }
    
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
            if (this.trades.length > 1000) {
                this.trades = this.trades.slice(-1000);
            }
            fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(this.trades, null, 2));
        } catch (e) {
            console.error('[STORAGE] Failed to save trades:', e.message);
        }
    }
    
    addTrade(trade) {
        this.trades.unshift({
            ...trade,
            received_at: Date.now()
        });
        this.save();
        console.log(`[STORAGE] Added trade #${this.trades.length}: ${trade.symbol} ${trade.action} PnL: ${trade.pnl}`);
    }
    
    getAllTrades() {
        return this.trades;
    }
    
    getRecentTrades(limit = 100) {
        return this.trades.slice(0, limit);
    }
    
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
            profit_factor: losses.length ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))) : 0,
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
    constructor(maxSize = 100) {
        this.queue = [];
        this.maxSize = maxSize;
    }
    
    push(signal) {
        if (this.queue.length >= this.maxSize) {
            this.queue.shift();
        }
        this.queue.push({
            ...signal,
            queued_at: Date.now()
        });
        console.log(`[QUEUE] Signal added. Queue size: ${this.queue.length}`);
    }
    
    pop() {
        if (this.queue.length > 0) {
            const signal = this.queue.shift();
            console.log(`[QUEUE] Signal retrieved. Remaining: ${this.queue.length}`);
            return signal;
        }
        return null;
    }
    
    size() {
        return this.queue.length;
    }
}

const signalQueue = new SignalQueue();

// ═════════════════════════════════════════════════════════════════════════
// FLOATING PnL STORAGE
// ═════════════════════════════════════════════════════════════════════════

let latestFloatingPnL = {
    equity: 0,
    balance: 0,
    floating_pnl: 0,
    timestamp: 0,
    last_heartbeat: 0
};

// ═════════════════════════════════════════════════════════════════════════
// LOGGING UTILITY
// ═════════════════════════════════════════════════════════════════════════

function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const emoji = {
        'info': '✅',
        'warn': '⚠️',
        'error': '❌',
        'signal': '📨',
        'queue': '📦',
        'poll': '🔍',
        'ws': '🌐',
        'bot': '🤖',
        'trade': '💰',
        'storage': '💾',
        'heartbeat': '💓',
        'floating': '📊'
    }[type] || '•';
    
    console.log(`[${time}] ${emoji} ${msg}`);
}

// ═════════════════════════════════════════════════════════════════════════
// EXPRESS HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    next();
});

// ✅ MT5 POLLS FOR SIGNALS
app.get('/api/signals', (req, res) => {
    log(`MT5 polling for signals (${signalQueue.size()} in queue)`, 'poll');
    
    const signal = signalQueue.pop();
    
    if (signal) {
        log(`Sending signal to MT5: ${signal.action} ${signal.symbol}`, 'signal');
        res.json({
            status: 'signal',
            data: signal,
            timestamp: Date.now()
        });
    } else {
        res.json({
            status: 'no_signal',
            timestamp: Date.now()
        });
    }
});

// ✅ MT5 SENDS TRADE RESULTS BACK
app.post('/api/trade-result', (req, res) => {
    const trade = req.body;
    
    if (trade && trade.ticket) {
        log(`Trade result received: ${trade.symbol} ${trade.action} | PnL: ${trade.pnl}`, 'trade');
        tradeHistory.addTrade(trade);
        res.json({ status: 'ok', message: 'Trade recorded' });
    } else {
        log(`Invalid trade result received`, 'warn');
        res.json({ status: 'error', message: 'Invalid trade data' });
    }
});

// ✅ HEARTBEAT FROM MT5 (EA sends this every 30 seconds)
app.get('/api/heartbeat', (req, res) => {
    latestFloatingPnL.last_heartbeat = Date.now();
    log(`Heartbeat received from MT5 EA`, 'heartbeat');
    res.json({ 
        status: 'alive', 
        timestamp: Date.now(),
        trades_recorded: tradeHistory.getAllTrades().length
    });
});

// ✅ FLOATING PnL FROM MT5
app.post('/api/floating-pnl', (req, res) => {
    const { equity, balance, floating_pnl, timestamp } = req.body;
    latestFloatingPnL = {
        equity: equity || 0,
        balance: balance || 0,
        floating_pnl: floating_pnl || 0,
        timestamp: timestamp || Date.now(),
        last_heartbeat: latestFloatingPnL.last_heartbeat
    };
    log(`Floating PnL: Equity=$${equity}, Balance=$${balance}, Floating=$${floating_pnl}`, 'floating');
    res.json({ status: 'ok' });
});

// ✅ GET FLOATING PnL (for frontend)
app.get('/api/floating-pnl', (req, res) => {
    res.json(latestFloatingPnL);
});

// ✅ FRONTEND FETCHES TRADE HISTORY
app.get('/api/trade-results', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const trades = tradeHistory.getRecentTrades(limit);
    res.json(trades);
});

// ✅ FRONTEND FETCHES TRADE STATS
app.get('/api/trade-stats', (req, res) => {
    res.json(tradeHistory.getStats());
});

// ✅ EA CONNECTION STATUS (for frontend)
app.get('/api/ea-status', (req, res) => {
    const now = Date.now();
    const isConnected = (now - latestFloatingPnL.last_heartbeat) < 60000; // Connected if heartbeat within last 60 seconds
    
    res.json({
        connected: isConnected,
        last_heartbeat: latestFloatingPnL.last_heartbeat,
        seconds_ago: isConnected ? Math.floor((now - latestFloatingPnL.last_heartbeat) / 1000) : null,
        floating_pnl: latestFloatingPnL.floating_pnl,
        equity: latestFloatingPnL.equity,
        balance: latestFloatingPnL.balance
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        signals_queued: signalQueue.size(),
        trades_recorded: tradeHistory.getAllTrades().length,
        ea_connected: (Date.now() - latestFloatingPnL.last_heartbeat) < 60000,
        timestamp: Date.now(),
        render_connected: renderWS && renderWS.readyState === WebSocket.OPEN
    });
});

// Test endpoint (for debugging)
app.post('/api/test-signal', (req, res) => {
    const testSignal = {
        action: 'buy',
        symbol: 'Jump 75 Index',
        price: 16565.00,
        sl: 16555.00,
        tp: 16575.00,
        volume: 0.1,
        timestamp: Date.now()
    };
    
    log(`Test signal received, queuing for MT5`, 'signal');
    signalQueue.push(testSignal);
    
    res.json({
        status: 'ok',
        message: 'Test signal queued',
        queue_size: signalQueue.size()
    });
});

// Test trade result (for simulating MT5 responses)
app.post('/api/test-trade', (req, res) => {
    const testTrade = {
        ticket: Date.now(),
        symbol: 'Jump 75 Index',
        action: 'buy',
        entry: 13182.71,
        sl: 13182.71 - 80,
        tp: 13182.71 + 120,
        pnl: 2.50,
        close_time: Math.floor(Date.now() / 1000),
        outcome: 'TP'
    };
    
    tradeHistory.addTrade(testTrade);
    res.json({ status: 'ok', message: 'Test trade recorded' });
});

// Clear all trades (for testing)
app.delete('/api/trades', (req, res) => {
    tradeHistory.trades = [];
    tradeHistory.save();
    log('All trades cleared', 'warn');
    res.json({ status: 'ok', message: 'All trades cleared' });
});

const server = http.createServer(app);

// ═════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER (For incoming signals from Render)
// ═════════════════════════════════════════════════════════════════════════

const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('listening', () => {
    log(`Local WebSocket server on ws://localhost:${WS_PORT}`, 'ws');
});

wss.on('connection', (ws, req) => {
    log(`WebSocket client connected from ${req.socket.remoteAddress}`, 'ws');
    
    ws.send(JSON.stringify({
        type: 'handshake',
        status: 'connected',
        message: 'Connected to signal bridge',
        timestamp: Date.now()
    }));
    
    ws.on('message', (data) => {
        try {
            const msg = data.toString();
            const parsed = JSON.parse(msg);
            log(`WebSocket message received: ${msg.substring(0, 80)}...`, 'ws');
            
            // If it's a signal, queue it for MT5
            if (parsed.action && parsed.symbol) {
                signalQueue.push(parsed);
            }
        } catch (e) {
            log(`WebSocket parse error: ${e.message}`, 'error');
        }
    });
    
    ws.on('close', () => {
        log(`WebSocket client disconnected`, 'warn');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// CONNECT TO RENDER (BOT SIGNALS SOURCE)
// ═════════════════════════════════════════════════════════════════════════

let renderWS = null;
let reconnectAttempts = 0;

function connectToRender() {
    log(`Connecting to Render: ${RENDER_URL}`, 'bot');
    
    try {
        renderWS = new WebSocket(RENDER_URL);
    } catch (e) {
        log(`Failed to create WebSocket: ${e.message}`, 'error');
        setTimeout(connectToRender, 5000);
        return;
    }
    
    renderWS.on('open', () => {
        log(`✅ Connected to Render!`, 'bot');
        reconnectAttempts = 0;
        
        // Send identification
        renderWS.send(JSON.stringify({
            type: 'bridge',
            client: 'signal-bridge-v2',
            version: '2.1',
            timestamp: Date.now()
        }));
    });
    
    renderWS.on('message', (data) => {
        try {
            const msg = data.toString();
            log(`Signal from bot (via Render): ${msg.substring(0, 100)}...`, 'signal');
            
            let signal;
            try {
                signal = JSON.parse(msg);
            } catch {
                signal = { raw: msg };
            }
            
            signalQueue.push(signal);
            log(`Signal queued for MT5 polling (queue size: ${signalQueue.size()})`, 'queue');
            
        } catch (e) {
            log(`Error processing signal: ${e.message}`, 'error');
        }
    });
    
    renderWS.on('close', () => {
        log(`Render connection closed`, 'warn');
        renderWS = null;
        
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 60000);
        log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`, 'warn');
        
        setTimeout(connectToRender, delay);
    });
    
    renderWS.on('error', (err) => {
        log(`Render error: ${err.message}`, 'error');
    });
}

// ═════════════════════════════════════════════════════════════════════════
// STARTUP
// ═════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║     NEXUS Signal Queue Bridge v2.1 - COMPLETE            ║');
console.log('║     WITH HEARTBEAT & FLOATING PnL                        ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Start HTTP server
server.listen(HTTP_PORT, () => {
    log(`HTTP server on http://localhost:${HTTP_PORT}`, 'info');
    log(`MT5 polls: http://127.0.0.1:${HTTP_PORT}/api/signals`, 'info');
    log(`MT5 sends results: POST http://127.0.0.1:${HTTP_PORT}/api/trade-result`, 'info');
    log(`MT5 heartbeat: GET http://127.0.0.1:${HTTP_PORT}/api/heartbeat`, 'info');
    log(`MT5 floating PnL: POST http://127.0.0.1:${HTTP_PORT}/api/floating-pnl`, 'info');
    log(`Health:    http://127.0.0.1:${HTTP_PORT}/api/health`, 'info');
});

// Connect to Render
setTimeout(() => {
    connectToRender();
}, 1000);

log(`\n📋 System ready:\n`, 'info');
log(`   1. Bot sends signal → Render WebSocket`, 'info');
log(`   2. Render → This bridge (localhost:${WS_PORT})`, 'info');
log(`   3. Signal queued in memory`, 'info');
log(`   4. MT5 polls http://127.0.0.1:${HTTP_PORT}/api/signals`, 'info');
log(`   5. MT5 receives signal ✅`, 'info');
log(`   6. MT5 sends heartbeat every 30s → /api/heartbeat`, 'info');
log(`   7. MT5 sends floating PnL every 30s → /api/floating-pnl`, 'info');
log(`   8. When trade closes, MT5 POSTS result → /api/trade-result`, 'info');
log(`   9. Frontend displays real MT5 P&L in Analytics`, 'info');

// ═════════════════════════════════════════════════════════════════════════
// MONITORING
// ═════════════════════════════════════════════════════════════════════════

setInterval(() => {
    const stats = tradeHistory.getStats();
    const status = {
        queue_size: signalQueue.size(),
        render_connected: renderWS && renderWS.readyState === WebSocket.OPEN ? 'ON' : 'OFF',
        ea_connected: (Date.now() - latestFloatingPnL.last_heartbeat) < 60000,
        total_trades: stats.total_trades,
        net_pnl: stats.net_pnl,
        win_rate: stats.win_rate,
        floating_pnl: latestFloatingPnL.floating_pnl
    };
    
    log(`Status: Queue=${status.queue_size} | Trades=${status.total_trades} | PnL=$${status.net_pnl.toFixed(2)} | WR=${status.win_rate}% | EA=${status.ea_connected ? 'ON' : 'OFF'} | Render=${status.render_connected}`, 'info');
}, 15000);

// ═════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════════════════

process.on('SIGINT', () => {
    console.log('\n');
    log('Shutting down...', 'warn');
    
    if (renderWS) renderWS.close();
    wss.close();
    server.close();
    
    log('Bridge stopped', 'info');
    process.exit(0);
});

module.exports = { signalQueue, tradeHistory, latestFloatingPnL };