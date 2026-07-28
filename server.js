import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import url    from 'url';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT     = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// ─── CORS CONFIGURATION - MUST BE BEFORE SERVER CALLBACK ───────────────────
const _allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(' ').map(s => s.trim()).filter(Boolean)
    : null;

function _corsHeaders(req) {
    const origin = req.headers['origin'] || '';
    const allowedOrigins = [
        'https://signal-bot-eight.vercel.app',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
    ];
    const allowed = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    
    return {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control',  // ← Added Cache-Control
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };
}

// ─── Auth ─────────────────────────────────────────────────────────────────
const AUTH_SECRET = process.env.NEXUS_SECRET || 'nexus_dev_secret_change_in_prod';
const DB_PATH     = path.join(__dirname, 'data', 'users.json');

function _ensureDB() {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2));
}

function _readDB() {
    _ensureDB();
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return { users: {} }; }
}

function _writeDB(db) {
    _ensureDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function _hashPassword(password) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

function _makeToken(userId) {
    const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString('base64');
    const sig     = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function _verifyToken(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64').toString());
        if (Date.now() > data.exp) return null;
        return data;
    } catch { return null; }
}

function _authMiddleware(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    return _verifyToken(token);
}

function _json(res, status, body, req) {
    const corsH = req ? _corsHeaders(req) : { 'Access-Control-Allow-Origin': '*' };
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsH });
    res.end(JSON.stringify(body));
}

