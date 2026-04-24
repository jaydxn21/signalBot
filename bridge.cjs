// bridge.cjs - CommonJS version (rename file to .cjs)
const WebSocket = require('ws');

// Configuration
const RENDER_WS_URL = 'wss://nexus-api-khvt.onrender.com/mt5';
const LOCAL_PORT = 3000;

let renderWS = null;
let localServer = null;

// Create local WebSocket server for MT5
function createLocalServer() {
    localServer = new WebSocket.Server({ port: LOCAL_PORT });
    
    localServer.on('listening', () => {
        console.log(`✅ Local WS server: ws://localhost:${LOCAL_PORT}`);
        console.log(`   MT5 EA should connect to: ws://127.0.0.1:${LOCAL_PORT}`);
    });
    
    localServer.on('connection', (clientWS, req) => {
        const clientIP = req.socket.remoteAddress;
        console.log(`🔗 MT5 Client connected from ${clientIP}`);
        
        clientWS.on('message', (data) => {
            const msg = data.toString();
            console.log(`📤 Message from MT5: ${msg.substring(0, 100)}`);
            if (renderWS && renderWS.readyState === WebSocket.OPEN) {
                renderWS.send(msg);
            }
        });
        
        clientWS.on('close', () => {
            console.log(`❌ MT5 Client disconnected`);
        });
        
        clientWS.on('error', (err) => {
            console.error(`⚠️ MT5 Client error:`, err.message);
        });
    });
    
    localServer.on('error', (err) => {
        console.error(`❌ Local server error:`, err.message);
        if (err.code === 'EADDRINUSE') {
            console.log(`   Port ${LOCAL_PORT} is already in use.`);
        }
    });
}

// Connect to Render
function connectToRender() {
    if (renderWS && renderWS.readyState === WebSocket.OPEN) {
        return;
    }
    
    console.log(`🌐 Connecting to Render: ${RENDER_WS_URL}`);
    
    try {
        renderWS = new WebSocket(RENDER_WS_URL);
        
        renderWS.on('open', () => {
            console.log(`✅ Connected to Render WebSocket`);
        });
        
        renderWS.on('message', (data) => {
            const message = data.toString();
            console.log(`📥 Signal from Render: ${message.substring(0, 150)}`);
            
            let forwarded = false;
            if (localServer) {
                localServer.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                        forwarded = true;
                    }
                });
                if (forwarded) {
                    console.log(`   ✅ Forwarded to MT5`);
                } else {
                    console.log(`   ⚠️ No MT5 clients connected`);
                }
            }
        });
        
        renderWS.on('close', () => {
            console.log(`❌ Render connection closed. Reconnecting in 5s...`);
            renderWS = null;
            setTimeout(connectToRender, 5000);
        });
        
        renderWS.on('error', (err) => {
            console.error(`⚠️ Render WebSocket error:`, err.message);
            renderWS = null;
            setTimeout(connectToRender, 5000);
        });
        
    } catch (err) {
        console.error(`❌ Failed to connect:`, err.message);
        setTimeout(connectToRender, 5000);
    }
}

// Start
console.log('\n🚀 NEXUS WebSocket Bridge');
console.log('='.repeat(50));
createLocalServer();
connectToRender();
console.log('\nPress Ctrl+C to stop\n');