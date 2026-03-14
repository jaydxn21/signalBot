import { UIManager } from './ui-manager.js';

export class DerivAPI {
    constructor(appId, onMessage) {
        this.appId          = appId;
        this.onMessage      = onMessage;
        this.socket         = null;
        this._pingInterval  = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;
        this._maxDelay       = 30000;
        this._token          = null;
        this._manualClose    = false;
        this.symbolMap       = {};
        this._subscriptions  = {}; // key: `${symbol}_${granularity}` → subscription_id
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
            this._reconnectDelay = 2000;
            this._subscriptions  = {}; // clear stale sub IDs — new socket = clean slate
            this.socket.send(JSON.stringify({ authorize: this._token }));
            this.startKeepAlive();
            UIManager.log('WebSocket opened — authorizing...', 'info');
        };

        this.socket.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                // Track subscription IDs so we can forget them before re-subscribing
                if (data.subscription?.id && data.echo_req?.ticks_history) {
                    const key = `${data.echo_req.ticks_history}_${data.echo_req.granularity || 0}`;
                    this._subscriptions[key] = data.subscription.id;
                }
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
        // Forget any existing subscription for this symbol+TF before re-subscribing.
        // Prevents "already subscribed" errors on bot restart.
        const key    = `${symbol}_${granularity}`;
        const subId  = this._subscriptions[key];
        if (subId) {
            this._send({ forget: subId });
            delete this._subscriptions[key];
        }

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

    // Forget a specific symbol+granularity subscription (call when stopping a bot)
    forgetSymbol(symbol, granularity) {
        const key   = `${symbol}_${granularity}`;
        const subId = this._subscriptions[key];
        if (subId) {
            this._send({ forget: subId });
            delete this._subscriptions[key];
        }
    }

    // Forget all active subscriptions (call on full disconnect/logout)
    forgetAll() {
        this._send({ forget_all: 'candles' });
        this._subscriptions = {};
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