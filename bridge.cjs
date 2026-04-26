// bridge.cjs - CommonJS version (using require)
const WebSocket = require('ws');
const http = require('http');

const WS_PORT = 3000;
const HTTP_PORT = 8080;

console.log('🚀 Starting Minimal Bridge (CommonJS)...\n');

// WebSocket server
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('listening', () => {
    console.log(`✅ WebSocket server on ws://localhost:${WS_PORT}`);
    console.log(`   Frontend should connect to: ws://localhost:${WS_PORT}/\n`);
});

wss.on('connection', (ws, req) => {
    console.log(`📡 Client connected from ${req.socket.remoteAddress}`);
    
    ws.on('message', (data) => {
        const msg = data.toString();
        console.log(`📨 Received: ${msg.substring(0, 100)}`);
        
        try {
            const parsed = JSON.parse(msg);
            ws.send(JSON.stringify({ 
                type: 'echo', 
                received: parsed,
                timestamp: Date.now() 
            }));
        } catch(e) {
            ws.send(`Echo: ${msg}`);
        }
    });
    
    ws.on('close', () => {
        console.log('📡 Client disconnected');
    });
    
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to bridge',
        timestamp: Date.now()
    }));
});

wss.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
});

// HTTP server
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            timestamp: Date.now(),
            clients: wss.clients.size,
            websocket_port: WS_PORT,
            http_port: HTTP_PORT,
            message: 'Bridge is running'
        }));
    } 
    else if (req.url === '/api/test-signal' && req.method === 'GET') {
        const signal = {
            action: 'buy',
            symbol: 'Jump 75 Index',
            price: 16565.00,
            sl: 16555.00,
            tp: 16575.00,
            volume: 0.1,
            timestamp: Date.now()
        };
        
        console.log('📨 Sending test signal to all clients...');
        
        let sent = 0;
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(signal));
                sent++;
            }
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'sent', 
            signal,
            clients_notified: sent 
        }));
    }
    else if (req.url === '/api/signals' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'no_signal' }));
    }
    else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(HTTP_PORT, () => {
    console.log(`✅ HTTP server on http://localhost:${HTTP_PORT}`);
    console.log(`   Health: http://localhost:${HTTP_PORT}/api/health`);
    console.log(`   Test: http://localhost:${HTTP_PORT}/api/test-signal`);
});

console.log('\n📋 Bridge endpoints:');
console.log(`   WebSocket: ws://localhost:${WS_PORT}/`);
console.log(`   HTTP Poll: http://localhost:${HTTP_PORT}/api/signals`);
console.log(`   Health:    http://localhost:${HTTP_PORT}/api/health\n`);

console.log('✨ Bridge is ready! Press Ctrl+C to stop.\n');

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    wss.close();
    server.close();
    console.log('✅ Bridge stopped');
    process.exit(0);
});