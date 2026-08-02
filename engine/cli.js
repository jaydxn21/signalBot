import readline from 'readline';
import WebSocket from 'ws';
import { loadConfig } from './config.js';

const config = loadConfig();
const secretQuery = config.dashboardSecret ? `?secret=${encodeURIComponent(config.dashboardSecret)}` : '';
const socketUrl = `ws://127.0.0.1:${config.enginePort}${secretQuery}`;

let latestBots = [];

const ws = new WebSocket(socketUrl);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

function printBots() {
  if (!latestBots.length) {
    console.log('No bots.');
    return;
  }
  for (const bot of latestBots) {
    console.log(`  [${bot.id}] ${bot.config.symbol} | ${bot.config.strategy} | ${bot.isActive ? 'RUNNING' : 'STOPPED'} | W/L ${bot.wins}/${bot.losses} | ${bot.pnl >= 0 ? '+' : ''}${bot.pnl.toFixed(2)}`);
  }
}

function send(type, extra = {}) {
  ws.send(JSON.stringify({ type, ...extra }));
}

ws.on('open', () => {
  console.log(`Connected to ${socketUrl}`);
  console.log('Commands: list | start <id> | stop <id> | remove <id> | create <symbol> <strategy> <tf> [lot] | mt5 on|off | quit');
  rl.prompt();
});

ws.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'bots_list') {
    latestBots = message.bots || [];
  }
  if (message.type === 'log_line') {
    console.log(`[${new Date(message.time).toLocaleTimeString()}] ${message.text}`);
  }
  rl.prompt();
});

ws.on('close', () => {
  console.log('Disconnected from engine');
  process.exit(0);
});

rl.on('line', (line) => {
  const [command, ...args] = line.trim().split(/\s+/);
  if (!command) return rl.prompt();

  switch (command) {
    case 'list':
      printBots();
      break;
    case 'start':
      if (args[0]) send('start_bot', { id: args[0] });
      break;
    case 'stop':
      if (args[0]) send('stop_bot', { id: args[0] });
      break;
    case 'remove':
      if (args[0]) send('remove_bot', { id: args[0] });
      break;
    case 'create': {
      const [symbol, strategy, tf, lotSize] = args;
      if (!symbol || !strategy || !tf) {
        console.log('Usage: create <symbol> <strategy> <tf> [lot]');
        break;
      }
      send('create_bot', { config: { symbol, strategy, tf: Number(tf), lotSize: Number(lotSize || 0.01) } });
      break;
    }
    case 'mt5':
      if (args[0] === 'on' || args[0] === 'off') send('set_auto_mt5', { enabled: args[0] === 'on' });
      break;
    case 'quit':
    case 'exit':
      rl.close();
      ws.close();
      return;
    default:
      console.log('Unknown command');
  }
  rl.prompt();
});
