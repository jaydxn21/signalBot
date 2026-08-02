import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly load .env from root directory (one folder up from engine/)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { DerivClient } from './deriv-client.js';
import { MT5BridgeClient } from './mt5-bridge-client.js';
import { StrategyRunner } from './strategy-runner.js';
import { BotManager } from './bot-manager.js';
import { DashboardWSServer } from './ws-server.js';

const config = loadConfig({
  appId: process.env.APP_ID,
  token: process.env.TOKEN,
  accountId: process.env.ACCOUNT_ID,
  enginePort: process.env.WS_ENGINE_PORT,
});
const store = new Store({ persistPath: config.storeFile, autoMt5: config.autoMt5 });
const mt5Bridge = new MT5BridgeClient({
  url: config.bridgeUrl,
  onStatus: (connected) => store.setMt5Status(connected),
  onLog: (text, type) => store.addLog(text, type),
});
const runner = new StrategyRunner({ store, mt5Bridge });
let botManager;

const api = new DerivClient({
  appId: config.appId,
  token: config.token,
  accountId: config.accountId,
  onMessage: (data) => botManager.handleApiMessage(data),
  onStatus: (connected) => {
    store.setConnectionStatus(connected);
    if (connected) botManager.onConnectionRestored();
  },
  onLog: (text, type) => store.addLog(text, type),
});

botManager = new BotManager({ api, store, runner });
const wsServer = new DashboardWSServer({
  host: config.engineHost,
  port: config.enginePort,
  secret: config.dashboardSecret,
  store,
  botManager,
});

store.addLog(`Engine listening on ws://${config.engineHost}:${config.enginePort}`, 'info');
mt5Bridge.connect();
api.connect().catch((error) => {
  store.addLog(`Initial Deriv connection failed: ${error.message}`, 'error');
});

function shutdown() {
  store.addLog('Engine shutting down', 'warn');
  api.close();
  mt5Bridge.close();
  wsServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
