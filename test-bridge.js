// test-bridge.mjs - ES Module version for testing bridge
import WebSocket from 'ws';
import http from 'http';

console.log('🧪 Testing bridge connection...\n');

// Test WebSocket connection
const ws = new WebSocket('ws://localhost:3000/');

ws.on('open', () => {
    console.log('✅ Connected to bridge!');
    
    // Send test message
    ws.send(JSON.stringify({
        type: 'frontend',
        client: 'test-client',
        timestamp: Date.now()
    }));
    
    console.log('📤 Test message sent');
});

ws.on('message', (data) => {
    console.log('📨 Received:', data.toString());
});

ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
    console.log('\n💡 Make sure bridge.cjs is running:');
    console.log('   node bridge.cjs');
    console.log('   or');
    console.log('   node minimal-bridge.cjs');
});

ws.on('close', () => {
    console.log('🔌 Connection closed');
});

// Test HTTP endpoint
console.log('\n🏥 Testing HTTP health endpoint...');
const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/api/health',
    method: 'GET'
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('✅ HTTP Health Check:', json);
        } catch(e) {
            console.log('HTTP Response:', data);
        }
    });
});

req.on('error', (err) => {
    console.error('❌ HTTP test failed:', err.message);
    console.log('   Bridge HTTP server may not be running on port 8080');
});

req.end();