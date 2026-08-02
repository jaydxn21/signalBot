#!/usr/bin/env node
// engine/cli.js — SSH-friendly terminal CLI for the engine WS server
//
// Usage:
//   node engine/cli.js [ws://host:4000]
//
// Commands:
//   list           — show all bots and session stats
//   start <botId>  — activate a bot
//   stop  <botId>  — deactivate a bot
//   status         — show engine uptime and session summary
//   help           — print this list
//   quit / exit    — disconnect and exit

import WebSocket  from 'ws';
import readline   from 'readline';

const WS_URL = process.argv[2] ?? `ws://localhost:${process.env.ENGINE_WS_PORT || 4000}`;

console.log(`\n🖥  NEXUS Engine CLI`);
console.log(`   Connecting to ${WS_URL} …\n`);

const ws = new WebSocket(WS_URL);

const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
    prompt:   'nexus> ',
});

ws.on('open', () => {
    console.log('✅ Connected. Type "help" for a command list.\n');
    rl.prompt();
});

ws.on('message', (raw) => {
    try {
        const { type, data } = JSON.parse(raw);
        _render(type, data);
    } catch (e) {
        console.error('[parse error]', e.message);
    }
    rl.prompt();
});

ws.on('close', (code, reason) => {
    console.log(`\n⚡ Disconnected (${code}${reason ? ': ' + reason : ''})`);
    rl.close();
    process.exit(0);
});

ws.on('error', (err) => {
    console.error(`\n❌ Connection error: ${err.message}`);
    process.exit(1);
});

// ── readline ─────────────────────────────────────────────────────────────

rl.on('line', (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd   = parts[0]?.toLowerCase();

    if (!cmd) { rl.prompt(); return; }

    switch (cmd) {
        case 'list':
        case 'ls':
            _send({ cmd: 'list' });
            break;

        case 'start':
            if (!parts[1]) { console.log('Usage: start <botId>'); rl.prompt(); return; }
            _send({ cmd: 'start', botId: parts[1] });
            break;

        case 'stop':
            if (!parts[1]) { console.log('Usage: stop <botId>'); rl.prompt(); return; }
            _send({ cmd: 'stop', botId: parts[1] });
            break;

        case 'status':
            _send({ cmd: 'status' });
            break;

        case 'help':
        case '?':
            _printHelp();
            rl.prompt();
            break;

        case 'quit':
        case 'exit':
        case 'q':
            ws.close();
            rl.close();
            process.exit(0);
            break;

        default:
            console.log(`Unknown command "${cmd}". Type "help" for options.`);
            rl.prompt();
    }
});

rl.on('close', () => process.exit(0));

// ── helpers ───────────────────────────────────────────────────────────────

function _send(msg) {
    if (ws.readyState !== WebSocket.OPEN) {
        console.error('Not connected');
        return;
    }
    ws.send(JSON.stringify(msg));
}

function _render(type, data) {
    switch (type) {
        case 'bots_list': {
            console.log('\n── Bots ────────────────────────────────────────────');
            if (!data.bots.length) {
                console.log('  (no bots registered)');
            } else {
                for (const b of data.bots) {
                    const state = b.isActive ? '🟢 RUNNING' : '⚫ STOPPED';
                    const sig   = b.openSignal
                        ? ` | IN TRADE: ${b.openSignal.type} @ ${b.openSignal.entry}`
                        : '';
                    console.log(
                        `  #${b.id}  ${state}  ${b.config.strategy} / ${b.config.symbol}` +
                        `  W:${b.wins} L:${b.losses} PnL:${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}` +
                        sig
                    );
                }
            }
            const s = data.session;
            console.log(
                `\n── Session ─ W:${s.wins} L:${s.losses} ` +
                `WR:${s.winRate}% PnL:${s.sessionPnL >= 0 ? '+' : ''}$${s.sessionPnL.toFixed(2)}\n`
            );
            break;
        }

        case 'trade_event': {
            const icon = data.outcome === 'TP' ? '✅' : '❌';
            console.log(
                `\n${icon} TRADE ${data.outcome}  #${data.botId} ${data.type} ${data.symbol}` +
                `  PnL: ${data.outcome === 'TP' ? '+' : '-'}$${data.pnl.toFixed(2)}\n`
            );
            break;
        }

        case 'signal': {
            const icon = data.type === 'BUY' ? '🟢' : '🔴';
            console.log(
                `\n${icon} SIGNAL  #${data.botId} ${data.type} ${data.symbol}` +
                `  @ ${data.price}  [${data.label}]  ${data.confidence.grade}(${data.confidence.score})\n`
            );
            break;
        }

        case 'log_line': {
            const prefix = data.level === 'error' ? '❌' : data.level === 'warn' ? '⚠️ ' : 'ℹ️ ';
            console.log(`${prefix} ${data.msg}`);
            break;
        }

        case 'status': {
            const s       = data.session;
            const upMins  = Math.floor(data.uptime / 60);
            console.log(
                `\n── Engine Status ───────────────────────────────────\n` +
                `  Uptime:    ${upMins} min\n` +
                `  Active:    ${data.activeBots} bots\n` +
                `  Equity:    $${s.accountEquity.toFixed(2)}\n` +
                `  W/L:       ${s.wins}/${s.losses}  WR: ${s.winRate}%\n` +
                `  PnL:       ${s.sessionPnL >= 0 ? '+' : ''}$${s.sessionPnL.toFixed(2)}\n`
            );
            break;
        }

        case 'ack':
            console.log(`✔ ACK: ${data.cmd} ${data.botId ?? ''}`);
            break;

        case 'error':
            console.error(`⚠ Server error: ${data.msg}`);
            break;

        default:
            // Silently ignore candle_update and other high-frequency events
            break;
    }
}

function _printHelp() {
    console.log(`
  Commands:
    list              Show all bots and session stats
    start <botId>     Activate a bot
    stop  <botId>     Deactivate a bot
    status            Engine uptime + session summary
    help              This message
    quit / exit       Disconnect
`);
}
