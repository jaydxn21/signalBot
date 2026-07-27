// ═══════════════════════════════════════════════════════════════════════════
// THE REAL SOLUTION: Signal Queue Bridge
// ═══════════════════════════════════════════════════════════════════════════
//
// PROBLEM: MT5 is polling http://127.0.0.1:8080/api/signals but getting nothing
// REASON: Bot sends signal to Render, but bridge never forwards it to HTTP endpoint
// SOLUTION: Create a signal queue that MT5 can poll
//
// ═══════════════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const WS_PORT = 3000;
const HTTP_PORT = 8080;
const RENDER_URL = 'wss://nexus-api-khvt.onrender.com/mt5';

// ═════════════════════════════════════════════════════════════════════════
// SIGNAL QUEUE (This is the KEY FIX)
// ═════════════════════════════════════════════════════════════════════════

class SignalQueue {
    constructor(maxSize = 100) {
        this.queue = [];
        this.maxSize = maxSize;
    }
    
    push(signal) {
        if (this.queue.length >= this.maxSize) {
            this.queue.shift(); // Remove oldest
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
    
    peek() {
        return this.queue.length > 0 ? this.queue[0] : null;
    }
    
    size() {
        return this.queue.length;
    }
}

const signalQueue = new SignalQueue();

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
        'bot': '🤖'
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

// ✅ THIS IS WHAT MT5 POLLS
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
        log(`No signals available for MT5`, 'info');
        res.json({
            status: 'no_signal',
            timestamp: Date.now()
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        signals_queued: signalQueue.size(),
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
    });
    
    // ✅ SIGNALS COME IN HERE
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
            
            // ✅ QUEUE IT FOR MT5
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
console.log('║          NEXUS Signal Queue Bridge (REAL FIX)            ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Start HTTP server
server.listen(HTTP_PORT, () => {
    log(`HTTP server on http://localhost:${HTTP_PORT}`, 'info');
    log(`MT5 polls: http://127.0.0.1:${HTTP_PORT}/api/signals`, 'info');
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
log(`   5. MT5 receives signal ✅\n`, 'info');

// ═════════════════════════════════════════════════════════════════════════
// MONITORING
// ═════════════════════════════════════════════════════════════════════════

setInterval(() => {
    const status = {
        queue_size: signalQueue.size(),
        render_connected: renderWS && renderWS.readyState === WebSocket.OPEN ? 'ON' : 'OFF',
        http_port: HTTP_PORT,
        ws_port: WS_PORT
    };
    
    log(`Status: Queue=${status.queue_size} | Render=${status.render_connected} | HTTP Port=${status.http_port}`, 'info');
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

module.exports = { signalQueue };
