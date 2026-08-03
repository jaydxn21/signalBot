// js/deriv-api.js - Updated for new Deriv API with OTP flow

import { UIManager } from './ui-manager.js';

export class DerivAPI {
    constructor(appId, onMessage) {
        this.appId = appId;  // Your OAuth App ID (e.g., '33XjCwFHSt1ck2f0Z3IND')
        this.onMessage = onMessage;
        this.socket = null;
        this._pingInterval = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;
        this._maxDelay = 30000;
        this._token = null;
        this._accountId = null;
        this._manualClose = false;
        this.symbolMap = {};
        this._subscriptions = {};
        this.isConnected = false;
    }

    // ─── MAIN CONNECT METHOD ──────────────────────────────────────────
    
 // In deriv-api.js - update the connect method

async connect(token, accountId) {
    this._token = token;
    this._accountId = accountId;
    this._manualClose = false;
    this._clearReconnectTimer();

    if (!this._accountId) {
        console.error('❌ Account ID required for OTP flow');
        UIManager.log('Account ID required. Please enter it.', 'error');
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

        const data = await response.json();
        console.log('📡 OTP Response:', data);

        if (data.error) {
            throw new Error(`OTP Error: ${data.error.message} (${data.error.code})`);
        }

        // ✅ FIX: Check for url in data.data
        const wsUrl = data.data?.url || data.websocket_url;
        
        if (!wsUrl) {
            console.warn('⚠️ No WebSocket URL in OTP response, using legacy fallback');
            this._connectLegacy();
            return;
        }

        console.log('✅ OTP received, connecting...');
        console.log('🔗', wsUrl);
        this._openSocket(wsUrl);

    } catch (error) {
        console.error('❌ Connection failed:', error.message);
        UIManager.log(`Connection failed: ${error.message}`, 'error');
        
        // Try legacy fallback
        console.log('🔄 Trying legacy connection as fallback...');
        this._connectLegacy();
    }
}

    // ─── LEGACY CONNECTION (FALLBACK) ────────────────────────────────

    _connectLegacy() {
        console.log('🔌 Connecting via legacy endpoint...');
        const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.appId)}`;
        this._openSocket(wsUrl, true);
    }

    // ─── OPEN WEBSOCKET ───────────────────────────────────────────────

    _openSocket(url, legacy = false) {
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
            
            if (legacy) {
                // Legacy: Send authorize with PAT
                this.socket.send(JSON.stringify({ authorize: this._token }));
            }
            // OTP flow: Already authenticated via URL
            
            this.startKeepAlive();
            UIManager.setConnectionStatus(true);
            UIManager.log('Connected to Deriv API', 'info');
        };

        this.socket.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                
                // Handle authorization response
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

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            UIManager.log('Attempting reconnect...', 'info');
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
            if (this._accountId) {
                this.connect(this._token, this._accountId);
            } else {
                this._connectLegacy();
            }
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