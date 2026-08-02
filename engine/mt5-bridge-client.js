import WebSocket from 'ws';

const MT5_SYMBOL_MAP = {
    stpRNG: 'Step Index',
    STEP: 'Step Index',
    'Step Index 100': 'Step Index',
    'Step Index 200': 'Step Index 200',
    OTC_NDX: 'US Tech 100',
    OTC_SPC: 'US 500',
    OTC_DJI: 'Wall Street 30',
};

export class MT5BridgeClient {
    constructor({ bridgeUrl, enabled, onLog }) {
        this.bridgeUrl = bridgeUrl;
        this.enabled = enabled;
        this.onLog = onLog;
        this.socket = null;
        this.pending = [];
        this._reconnectTimer = null;
    }

    connect() {
        if (!this.enabled) return;
        this.socket = new WebSocket(this.bridgeUrl);
        this.socket.on('open', () => {
            this.onLog?.(`Connected to MT5 bridge (${this.bridgeUrl})`, 'info');
            while (this.pending.length) {
                const payload = this.pending.shift();
                this._send(payload);
            }
        });
        this.socket.on('close', () => {
            this.onLog?.('MT5 bridge disconnected, retrying...', 'warn');
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => this.connect(), 3000);
        });
        this.socket.on('error', (error) => {
            this.onLog?.(`MT5 bridge error: ${error.message}`, 'warn');
        });
    }

    sendSignal({ action, symbol, lotSize }) {
        if (!this.enabled) return;
        const mt5Symbol = MT5_SYMBOL_MAP[symbol] || symbol;
        const payload = {
            action: action.toLowerCase(),
            symbol: mt5Symbol,
            lotSize: Math.max(0.01, Number(lotSize || 0.01)),
            timestamp: Date.now(),
            source: 'signalbot-engine',
        };
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.pending.push(payload);
            return;
        }
        this._send(payload);
    }

    _send(payload) {
        try {
            this.socket.send(JSON.stringify(payload));
        } catch (error) {
            this.onLog?.(`Failed to send MT5 signal: ${error.message}`, 'warn');
            this.pending.push(payload);
        }
    }
}

