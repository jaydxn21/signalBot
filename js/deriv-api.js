import { UIManager } from './ui-manager.js';

export class DerivAPI {
    constructor(appId, onMessage) {
        this.appId          = appId;
        this.onMessage      = onMessage;
        this.socket         = null;
        this._pingInterval  = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;   // starts at 2s, doubles each attempt
        this._maxDelay       = 30000;  // caps at 30s
        this._token          = null;
        this._manualClose    = false;  // true when user deliberately disconnects
        this.symbolMap       = {};
    }

    connect(token) {
        this._token       = token;
        this._manualClose = false;
        this._clearReconnectTimer();
        this._openSocket();
    }

    _openSocket() {
        if (this.socket) {
            try { this.socket.close(); } catch(e) {}
        }

        this.socket = new WebSocket(
            `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`
        );

        this.socket.onopen = () => {
            this._reconnectDelay = 2000; // reset backoff on successful connect
            this.socket.send(JSON.stringify({ authorize: this._token }));
            this.startKeepAlive();
            UIManager.log('WebSocket opened — authorizing...', 'info');
        };

        this.socket.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                this.onMessage(data);
            } catch(e) {
                console.error('Failed to parse message:', e);
            }
        };

        this.socket.onclose = (event) => {
            clearInterval(this._pingInterval);
            UIManager.setConnectionStatus(false);

            if (this._manualClose) {
                UIManager.log('Disconnected.', 'warn');
                return;
            }

            UIManager.log(
                `Connection lost — reconnecting in ${this._reconnectDelay / 1000}s...`,
                'warn'
            );
            this._scheduleReconnect();
        };

        this.socket.onerror = () => {
            // onclose will fire after onerror, so just log here
            UIManager.log('WebSocket error — retrying...', 'warn');
        };
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            UIManager.log('Attempting reconnect...', 'info');
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
            this._openSocket();
        }, this._reconnectDelay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    fetchActiveSymbols() {
        this._send({ active_symbols: 'brief' });
    }

    subscribe(symbol, granularity) {
        this._send({
            ticks_history:     symbol,
            subscribe:         1,
            granularity:       parseInt(granularity),
            count:             500,
            style:             'candles',
            end:               'latest',
            adjust_start_time: 1
        });
    }

    // Safe send — queues if socket not ready
    _send(payload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        } else {
            console.warn('[DerivAPI] Socket not open, message dropped:', payload);
        }
    }

    startKeepAlive() {
        clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => {
            this._send({ ping: 1 });
        }, 25000);
    }

    disconnect() {
        this._manualClose = true;
        this._clearReconnectTimer();
        clearInterval(this._pingInterval);
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}