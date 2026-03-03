import { UIManager } from './ui-manager.js';

export class DerivAPI {
    constructor(appId, onMessage) {
        this.appId      = appId;
        this.onMessage  = onMessage;
        this.socket     = null;
        this._pingInterval = null;
        this.symbolMap  = {};
    }

    connect(token) {
        this.socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`);

        this.socket.onopen = () => {
            this.socket.send(JSON.stringify({ authorize: token }));
            this.startKeepAlive();
            UIManager.log('WebSocket opened — authorizing...', 'info');
        };

        this.socket.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            this.onMessage(data);
        };

        this.socket.onclose = () => {
            clearInterval(this._pingInterval);
            UIManager.setConnectionStatus(false);
            // ✅ FIXED: use 'warn' not Tailwind class string
            UIManager.log('Connection closed — will not auto-reconnect.', 'warn');
        };

        this.socket.onerror = (err) => {
            console.error('WebSocket error:', err);
            // ✅ FIXED: use 'warn' not Tailwind class string
            UIManager.log('WebSocket error — check browser console.', 'warn');
        };
    }

    fetchActiveSymbols() {
        this.socket.send(JSON.stringify({ active_symbols: 'brief' }));
    }

    subscribe(symbol, granularity) {
        const request = {
            ticks_history:    symbol,
            subscribe:        1,
            granularity:      parseInt(granularity),
            count:            500,
            style:            'candles',
            end:              'latest',
            adjust_start_time: 1
        };
        this.socket.send(JSON.stringify(request));
    }

    startKeepAlive() {
        clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => {
            if (this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ ping: 1 }));
            }
        }, 30000);
    }

    disconnect() {
        clearInterval(this._pingInterval);
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}