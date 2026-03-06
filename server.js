import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import url    from 'url';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT     = 3000;
const ROOT_DIR = __dirname;

let latestSignal  = null;
let signalHistory = [];
const mt5Clients  = [];

// ─── CSV helpers ───────────────────────────────────────────────────────────
const CSV_HEADERS = [
    'timestamp','unix','symbol','timeframe','type','entry','open','high','low',
    'atr','rsi','ema8','ema21','ema_diff','is_trending','is_volatile',
    'bull_score','bear_score','outcome','pnl','sl','tp','hold_candles'
].join(',') + '\n';

function getCSVPath(filename) {
    const dir = path.join(ROOT_DIR, 'training_data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    return path.join(dir, filename);
}

function ensureCSV(filename) {
    const filePath = getCSVPath(filename);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, CSV_HEADERS);
        console.log(`[DataLogger] Created ${filename}`);
    }
    return filePath;
}

// ─── WebSocket frame encoder ───────────────────────────────────────────────
function encodeWebSocketFrame(data) {
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, data]);
}

function pushToMT5(payload) {
    if (mt5Clients.length === 0) return;
    const frame = encodeWebSocketFrame(Buffer.from(JSON.stringify(payload)));
    mt5Clients.forEach(client => { try { client.write(frame); } catch(e) {} });
    console.log(`[WS] Pushed to ${mt5Clients.length} MT5 client(s)`);
}

// ─── Main HTTP Server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    let pathname    = parsedUrl.pathname.replace(/\/+$/, '') || '/'; // strip trailing slashes

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Debug — remove after confirming routes work
    if (pathname.startsWith('/api/')) {
        console.log(`[API] ${req.method} ${pathname}`);
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // ── /api/signal ──────────────────────────────────────────────────────────
    if (pathname === '/api/signal') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(latestSignal || { action: 'none', timestamp: 0 }));
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const signalData = JSON.parse(body);
                    if (latestSignal && latestSignal.timestamp === signalData.timestamp) {
                        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ status: 'duplicate', skipped: true }));
                        return;
                    }
                    latestSignal = { ...signalData, receivedAt: new Date().toISOString() };
                    signalHistory.unshift(latestSignal);
                    if (signalHistory.length > 50) signalHistory.pop();
                    console.log(`[${new Date().toLocaleTimeString()}] SIGNAL → ${signalData.action.toUpperCase()} ${signalData.symbol} @ ${signalData.price}`);
                    pushToMT5(latestSignal);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ status: 'ok', received: latestSignal }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }
    }

    // ── /api/signals/history ─────────────────────────────────────────────────
    if (pathname === '/api/signals/history' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(signalHistory));
        return;
    }

    // ── /api/log ─────────────────────────────────────────────────────────────
    if (pathname === '/api/log' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const record   = JSON.parse(body);
                const filename = record._filename || 'training_unknown.csv';
                const filePath = ensureCSV(filename);
                const headers  = [
                    'timestamp','unix','symbol','timeframe','type','entry','open','high','low',
                    'atr','rsi','ema8','ema21','ema_diff','is_trending','is_volatile',
                    'bull_score','bear_score','outcome','pnl','sl','tp','hold_candles'
                ];
                const row = headers.map(h => record[h] ?? '').join(',') + '\n';
                fs.appendFile(filePath, row, (err) => {
                    if (err) console.error('[DataLogger] Write error:', err);
                    else console.log(`[DataLogger] ${filename} → ${record.type} ${record.outcome || 'pending'} ${record.pnl ?? ''}`);
                });
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch(err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── /api/save-strategy ───────────────────────────────────────────────────
    // Called by Strategy Builder "Save to Server" button.
    // Writes the generated .js file directly to js/strategies/ on disk.
    // VS Code picks up the change immediately — no drag and drop needed.
    if (pathname === '/api/save-strategy' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { filename, code } = JSON.parse(body);
                if (!filename || !code) throw new Error('filename and code required');
                const safeName = path.basename(filename).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
                if (!safeName.endsWith('.js')) throw new Error('Only .js files allowed');
                const strategiesDir = path.join(ROOT_DIR, 'js', 'strategies');
                if (!fs.existsSync(strategiesDir)) fs.mkdirSync(strategiesDir, { recursive: true });
                const filePath = path.join(strategiesDir, safeName);
                if (fs.existsSync(filePath)) {
                    fs.copyFileSync(filePath, filePath.replace('.js', `_backup_${Date.now()}.js`));
                }
                fs.writeFileSync(filePath, code, 'utf8');
                console.log(`[StrategyBuilder] Saved: js/strategies/${safeName}`);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: true, filename: safeName }));
            } catch(err) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /api/strategies ──────────────────────────────────────────────────────
    // Lists all .js files in js/strategies/ — used to populate custom
    // strategy dropdowns in the Strategy Builder and Backtest pages.
    if (pathname === '/api/strategies' && req.method === 'GET') {
        try {
            const strategiesDir = path.join(ROOT_DIR, 'js', 'strategies');
            const files = fs.existsSync(strategiesDir)
                ? fs.readdirSync(strategiesDir)
                    .filter(f => f.endsWith('.js') && !f.includes('_backup_'))
                    .map(f => ({ filename: f, name: f.replace('.js', '') }))
                : [];
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ strategies: files }));
        } catch(err) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ── Static Files ─────────────────────────────────────────────────────────
    const filePath = path.join(ROOT_DIR, pathname);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? '404 Not Found' : 'Server Error');
            return;
        }
        const mimeTypes = {
            '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(content, 'utf-8');
    });
});

// ─── WebSocket Upgrade — same port 3000 ───────────────────────────────────
// When MT5 sends "Upgrade: websocket" header, HTTP server hands off the
// raw TCP socket to our WebSocket handler instead of the HTTP handler
server.on('upgrade', (req, socket, head) => {
    const keyHeader = req.headers['sec-websocket-key'];
    if (!keyHeader) {
        socket.destroy();
        return;
    }

    const acceptKey = crypto
        .createHash('sha1')
        .update(keyHeader.trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    mt5Clients.push(socket);
    console.log(`[WS] MT5 client connected on port 3000. Total: ${mt5Clients.length}`);

    socket.on('data', () => {}); // keep alive
    socket.on('close', () => {
        const idx = mt5Clients.indexOf(socket);
        if (idx > -1) mt5Clients.splice(idx, 1);
        console.log(`[WS] MT5 client disconnected. Remaining: ${mt5Clients.length}`);
    });
    socket.on('error', err => console.error('[WS] Socket error:', err.message));
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    // ── VERSION MARKER — if you see this, the patched server is running ──
    console.log(`\n🚀 Signal Bot running`);
    console.log(`   UI              → http://127.0.0.1:${PORT}`);
    console.log(`   MT5 poll        → http://127.0.0.1:${PORT}/api/signal`);
    console.log(`   MT5 WS push     → ws://127.0.0.1:${PORT}/mt5`);
    console.log(`   Save strategy   → POST http://127.0.0.1:${PORT}/api/save-strategy`);
    console.log(`   List strategies → GET  http://127.0.0.1:${PORT}/api/strategies`);
    console.log(`   Training        → ${path.join(ROOT_DIR, 'training_data/')}`);
    console.log(`   Press Ctrl+C to stop\n`);
});