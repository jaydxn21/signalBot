// js/deriv-api.js - Updated for new Deriv API (OTP-only, legacy auth retired by Deriv)

import { UIManager } from './ui-manager.js';

export class DerivAPI {
    constructor(appId, onMessage) {
        this.appId = appId;  // Your OAuth App ID
        this.onMessage = onMessage;
        this.socket = null;
        this._pingInterval = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;
        this._maxDelay = 30000;
        this._token = null;
        this._accountId = null;
        this._accountType = 'demo'; // 'demo' | 'real' — used only if OTP response omits a ready-made URL
        this._manualClose = false;
        this.symbolMap = {};
        this._subscriptions = {};
        this._hasBackfilled = new Set(); // symbols we've already pulled tick history for
        this.isConnected = false;
    }

    // ─── MAIN CONNECT METHOD ──────────────────────────────────────────
    // Deriv retired the legacy wss://ws.derivws.com/websockets/v3 + `authorize`
    // flow. Every connection — demo or real — now requires an Account ID to
    // fetch a one-time OTP via REST, then connect to the OTP-scoped WS URL.
    // There is no more fallback path; if the Account ID is missing or the OTP
    // request fails, we stop and surface the error instead of looping forever
    // against a dead endpoint.

    async connect(token, accountId, accountType = 'demo') {
        this._token = token;
        this._accountId = accountId;
        this._accountType = accountType;
        this._manualClose = false;
        this._clearReconnectTimer();

        if (!this._accountId) {
            console.error('❌ Account ID required — Deriv no longer supports token-only auth');
            UIManager.log('Account ID required. Enter it in Settings to connect.', 'error');
            return;
        }

        try {
            console.log('🔑 Getting OTP from Deriv...');
            console.log(`📱 App ID: ${this.appId}`);
            console.log(`👤 Account: ${this._accountId}`);

            const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this._accountId}/otp`, {
                method: 'POST',
                headers: {
                    'Deriv-App-ID': this.appId,
                    'Authorization': `Bearer ${this._token}`,
                    'Content-Type': 'application/json'
                }
            });

            const responseForText = response.clone();
            let data;
            try {
                data = await response.json();
            } catch (e) {
                const text = await responseForText.text();
                console.error('Deriv non-JSON error response:', text);
                throw new Error(`OTP request failed (${response.status}): ${text}`);
            }
            console.log('📡 OTP Response:', data);

            if (!response.ok || data.error) {
                throw new Error(data.error?.message || `OTP request failed (${response.status})`);
            }

            // Response normally includes a ready-to-use WS URL with the OTP
            // already embedded. Fall back to building it manually from a raw
            // otp field against the demo/real endpoint if needed.
            let wsUrl = data.data?.url || data.websocket_url;
            const rawOtp = data.data?.otp || data.otp;

            if (!wsUrl && rawOtp) {
                wsUrl = `wss://api.derivws.com/trading/v1/options/ws/${this._accountType}?otp=${encodeURIComponent(rawOtp)}`;
            }

            if (!wsUrl) {
                throw new Error('OTP response contained no usable WebSocket URL');
            }

