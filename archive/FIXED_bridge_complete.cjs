// ═══════════════════════════════════════════════════════════════════════════
// FIXED bridge.cjs - Bidirectional MT5 <-> Render Bridge (COMPLETE FIX)
// ═══════════════════════════════════════════════════════════════════════════
//
// KEY IMPROVEMENTS:
// ✅ WebSocket server on localhost:3000 (MT5 connects here)
// ✅ Connects to Render for signals from bot
// ✅ HTTP polling endpoint for MT5 (fallback)
// ✅ Better logging and diagnostics
// ✅ Signal queuing if MT5 disconnects
// ✅ Proper error handling and reconnects
//
// ═══════════════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const RENDER_WS_URL = 'wss://nexus-api-khvt.onrender.com/mt5';
const LOCAL_WS_PORT = 3000;
const HTTP_PORT = 8080;

let renderWS = null;
let localWSServer = null;
let httpServer = null;

// Signal queues
let pendingSignals = [];
const MAX_QUEUE_SIZE = 100;

// ═════════════════════════════════════════════════════════════════════════
// SETUP & LOGGING
// ═════════════════════════════════════════════════════════════════════════

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
        'info': '✅',
        'warn': '⚠️',
        'error': '❌',
        'bridge': '🌉',
        'mt5': '💾',
        'render': '☁️',
        'signal': '📨'
    }[type] || '•';
    
    console.log(`[${timestamp}] ${prefix} ${message}`);
}

log('═══════════════════════════════════════════════════════════════');
log('  NEXUS Bidirectional WebSocket Bridge (FIXED)', 'bridge');
log('═══════════════════════════════════════════════════════════════');

// ═════════════════════════════════════════════════════════════════════════
// CREATE LOCAL WEBSOCKET SERVER (MT5 CONNECTS HERE)
// ═════════════════════════════════════════════════════════════════════════

function createLocalWebSocketServer() {
    localWSServer = new WebSocket.Server({ port: LOCAL_WS_PORT });
    
    localWSServer.on('listening', () => {
        log(`Local WebSocket server listening on ws://localhost:${LOCAL_WS_PORT}`, 'mt5');
        log('📌 MT5 EA should connect to: ws://localhost:3000', 'mt5');
    });

    localWSServer.on('connection', (clientWS, req) => {
        const clientIP = req.socket.remoteAddress;
        log(`MT5 EA connected from ${clientIP}`, 'mt5');

        // Send welcome message
        clientWS.send(JSON.stringify({
            type: 'handshake',
            status: 'connected',
            timestamp: Date.now(),
            message: 'Welcome to NEXUS bridge'
        }));

        // Flush pending signals to this client
        log(`Flushing ${pendingSignals.length} pending signals to MT5`, 'signal');
        pendingSignals.forEach(signal => {
            if (clientWS.readyState === WebSocket.OPEN) {
                clientWS.send(JSON.stringify(signal));
            }
        });
        pendingSignals = [];

        // Handle messages FROM MT5
        clientWS.on('message', (data) => {
            try {
                const message = data.toString();
                log(`Message from MT5 EA: ${message.substring(0, 100)}...`, 'mt5');
                
                // Forward to Render if needed
                if (renderWS && renderWS.readyState === WebSocket.OPEN) {
                    renderWS.send(message);
                }
            } catch (e) {
                log(`Error processing MT5 message: ${e.message}`, 'error');
            }
        });

        clientWS.on('close', () => {
            log('MT5 EA disconnected', 'warn');
        });

        clientWS.on('error', (err) => {
            log(`MT5 WebSocket error: ${err.message}`, 'error');
        });

        clientWS.on('ping', () => {
            clientWS.pong();
            log('Ping from MT5 received', 'mt5');
        });
    });

    log(`WebSocket server created on port ${LOCAL_WS_PORT}`, 'bridge');
}

