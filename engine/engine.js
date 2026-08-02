import { config } from './config.js';
import { Store } from './store.js';
import { DerivClient } from './deriv-client.js';
import { MT5BridgeClient } from './mt5-bridge-client.js';
import { StrategyRunner } from './strategy-runner.js';
import { BotManager } from './bot-manager.js';
import { EngineWSServer } from './ws-server.js';
import { startCLI } from './cli.js';

const store = new Store({ persistFile: config.engine.storeFile });
const mt5Bridge = new MT5BridgeClient({
    bridgeUrl: config.mt5.bridgeUrl,
    enabled: config.mt5.enabled,
    onLog: (text, type) => store.pushLog(text, type),
});
const derivClient = new DerivClient({
    appId: config.deriv.appId,
    token: config.deriv.token,
});
const strategyRunner = new StrategyRunner({ store, mt5Bridge });
const botManager = new BotManager({ store, derivClient, strategyRunner });
const wsServer = new EngineWSServer({
    port: config.engine.wsPort,
    secret: config.engine.wsSecret,
    store,
    botManager,
});

derivClient.on('authorized', (auth) => {
    store.pushLog(`Deriv authorized (${auth.loginid})`, 'info');
    botManager.resubscribeActiveBots();
});

derivClient.on('log', (text, type) => store.pushLog(text, type));
derivClient.on('error_message', (error, req) => {
    const symbol = req?.ticks_history || req?.symbol || '?';
    const gran = req?.granularity ? ` ${req.granularity}` : '';
    store.pushLog(`Deriv error [${symbol}${gran}]: ${error.message}`, 'warn');
});

mt5Bridge.connect();
derivClient.connect();
wsServer.start();
startCLI({ botManager, store });

store.pushLog(`Engine websocket listening on :${config.engine.wsPort}`, 'info');
store.pushLog('Engine started', 'info');
