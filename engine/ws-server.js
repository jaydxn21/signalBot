import { WebSocketServer } from 'ws';

export class DashboardWSServer {
  constructor({ host, port, secret, store, botManager }) {
    this.secret = secret;
    this.store = store;
    this.botManager = botManager;
    this.wss = new WebSocketServer({ host, port });
    this.bindStoreEvents();
    this.bindServerEvents();
  }

  bindStoreEvents() {
    this.store.on('bots_list', (bots) => this.broadcast({ type: 'bots_list', bots }));
    this.store.on('log_line', (line) => this.broadcast({ type: 'log_line', ...line }));
    this.store.on('trade_event', (event) => this.broadcast({ type: 'trade_event', ...event }));
    this.store.on('candle_update', (payload) => this.broadcast({ type: 'candle_update', ...payload }));
    this.store.on('engine_status', (status) => this.broadcast({ type: 'engine_status', ...status }));
    this.store.on('settings', (settings) => this.broadcast({ type: 'settings', ...settings }));
  }

  bindServerEvents() {
    this.wss.on('connection', (socket, req) => {
      const url = new URL(req.url || '/', 'ws://localhost');
      if (this.secret && url.searchParams.get('secret') !== this.secret) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      this.send(socket, { type: 'engine_status', ...this.store.getEngineStatus() });
      this.send(socket, { type: 'settings', autoMt5: this.store.getAutoMt5() });
      this.send(socket, { type: 'bots_list', bots: this.store.getBotsList() });
      this.send(socket, { type: 'log_history', lines: this.store.getLogs() });
      this.send(socket, { type: 'trade_history', trades: this.store.getTrades() });

      socket.on('message', async (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          await this.handleMessage(socket, message);
        } catch (error) {
          this.send(socket, { type: 'error', message: error.message || 'Invalid message' });
        }
      });
    });
  }

  async handleMessage(socket, message) {
    switch (message.type) {
      case 'create_bot': {
        const bot = this.botManager.createBot(message.config);
        this.send(socket, { type: 'bot_created', bot });
        break;
      }
      case 'update_bot': {
        const bot = this.botManager.updateBot(message.id, message.config);
        this.send(socket, { type: 'bot_updated', bot });
        break;
      }
      case 'start_bot': {
        this.botManager.startBot(message.id);
        break;
      }
      case 'stop_bot': {
        this.botManager.stopBot(message.id);
        break;
      }
      case 'remove_bot': {
        this.botManager.removeBot(message.id);
        break;
      }
      case 'get_candles': {
        const candles = this.botManager.getCandles(message.id);
        this.send(socket, { type: 'candle_history', botId: String(message.id), ...candles });
        break;
      }
      case 'set_auto_mt5': {
        this.store.setAutoMt5(Boolean(message.enabled));
        break;
      }
      case 'ping': {
        this.send(socket, { type: 'pong', time: Date.now() });
        break;
      }
      default:
        this.send(socket, { type: 'error', message: `Unsupported message type: ${message.type}` });
    }
  }

  send(socket, payload) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  close() {
    this.wss.close();
  }
}