// ═════════════════════════════════════════════════════════════════════════
// CREATE HTTP SERVER (FALLBACK FOR MT5)
// ═════════════════════════════════════════════════════════════════════════

function createHTTPServer() {
    const app = express();
    app.use(express.json());

    // Health check
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: Date.now(),
            mt5_connected: localWSServer?.clients?.size || 0,
            render_connected: renderWS?.readyState === WebSocket.OPEN
        });
    });

    // MT5 polls for signals
    app.get('/api/signals', (req, res) => {
        log(`MT5 polling for signals (${pendingSignals.length} pending)`, 'signal');
        
        if (pendingSignals.length > 0) {
            const signal = pendingSignals.shift();
            return res.json({
                status: 'signal',
                data: signal
            });
        }
        
        res.json({
            status: 'no_signal',
            message: 'No pending signals'
        });
    });

    // MT5 sends status updates
    app.post('/api/status', (req, res) => {
        const { status, message } = req.body;
        log(`MT5 Status: ${message}`, 'mt5');
        res.json({ received: true });
    });

    // Render/Bot test endpoint
    app.post('/api/test-signal', (req, res) => {
        const signal = {
            action: 'buy',
            symbol: 'Jump 75 Index',
            price: 16565.00,
            sl: 16555.00,
            tp: 16575.00,
            volume: 0.1,
            timestamp: Date.now()
        };
        
        log(`Test signal received: ${signal.action} ${signal.symbol}`, 'signal');
        ForwardToMT5(signal);
        
        res.json({
            status: 'ok',
            message: 'Test signal forwarded'
        });
    });

    httpServer = app.listen(HTTP_PORT, () => {
        log(`HTTP server listening on port ${HTTP_PORT}`, 'bridge');
        log(`MT5 can poll signals from: http://localhost:${HTTP_PORT}/api/signals`, 'mt5');
    });
}

// ═════════════════════════════════════════════════════════════════════════
// CONNECT TO RENDER (BOT SIGNALS SOURCE)
// ═════════════════════════════════════════════════════════════════════════

function connectToRender() {
    if (renderWS && renderWS.readyState === WebSocket.OPEN) {
        return;
    }

    log(`Connecting to Render: ${RENDER_WS_URL}`, 'render');

    try {
        renderWS = new WebSocket(RENDER_WS_URL);
    } catch (e) {
        log(`Failed to create WebSocket: ${e.message}`, 'error');
        setTimeout(connectToRender, 5000);
        return;
    }

    renderWS.on('open', () => {
        log('Connected to Render WebSocket', 'render');
        
        // Send handshake
        renderWS.send(JSON.stringify({
            type: 'client',
            client: 'mt5-bridge',
            timestamp: Date.now()
        }));
    });

    // SIGNALS COME IN HERE FROM THE BOT
    renderWS.on('message', (data) => {
        try {
            const message = data.toString();
            log(`Signal from Render: ${message.substring(0, 150)}...`, 'signal');

            // Parse if JSON
            let signal;
            try {
                signal = JSON.parse(message);
            } catch {
                signal = { raw: message };
            }

            // Forward to MT5
            ForwardToMT5(signal);
        } catch (e) {
            log(`Error processing Render signal: ${e.message}`, 'error');
        }
    });

    renderWS.on('close', () => {
        log('Render connection closed. Reconnecting in 5s...', 'warn');
        renderWS = null;
        setTimeout(connectToRender, 5000);
    });

    renderWS.on('error', (err) => {
        log(`Render WebSocket error: ${err.message}`, 'error');
        renderWS = null;
        setTimeout(connectToRender, 5000);
    });

    renderWS.on('ping', () => {
        renderWS.pong();
    });
}

// ═════════════════════════════════════════════════════════════════════════
// FORWARD SIGNAL TO MT5
// ═════════════════════════════════════════════════════════════════════════