            console.log('✅ OTP received, connecting...');
            console.log('🔗', wsUrl);
            this._openSocket(wsUrl);

        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            UIManager.log(`Connection failed: ${error.message}`, 'error');
            this._scheduleReconnect();
        }
    }

    // ─── OPEN WEBSOCKET ───────────────────────────────────────────────

    _openSocket(url) {
        if (this.socket) {
            try { this.socket.close(); } catch(e) {}
        }

        console.log(`🔌 Opening WebSocket: ${url}`);
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            console.log('✅ WebSocket opened');
            this.isConnected = true;
            this._reconnectDelay = 2000;
            this._subscriptions = {};
            this._hasBackfilled.clear(); // fresh socket — re-backfill history on next symbol load

            // OTP flow: already authenticated via the URL — no authorize message needed.

            this.startKeepAlive();
            UIManager.setConnectionStatus(true);
            UIManager.log('Connected to Deriv API', 'info');

            // OTP flow authenticates via URL. Emit a synthetic authorize event
            // so downstream authorize-triggered initialization still runs.
            this.onMessage({ msg_type: 'authorize', authorize: { loginid: this._accountId } });
        };

        this.socket.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);

                if (data.msg_type === 'authorize') {
                    console.log('✅ AUTH SUCCESS!');
                    console.log(`👤 Account: ${data.authorize.loginid}`);
                    console.log(`💰 Balance: ${data.authorize.balance}`);
                    console.log(`📊 Type: ${data.authorize.account_type}`);
                    UIManager.log(`Connected as ${data.authorize.loginid}`, 'success');
                }

                // Track subscription IDs
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
            this.isConnected = false;
            UIManager.setConnectionStatus(false);

            if (this._manualClose) {
                UIManager.log('Disconnected.', 'warn');
                return;
            }

            console.log(`🔌 Disconnected: ${event.code} - ${event.reason || 'No reason'}`);
            UIManager.log(`Connection lost — reconnecting in ${this._reconnectDelay / 1000}s...`, 'warn');
            this._scheduleReconnect();
        };

        this.socket.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
            // onclose will fire after onerror
        };
    }

    // ─── RECONNECT LOGIC ──────────────────────────────────────────────
    // Always re-runs the OTP flow — there is no legacy path to fall back to.
    // If Account ID is still missing, connect() will log and stop rather than
    // loop, so this won't spin forever on a permanently broken config.

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            UIManager.log('Attempting reconnect...', 'info');
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
            this.connect(this._token, this._accountId, this._accountType);
        }, this._reconnectDelay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ─── API METHODS ──────────────────────────────────────────────────

    fetchActiveSymbols() {
        this._send({ active_symbols: 'brief' });
    }

    // ─── HISTORIC TICKS (for chart backfill) ───────────────────────────
    // One-shot request (no `subscribe`) — returns a `history` message with
    // parallel `prices[]` / `times[]` arrays. Call this once per symbol
    // right after connecting (or when switching symbols), then call
    // `subscribe()` separately to start the live candle/tick stream.
    fetchTickHistory(symbol, count = 500) {
        this._send({
            ticks_history: symbol,
            count,
            end: 'latest',
            style: 'ticks'
        });
    }

    // Convenience: backfill + subscribe in one call, guarded so a symbol's
    // history is only ever pulled once per socket connection.
    loadSymbol(symbol, granularity, count) {
        if (!this._hasBackfilled.has(symbol)) {
            this.fetchTickHistory(symbol, 500);
            this._hasBackfilled.add(symbol);
        }
        this.subscribe(symbol, granularity, count);
    }

    subscribe(symbol, granularity, count) {
        const key = `${symbol}_${granularity}`;
        const subId = this._subscriptions[key];
        if (subId) {
            this._send({ forget: subId });
            delete this._subscriptions[key];
        }

        const gran = parseInt(granularity, 10);
        const resolvedGran = Number.isFinite(gran) && gran > 0 ? gran : 60;
        const explicitCount = parseInt(count, 10);
        const resolvedCount = Number.isFinite(explicitCount) && explicitCount > 0
            ? explicitCount
            : this._candleCountForOneDay(resolvedGran);

        this._send({
            ticks_history: symbol,
            subscribe: 1,
            granularity: resolvedGran,
            count: resolvedCount,
            style: 'candles',
            end: 'latest',
            adjust_start_time: 1
        });
    }

    _candleCountForOneDay(granularitySeconds) {
        const ONE_DAY = 86400;
        const MIN_CANDLES = 200;
        const MAX_CANDLES = 5000;
        const safeGranularity = Number.isFinite(granularitySeconds) && granularitySeconds > 0
            ? granularitySeconds
            : 60;
        const forOneDay = Math.ceil(ONE_DAY / safeGranularity);
        return Math.min(MAX_CANDLES, Math.max(MIN_CANDLES, forOneDay));
    }

    forgetSymbol(symbol, granularity) {
        const key = `${symbol}_${granularity}`;
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
        this.isConnected = false;
    }

    // ─── GET ACCOUNT ID FROM UI ───────────────────────────────────────

    setAccountId(accountId) {
        this._accountId = accountId;
    }
}