let latestSignal  = null;
let signalHistory = [];
const mt5Clients  = [];
let mt5TradeResults = [];

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
    let pathname    = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    if (pathname.startsWith('/api/')) {
        console.log(`[API] ${req.method} ${pathname}`);
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, _corsHeaders(req));
        res.end();
        return;
    }

    // ── /api/test ──────────────────────────────────────────────────────────
    if (pathname === '/api/test' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify({ status: 'ok', message: 'Server is running latest code', timestamp: Date.now() }));
        return;
    }

    // ── /api/strategy-status (POST) ────────────────────────────────────────
    if (pathname === '/api/strategy-status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const status = JSON.parse(body);
                console.log(`[STRATEGY] ${status.status}:`, status);
                
                if (!global.strategyStatusHistory) global.strategyStatusHistory = [];
                global.latestStrategyStatus = status;
                global.strategyStatusHistory.unshift(status);
                if (global.strategyStatusHistory.length > 100) global.strategyStatusHistory.pop();
                
                res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch(err) {
                console.error('[Strategy Status] Error:', err);
                res.writeHead(400, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── /api/strategy-status (GET) ─────────────────────────────────────────
    if (pathname === '/api/strategy-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify(global.latestStrategyStatus || { 
            status: 'waiting', 
            message: 'No status updates yet. Strategy bot not running or not sending updates.',
            timestamp: Date.now()
        }));
        return;
    }

    // ── /api/strategy-status/history (GET) ─────────────────────────────────
    if (pathname === '/api/strategy-status/history' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify(global.strategyStatusHistory || []));
        return;
    }

    // ── /api/signal ──────────────────────────────────────────────────────────
    if (pathname === '/api/signal') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
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
                        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                        res.end(JSON.stringify({ status: 'duplicate', skipped: true }));
                        return;
                    }
                    latestSignal = { ...signalData, receivedAt: new Date().toISOString() };
                    signalHistory.unshift(latestSignal);
                    if (signalHistory.length > 50) signalHistory.pop();
                    console.log(`[${new Date().toLocaleTimeString()}] SIGNAL → ${signalData.action.toUpperCase()} ${signalData.symbol} @ ${signalData.price}`);
                    pushToMT5(latestSignal);
                    res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
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
        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify(signalHistory));
        return;
    }

    // ── /api/trade-result ───────────────────────────────────────────────────
    if (pathname === '/api/trade-result' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const result = JSON.parse(body);
                result.receivedAt = new Date().toISOString();
                mt5TradeResults.unshift(result);
                if (mt5TradeResults.length > 200) mt5TradeResults.pop();
                console.log(`[MT5] Trade closed → ${result.outcome} ${result.symbol} P&L: ${result.pnl}`);
                pushToMT5({ type: 'trade_result', ...result });
                res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch(err) {
                res.writeHead(400, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── /api/trade-results ──────────────────────────────────────────────────
    if (pathname === '/api/trade-results' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify(mt5TradeResults));
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
                res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch(err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── /api/save-strategy ───────────────────────────────────────────────────
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
                if (!fs.existsSync(strategiesDir)) {
                    fs.mkdirSync(strategiesDir, { recursive: true });
                }

                const filePath = path.join(strategiesDir, safeName);

                if (fs.existsSync(filePath)) {
                    const backupPath = filePath.replace('.js', `_backup_${Date.now()}.js`);
                    fs.copyFileSync(filePath, backupPath);
                    console.log(`[StrategyBuilder] Backed up existing file → ${path.basename(backupPath)}`);
                }

                fs.writeFileSync(filePath, code, 'utf8');
                console.log(`[StrategyBuilder] Saved: js/strategies/${safeName}`);

                res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ success: true, filename: safeName, path: filePath }));
            } catch(err) {
                console.error('[StrategyBuilder] Save error:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /api/strategies ──────────────────────────────────────────────────────
    if (pathname === '/api/strategies' && req.method === 'GET') {
        try {
            const strategiesDir = path.join(ROOT_DIR, 'js', 'strategies');
            const files = fs.existsSync(strategiesDir)
                ? fs.readdirSync(strategiesDir)
                    .filter(f => f.endsWith('.js') && !f.includes('_backup_'))
                    .map(f => ({
                        filename: f,
                        name:     f.replace('.js', ''),
                        modified: fs.statSync(path.join(strategiesDir, f)).mtime,
                    }))
                    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
                : [];
            res.writeHead(200, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
            res.end(JSON.stringify({ strategies: files }));
        } catch(err) {
            res.writeHead(500, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ── /api/strategy-manifest ──────────────────────────────────────────────────
if (pathname === '/api/strategy-manifest' && req.method === 'GET') {
    try {
        const strategiesDir = path.join(ROOT_DIR, 'js', 'strategies');
        const files = fs.existsSync(strategiesDir)
            ? fs.readdirSync(strategiesDir)
                .filter(f => f.endsWith('.js') && !f.includes('_backup_') && f !== 'index.js')
                .map(f => {
                    const name = f.replace('.js', '');
                    const filePath = path.join(strategiesDir, f);
                    const stats = fs.statSync(filePath);
                    
                    // Try to read the file to extract metadata
                    let meta = { 
                        name, 
                        label: name,
                        type: 'unknown',
                        exports: 'unknown',
                        modified: stats.mtime
                    };
                    
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        
                        // Look for @label comment
                        const labelMatch = content.match(/\/\/\s*@label\s+(.+)/);
                        if (labelMatch) meta.label = labelMatch[1].trim();
                        
                        // Look for @type comment
                        const typeMatch = content.match(/\/\/\s*@type\s+(.+)/);
                        if (typeMatch) meta.type = typeMatch[1].trim();
                        
                        // Check exports
                        if (content.includes('export default')) {
                            meta.exports = 'default';
                        } else if (content.includes('export {')) {
                            meta.exports = 'named';
                        } else if (content.includes('export const') || content.includes('export function')) {
                            meta.exports = 'named';
                        }
                        
                        // Check for class name
                        const classMatch = content.match(/export\s+(?:default\s+)?class\s+(\w+)/);
                        if (classMatch) meta.className = classMatch[1];
                        
                    } catch (err) {
                        // If we can't read the file, use defaults
                        console.warn(`Could not read metadata from ${f}:`, err.message);
                    }
                    
                    return meta;
                })
                .sort((a, b) => a.name.localeCompare(b.name))
            : [];
        
        const manifest = {
            strategies: files,
            count: files.length,
            timestamp: Date.now(),
            lastUpdated: new Date().toISOString()
        };
        
        console.log(`[StrategyManifest] Generated manifest with ${files.length} strategies`);
        
        res.writeHead(200, { 
            'Content-Type': 'application/json', 
            ..._corsHeaders(req),
            'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify(manifest));
        
    } catch(err) {
        console.error('[StrategyManifest] Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
        res.end(JSON.stringify({ error: err.message }));
    }
    return;
}

    // ── /api/ai ───────────────────────────────────────────────────────────────
    if (pathname === '/api/ai' && req.method === 'POST') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            _json(res, 503, { error: 'ANTHROPIC_API_KEY not set on server' }, req);
            return;
        }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const upstream = await fetch('https://api.anthropic.com/v1/messages', {
                    method:  'POST',
                    headers: {
                        'Content-Type':      'application/json',
                        'x-api-key':         apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify(payload),
                });
                const data = await upstream.json();
                res.writeHead(upstream.status, { 'Content-Type': 'application/json', ..._corsHeaders(req) });
                res.end(JSON.stringify(data));
            } catch(e) {
                _json(res, 500, { error: e.message }, req);
            }
        });
        return;
    }

    // ── /api/auth/register ────────────────────────────────────────────────────
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                if (!username || !password || username.length < 3 || password.length < 6)
                    return _json(res, 400, { error: 'Username ≥3 chars, password ≥6 chars required' }, req);

                const db = _readDB();
                const id = username.toLowerCase().trim();
                if (db.users[id]) return _json(res, 409, { error: 'Username already taken' }, req);

                db.users[id] = {
                    id, username,
                    passwordHash: _hashPassword(password),
                    createdAt: Date.now(),
                    settings: {},
                    strategies: {},
                };
                _writeDB(db);
                const token = _makeToken(id);
                _json(res, 201, { token, userId: id, username }, req);
            } catch(e) { _json(res, 400, { error: 'Invalid request' }, req); }
        });
        return;
    }

    // ── /api/auth/login ───────────────────────────────────────────────────────
    if (pathname === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { username, password } = JSON.parse(body);
                const db  = _readDB();
                const id  = (username || '').toLowerCase().trim();
                const user = db.users[id];
                if (!user || user.passwordHash !== _hashPassword(password))
                    return _json(res, 401, { error: 'Invalid username or password' }, req);

                const token = _makeToken(id);
                _json(res, 200, { token, userId: id, username: user.username }, req);
            } catch(e) { _json(res, 400, { error: 'Invalid request' }, req); }
        });
        return;
    }

    // ── /api/user/profile ─────────────────────────────────────────────────────
    if (pathname === '/api/user/profile' && req.method === 'GET') {
        const auth = _authMiddleware(req);
        if (!auth) return _json(res, 401, { error: 'Unauthorized' }, req);
        const db   = _readDB();
        const user = db.users[auth.userId];
        if (!user) return _json(res, 404, { error: 'User not found' }, req);
        _json(res, 200, { userId: user.id, username: user.username, createdAt: user.createdAt }, req);
        return;
    }

    // ── /api/user/settings ────────────────────────────────────────────────────
    if (pathname === '/api/user/settings') {
        const auth = _authMiddleware(req);
        if (!auth) return _json(res, 401, { error: 'Unauthorized' }, req);

        if (req.method === 'GET') {
            const db = _readDB();
            _json(res, 200, { settings: db.users[auth.userId]?.settings || {} }, req);
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { settings } = JSON.parse(body);
                    const db = _readDB();
                    if (db.users[auth.userId]) {
                        db.users[auth.userId].settings = settings;
                        _writeDB(db);
                        _json(res, 200, { ok: true }, req);
                    } else { _json(res, 404, { error: 'User not found' }, req); }
                } catch(e) { _json(res, 400, { error: 'Invalid request' }, req); }
            });
            return;
        }
    }

    // ── /api/user/strategies ──────────────────────────────────────────────────
    if (pathname === '/api/user/strategies') {
        const auth = _authMiddleware(req);
        if (!auth) return _json(res, 401, { error: 'Unauthorized' }, req);

        if (req.method === 'GET') {
            const db = _readDB();
            _json(res, 200, { strategies: db.users[auth.userId]?.strategies || {} }, req);
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { name, strategy } = JSON.parse(body);
                    if (!name) return _json(res, 400, { error: 'name required' }, req);
                    const db = _readDB();
                    if (db.users[auth.userId]) {
                        db.users[auth.userId].strategies[name] = { ...strategy, updatedAt: Date.now() };
                        _writeDB(db);
                        _json(res, 200, { ok: true }, req);
                    } else { _json(res, 404, { error: 'User not found' }, req); }
                } catch(e) { _json(res, 400, { error: 'Invalid request' }, req); }
            });
            return;
        }
        if (req.method === 'DELETE') {
            const name = new url.URL(req.url, 'http://localhost').searchParams.get('name');
            if (!name) return _json(res, 400, { error: 'name required' }, req);
            const db = _readDB();
            if (db.users[auth.userId]) {
                delete db.users[auth.userId].strategies[name];
                _writeDB(db);
                _json(res, 200, { ok: true }, req);
            } else { _json(res, 404, { error: 'User not found' }, req); }
            return;
        }
    }

    // ── /api/user/trades ──────────────────────────────────────────────────────
    if (pathname === '/api/user/trades') {
        const auth = _authMiddleware(req);
        if (!auth) return _json(res, 401, { error: 'Unauthorized' }, req);

        if (req.method === 'GET') {
            const db = _readDB();
            _json(res, 200, { trades: db.users[auth.userId]?.trades || [] }, req);
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { trades } = JSON.parse(body);
                    const db = _readDB();
                    if (db.users[auth.userId]) {
                        const existing = db.users[auth.userId].trades || [];
                        const merged   = [...trades, ...existing]
                            .filter((t, i, arr) => arr.findIndex(x => x.time === t.time && x.symbol === t.symbol) === i)
                            .slice(0, 500);
                        db.users[auth.userId].trades = merged;
                        _writeDB(db);
                        _json(res, 200, { ok: true, count: merged.length }, req);
                    } else { _json(res, 404, { error: 'User not found' }, req); }
                } catch(e) { _json(res, 400, { error: 'Invalid request' }, req); }
            });
            return;
        }
    }

    // ── API catch-all ─────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
        _json(res, 404, { error: `Unknown API route: ${req.method} ${pathname}` }, req);
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

