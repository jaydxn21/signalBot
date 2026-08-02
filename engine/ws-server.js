import WebSocket, { WebSocketServer } from 'ws';

function parseJson(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export class EngineWSServer {
    constructor({ port, secret, store, botManager }) {
        this.port = port;
        this.secret = secret;
        this.store = store;
        this.botManager = botManager;
        this.server = null;
    }

    start() {
        this.server = new WebSocketServer({ port: this.port });
        this.server.on('connection', (socket, req) => this._onConnection(socket, req));

        this.store.on('bots_list', (bots) => this.broadcast({ type: 'bots_list', bots }));
        this.store.on('log_line', (line) =>
            this.broadcast({ type: 'log_line', text: line.text, logType: line.type, time: line.time }),
        );
        this.store.on('trade_event', (event) =>
            this.broadcast({ ...event, type: 'trade_event', eventType: event.type }),
        );
        this.store.on('candle_update', (payload) => this.broadcast({ type: 'candle_update', ...payload }));
    }

    _onConnection(socket, req) {
        if (!this._isAuthorized(req)) {
            socket.close(1008, 'Unauthorized');
            return;
        }
        this._send(socket, { type: 'bots_list', bots: this.botManager.listBots() });
        for (const line of this.store.logs.slice(0, 50).reverse()) {
            this._send(socket, { type: 'log_line', text: line.text, logType: line.type, time: line.time });
        }

        socket.on('message', async (raw) => {
            const message = parseJson(String(raw));
            if (!message?.type) {
                this._send(socket, { type: 'error', error: 'Invalid message' });
                return;
            }
            try {
                await this._handleMessage(socket, message);
            } catch (error) {
                this._send(socket, { type: 'error', error: error.message });
            }
        });
    }

    async _handleMessage(socket, message) {
        if (message.type === 'create_bot') {
            this.botManager.createBot(message.config || {});
            return;
        }
        if (message.type === 'start_bot') {
            this.botManager.startBot(message.id);
            return;
        }
        if (message.type === 'stop_bot') {
            this.botManager.stopBot(message.id);
            return;
        }
        if (message.type === 'remove_bot') {
            this.botManager.removeBot(message.id);
            return;
        }
        if (message.type === 'get_candles') {
            const candles = this.botManager.getBotCandles(message.id);
            this._send(socket, { type: 'candles_history', id: String(message.id), candles });
            return;
        }
        this._send(socket, { type: 'error', error: `Unknown message type: ${message.type}` });
    }

    _isAuthorized(req) {
        if (!this.secret) return true;
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const secret = url.searchParams.get('secret');
        return secret === this.secret;
    }

    broadcast(payload) {
        if (!this.server) return;
        const serialized = JSON.stringify(payload);
        this.server.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(serialized);
            }
        });
    }

    _send(socket, payload) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(payload));
    }
}
