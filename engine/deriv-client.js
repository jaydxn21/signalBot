import WebSocket from 'ws';

export class DerivClient {
  constructor({ appId, token, accountId, onMessage, onStatus, onLog }) {
    this.appId = appId;
    this.token = token;
    this.accountId = accountId;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.socket = null;
    this._pingInterval = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;
    this._maxDelay = 30000;
    this._subscriptions = {};
    this._manualClose = false;
  }

  log(message, type = 'info') {
    if (this.onLog) this.onLog(message, type);
  }

  async connect() {
    this._manualClose = false;
    this._clearReconnectTimer();

    if (!this.appId || !this.token || !this.accountId) {
      throw new Error('APP_ID, TOKEN, and ACCOUNT_ID must be configured');
    }

    try {
      this.log('Requesting Deriv OTP session...', 'info');
      const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`, {
        method: 'POST',
        headers: {
          'Deriv-App-ID': this.appId,
          'Authorization': `******
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error?.message || `OTP request failed (${response.status})`);
      }

      const wsUrl = data.data?.url || data.websocket_url;
      if (!wsUrl) {
        throw new Error('Deriv OTP response missing websocket URL');
      }

      this._openSocket(wsUrl, false);
    } catch (error) {
      this.log(`Deriv OTP failed, falling back to legacy auth: ${error.message}`, 'warn');
      this._connectLegacy();
    }
  }

  _connectLegacy() {
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.appId)}`;
    this._openSocket(wsUrl, true);
  }

  _openSocket(url, legacy) {
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }

    this.socket = new WebSocket(url);

    this.socket.on('open', () => {
      this._reconnectDelay = 2000;
      this._subscriptions = {};
      if (legacy) {
        this._send({ authorize: this.token });
      }
      this.startKeepAlive();
      this.onStatus?.(true);
      this.log('Connected to Deriv API', 'info');
    });

    this.socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.subscription?.id && data.echo_req?.ticks_history) {
          const key = `${data.echo_req.ticks_history}_${data.echo_req.granularity || 0}`;
          this._subscriptions[key] = data.subscription.id;
        }
        this.onMessage?.(data);
      } catch (error) {
        this.log(`Failed to parse Deriv message: ${error.message}`, 'warn');
      }
    });

    this.socket.on('close', (code, reasonBuffer) => {
      clearInterval(this._pingInterval);
      this.onStatus?.(false);
      if (this._manualClose) {
        this.log('Disconnected from Deriv API', 'warn');
        return;
      }
      const reason = reasonBuffer?.toString?.() || '';
      this.log(`Deriv connection lost (${code}${reason ? `: ${reason}` : ''})`, 'warn');
      this._scheduleReconnect();
    });

    this.socket.on('error', (error) => {
      this.log(`Deriv socket error: ${error.message}`, 'warn');
    });
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
      this.connect().catch((error) => {
        this.log(`Reconnect failed: ${error.message}`, 'warn');
        this._scheduleReconnect();
      });
    }, this._reconnectDelay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  startKeepAlive() {
    clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      this._send({ ping: 1 });
    }, 30000);
  }

  fetchActiveSymbols() {
    this._send({ active_symbols: 'brief' });
  }

  subscribe(symbol, granularity) {
    const key = `${symbol}_${granularity}`;
    const subId = this._subscriptions[key];
    if (subId) {
      this._send({ forget: subId });
      delete this._subscriptions[key];
    }
    this._send({
      ticks_history: symbol,
      subscribe: 1,
      granularity: Number.parseInt(granularity, 10),
      count: 500,
      style: 'candles',
      end: 'latest',
      adjust_start_time: 1,
    });
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
    for (const key of Object.keys(this._subscriptions)) {
      this._send({ forget: this._subscriptions[key] });
      delete this._subscriptions[key];
    }
  }

  close() {
    this._manualClose = true;
    this.forgetAll();
    clearInterval(this._pingInterval);
    this._clearReconnectTimer();
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
  }

  _send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}