// ─── WebSocket Upgrade ───────────────────────────────────────────────────
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
    console.log(`[WS] MT5 client connected on port ${PORT}. Total: ${mt5Clients.length}`);

    socket.on('data', () => {});
    socket.on('close', () => {
        const idx = mt5Clients.indexOf(socket);
        if (idx > -1) mt5Clients.splice(idx, 1);
        console.log(`[WS] MT5 client disconnected. Remaining: ${mt5Clients.length}`);
    });
    socket.on('error', err => console.error('[WS] Socket error:', err.message));
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Signal Bot running`);
    console.log(`   UI              → http://127.0.0.1:${PORT}`);
    console.log(`   Auth            → POST http://127.0.0.1:${PORT}/api/auth/login`);
    console.log(`   Auth            → POST http://127.0.0.1:${PORT}/api/auth/register`);
    console.log(`   AI Proxy        → POST http://127.0.0.1:${PORT}/api/ai  [key: ${process.env.ANTHROPIC_API_KEY ? '✓ set' : '✗ ANTHROPIC_API_KEY not set'}]`);
    console.log(`   MT5 poll        → http://127.0.0.1:${PORT}/api/signal`);
    console.log(`   MT5 WS push     → ws://127.0.0.1:${PORT}/mt5`);
    console.log(`   Save strategy   → POST http://127.0.0.1:${PORT}/api/save-strategy`);
    console.log(`   MT5 result      → POST http://127.0.0.1:${PORT}/api/trade-result`);
    console.log(`   Strategy status → POST/GET http://127.0.0.1:${PORT}/api/strategy-status`);
    console.log(`   List strategies → GET  http://127.0.0.1:${PORT}/api/strategies`);
    console.log(`   Training        → ${path.join(ROOT_DIR, 'training_data/')}`);
    console.log(`   Press Ctrl+C to stop\n`);
});