import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class DerivClient extends EventEmitter {
    constructor({ appId, token }) {
        super();
        this.appId = appId;
        this.token = token;
        this.socket = null;
        this.isAuthorized = false;
        this._manualClose = false;
        this._reconnectDelayMs = 3000;
        this._maxReconnectDelayMs = 30000;
        this._reconnectTimer = null;
        this._pingTimer = null;
        this._subscriptions = new Map();
    }

    connect() {
        this._manualClose = false;
        const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.appId)}`;
        this.socket = new WebSocket(url);

        this.socket.on('open', () => {
            this._clearReconnectTimer();
            this._reconnectDelayMs = 3000;
            this._send({ authorize: this.token });
            this._startKeepAlive();
            this.emit('log', 'Connected to Deriv websocket', 'info');
        });

        this.socket.on('message', (raw) => {
            let data;
            try {
                data = JSON.parse(String(raw));
            } catch (error) {
                this.emit('log', `Failed to parse Deriv payload: ${error.message}`, 'warn');
                return;
            }

            if (data.error) {
                this.emit('error_message', data.error, data.echo_req || {});
                return;
            }

            if (data.msg_type === 'authorize') {
                this.isAuthorized = true;
                this.emit('authorized', data.authorize);
                return;
            }

            if (data.msg_type === 'candles') {
                if (data.subscription?.id && data.echo_req?.ticks_history && data.echo_req?.granularity) {
                    const key = `${data.echo_req.ticks_history}_${data.echo_req.granularity}`;
                    this._subscriptions.set(key, data.subscription.id);
                }
                this.emit('candles', data);
                return;
            }

            if (data.msg_type === 'ohlc') {
                this.emit('ohlc', data);
            }
        });

        this.socket.on('close', () => {
            this.isAuthorized = false;
            this._stopKeepAlive();
            this.emit('log', 'Disconnected from Deriv websocket', 'warn');
            if (!this._manualClose) {
                this._scheduleReconnect();
            }
        });

        this.socket.on('error', (error) => {
            this.emit('log', `Deriv socket error: ${error.message}`, 'warn');
        });
    }

    disconnect() {
        this._manualClose = true;
        this._clearReconnectTimer();
        this._stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

    subscribe(symbol, granularity) {
        const key = `${symbol}_${granularity}`;
        const priorSubId = this._subscriptions.get(key);
        if (priorSubId) {
            this._send({ forget: priorSubId });
        }
        this._send({
            ticks_history: symbol,
            subscribe: 1,
            granularity: Number(granularity),
            count: 500,
            style: 'candles',
            end: 'latest',
            adjust_start_time: 1,
        });
    }

    forgetSymbol(symbol, granularity) {
        const key = `${symbol}_${granularity}`;
        const subId = this._subscriptions.get(key);
        if (subId) {
            this._send({ forget: subId });
            this._subscriptions.delete(key);
        }
    }

    _send(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify(payload));
    }

    _startKeepAlive() {
        this._stopKeepAlive();
        this._pingTimer = setInterval(() => this._send({ ping: 1 }), 25000);
    }

    _stopKeepAlive() {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            this.emit('log', `Reconnecting to Deriv in ${this._reconnectDelayMs / 1000}s`, 'warn');
            this.connect();
            this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, this._maxReconnectDelayMs);
        }, this._reconnectDelayMs);
    }

    _clearReconnectTimer() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }
}