function ForwardToMT5(signal) {
    const message = JSON.stringify(signal);

    // Try WebSocket first
    let forwarded = false;
    if (localWSServer && localWSServer.clients) {
        log(`Forwarding to ${localWSServer.clients.size} MT5 client(s)...`, 'signal');
        
        localWSServer.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                    forwarded = true;
                    log('✅ Signal sent via WebSocket to MT5', 'signal');
                } catch (e) {
                    log(`Failed to send: ${e.message}`, 'error');
                }
            }
        });
    }

    // If no clients, queue for HTTP polling
    if (!forwarded) {
        if (pendingSignals.length < MAX_QUEUE_SIZE) {
            pendingSignals.push(signal);
            log(`Signal queued for MT5 (${pendingSignals.length} pending)`, 'warn');
        } else {
            log('Signal queue full - discarding oldest signal', 'error');
            pendingSignals.shift();
            pendingSignals.push(signal);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
// STARTUP
// ═════════════════════════════════════════════════════════════════════════

log('\n📋 Configuration:', 'bridge');
log(`   Local WebSocket Port: ${LOCAL_WS_PORT}`, 'bridge');
log(`   HTTP Polling Port: ${HTTP_PORT}`, 'bridge');
log(`   Render URL: ${RENDER_WS_URL}`, 'bridge');

log('\n🚀 Starting bridge components...', 'bridge');
createLocalWebSocketServer();
createHTTPServer();
connectToRender();

log('\n✅ Bridge is ready!', 'bridge');
log('\n📌 Connection flow:', 'bridge');
log('   1. Trading Bot → Render WebSocket', 'bridge');
log('   2. Render → This Bridge (local)', 'bridge');
log('   3. This Bridge → MT5 EA (WebSocket)', 'bridge');

log('\n🔗 Connection methods for MT5:', 'bridge');
log(`   1. WebSocket: ws://localhost:${LOCAL_WS_PORT}`, 'mt5');
log(`   2. HTTP Polling: http://localhost:${HTTP_PORT}/api/signals`, 'mt5');

log('\n✨ Bridge is running. Press Ctrl+C to stop.\n', 'bridge');

// ═════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════════════════

process.on('SIGINT', () => {
    log('\nShutting down bridge...', 'warn');
    
    if (localWSServer) localWSServer.close();
    if (httpServer) httpServer.close();
    if (renderWS) renderWS.close();
    
    log('Bridge stopped.', 'info');
    process.exit(0);
});

// ═════════════════════════════════════════════════════════════════════════
// MONITORING & DEBUGGING
// ═════════════════════════════════════════════════════════════════════════

setInterval(() => {
    const mt5Clients = localWSServer?.clients?.size || 0;
    const renderConnected = renderWS?.readyState === WebSocket.OPEN;
    const queueSize = pendingSignals.length;
    
    log(`Status: MT5=${mt5Clients} | Render=${renderConnected ? 'ON' : 'OFF'} | Queue=${queueSize}`, 'bridge');
}, 10000);

// ═════════════════════════════════════════════════════════════════════════
// DEBUG API
// ═════════════════════════════════════════════════════════════════════════

const debugAPI = {
    getStatus: () => ({
        mt5_clients: localWSServer?.clients?.size || 0,
        render_connected: renderWS?.readyState === WebSocket.OPEN,
        pending_signals: pendingSignals.length,
        queue: pendingSignals
    }),
    
    sendTestSignal: () => {
        const signal = {
            action: 'buy',
            symbol: 'Jump 75 Index',
            price: 16565.00,
            sl: 16555.00,
            tp: 16575.00,
            volume: 0.1
        };
        log('Debug: Sending test signal to MT5', 'signal');
        ForwardToMT5(signal);
    }
};

log('\n💾 Available for debugging:', 'bridge');
log('   getStatus() - Show bridge status', 'bridge');
log('   sendTestSignal() - Send test signal to MT5', 'bridge');

module.exports = { debugAPI };
