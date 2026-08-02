// engine/deriv-client.js — Node.js Deriv WebSocket client
// Credentials are read from process.env; the browser DerivAPI is separate.

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class DerivClient extends EventEmitter {
    constructor() {
        super();
        this.appId     = process.env.DERIV_APP_ID;
        this.token     = process.env.DERIV_API_TOKEN;
        this.accountId = process.env.DERIV_ACCOUNT_ID;

        this.socket           = null;
        this._pingInterval    = null;
        this._reconnectTimer  = null;
        this._reconnectDelay  = 2000;
        this._maxDelay        = 30_000;
        this._manualClose     = false;
        this._subscriptions   = {};
        this.isConnected      = false;
    }

    // ─── CONNECT ──────────────────────────────────────────────────────────

    async connect() {
        if (!this.appId || !this.token) {
            throw new Error('DERIV_APP_ID and DERIV_API_TOKEN must be set in process.env');
        }

        this._manualClose = false;
        this._clearReconnectTimer();

        if (this.accountId) {
            try {
                await this._connectOTP();
                return;
            } catch (err) {
                console.warn('[DerivClient] OTP flow failed, falling back to legacy:', err.message);
            }
        }

        this._connectLegacy();
    }

    async _connectOTP() {
        console.log('[DerivClient] Requesting OTP…');

        const res = await fetch(
            `https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`,
            {
                method: 'POST',
                headers: {
                    'Deriv-App-ID':  this.appId,
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type':  'application/json',
                },
            }
        );

        const data = await res.json();
        if (data.error) throw new Error(`${data.error.message} (${data.error.code})`);

        const wsUrl = data.data?.url || data.websocket_url;
        if (!wsUrl) throw new Error('No WebSocket URL in OTP response');

        console.log('[DerivClient] OTP received, connecting to:', wsUrl);
        this._openSocket(wsUrl, false);
    }

    _connectLegacy() {
        const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
        console.log('[DerivClient] Connecting (legacy):', wsUrl);
        this._openSocket(wsUrl, true);
    }

    // ─── SOCKET LIFECYCLE ────────────────────────────────────────────────

    _openSocket(url, legacy = false) {
        if (this.socket) {
            try { this.socket.terminate(); } catch (_) {}
        }

        this.socket = new WebSocket(url);

        this.socket.on('open', () => {
            this.isConnected      = true;
            this._reconnectDelay  = 2000;
            this._subscriptions   = {};
            console.log('[DerivClient] Connected');

            if (legacy) {
                this._send({ authorize: this.token });
            }

            this._startKeepAlive();
            this.emit('connected');
        });

        this.socket.on('message', (raw) => {
            try {
                const data = JSON.parse(raw);

                if (data.subscription?.id && data.echo_req?.ticks_history) {
                    const key = `${data.echo_req.ticks_history}_${data.echo_req.granularity || 0}`;
                    this._subscriptions[key] = data.subscription.id;
                }

                this.emit('message', data);
            } catch (e) {
                console.error('[DerivClient] Parse error:', e.message);
            }
        });

        this.socket.on('close', (code, reason) => {
            clearInterval(this._pingInterval);
            this.isConnected = false;
            this.emit('disconnected', { code, reason: reason?.toString() });

            if (!this._manualClose) {
                console.log(`[DerivClient] Disconnected (${code}), reconnecting in ${this._reconnectDelay / 1000}s…`);
                this._scheduleReconnect();
            }
        });

        this.socket.on('error', (err) => {
            console.error('[DerivClient] Error:', err.message);
            this.emit('error', err);
        });
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
            try { await this.connect(); } catch (e) { /* will retry */ }
        }, this._reconnectDelay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _startKeepAlive() {
        clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => this._send({ ping: 1 }), 25_000);
    }

    // ─── API ─────────────────────────────────────────────────────────────

    fetchActiveSymbols() {
        this._send({ active_symbols: 'brief' });
    }

    subscribe(symbol, granularity) {
        const key   = `${symbol}_${granularity}`;
        const subId = this._subscriptions[key];
        if (subId) {
            this._send({ forget: subId });
            delete this._subscriptions[key];
        }
        this._send({
            ticks_history:    symbol,
            subscribe:        1,
            granularity:      parseInt(granularity),
            count:            500,
            style:            'candles',
            end:              'latest',
            adjust_start_time: 1,
        });
    }

    forgetSymbol(symbol, granularity) {
        const key   = `${symbol}_${granularity}`;
        const subId = this._subscriptions[key];
        if (subId) {
            this._send({ forget: subId });
            delete this._subscriptions[key];
        }
    }

    forgetAll() {
        this._send({ forget_all: 'candles' });
        this._subscriptions = {};
    }

    disconnect() {
        this._manualClose = true;
        this._clearReconnectTimer();
        clearInterval(this._pingInterval);
        if (this.socket) {
            this.socket.terminate();
            this.socket = null;
        }
        this.isConnected = false;
    }

    _send(payload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        } else {
            console.warn('[DerivClient] Socket not open, dropped:', Object.keys(payload)[0]);
        }
    }
}

export default DerivClient;
