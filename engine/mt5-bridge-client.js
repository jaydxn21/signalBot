import WebSocket from 'ws';

export class MT5BridgeClient {
  constructor({ url, onStatus, onLog }) {
    this.url = url;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.socket = null;
    this.queue = [];
    this._reconnectTimer = null;
  }

  log(message, type = 'info') {
    this.onLog?.(message, type);
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.socket = new WebSocket(this.url);

    this.socket.on('open', () => {
      this.onStatus?.(true);
      this.log('Connected to MT5 bridge', 'info');
      const queued = [...this.queue];
      this.queue = [];
      queued.forEach(message => this.send(message));
    });

    this.socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data?.type === 'heartbeat') return;
      } catch {}
    });

    this.socket.on('close', () => {
      this.onStatus?.(false);
      this.log('MT5 bridge disconnected', 'warn');
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    });

    this.socket.on('error', (error) => {
      this.log(`MT5 bridge error: ${error.message}`, 'warn');
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queue.push(message);
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close() {
    clearTimeout(this._reconnectTimer);
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
  }
}
