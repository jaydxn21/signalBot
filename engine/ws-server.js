// engine/ws-server.js — Internal WebSocket server on port 4000
//
// Dashboard browsers and the CLI connect here to receive real-time
// state snapshots and send control commands back to the engine.
//
// Outbound message types (JSON):
//   { type: 'bots_list',     data: { bots, session } }
//   { type: 'candle_update', data: { botId, symbol, tf, bar, isNew } }
//   { type: 'trade_event',   data: { botId, symbol, ... outcome, pnl } }
//   { type: 'signal',        data: { botId, symbol, type, price, label, confidence } }
//   { type: 'log_line',      data: { level, msg, ts } }
//
// Inbound command messages (JSON):
//   { cmd: 'list' }
//   { cmd: 'start', botId }
//   { cmd: 'stop',  botId }
//   { cmd: 'status' }

import { WebSocketServer } from 'ws';
import { botManager }      from './bot-manager.js';

const WS_PORT = parseInt(process.env.ENGINE_WS_PORT) || 4000;

export function startWsServer() {
    const wss = new WebSocketServer({ port: WS_PORT });

    console.log(`[WsServer] Listening on ws://0.0.0.0:${WS_PORT}`);

    // ── helpers ──────────────────────────────────────────────────────────

    function broadcast(type, data) {
        const msg = JSON.stringify({ type, data });
        for (const client of wss.clients) {
            if (client.readyState === 1 /* OPEN */) {
                client.send(msg);
            }
        }
    }

    function send(ws, type, data) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
    }

    // ── forward botManager events to all connected clients ───────────────

    botManager.on('bots_list',     data => broadcast('bots_list',     data));
    botManager.on('candle_update', data => broadcast('candle_update', data));
    botManager.on('trade_event',   data => broadcast('trade_event',   data));
    botManager.on('signal',        data => broadcast('signal',        data));
    botManager.on('log',           data => broadcast('log_line',      data));

    // ── connection handler ───────────────────────────────────────────────

    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress;
        console.log(`[WsServer] Client connected from ${ip}`);

        // Immediately push the current bots snapshot so the dashboard
        // can paint itself without waiting for the next event cycle.
        send(ws, 'bots_list', {
            bots: Object.values(botManager.bots).map(b => ({
                id:          b.id,
                config:      b.config,
                isActive:    b.isActive,
                wins:        b.wins,
                losses:      b.losses,
                pnl:         b.pnl,
                openSignal:  b.openSignal,
                candleCount: b.candles.length,
            })),
            session: { ...botManager.session },
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                _handleCommand(ws, msg);
            } catch (e) {
                send(ws, 'error', { msg: `Bad JSON: ${e.message}` });
            }
        });

        ws.on('close', () => {
            console.log(`[WsServer] Client disconnected from ${ip}`);
        });

        ws.on('error', (err) => {
            console.error(`[WsServer] Client error (${ip}):`, err.message);
        });
    });

    // ── command dispatcher ───────────────────────────────────────────────

    function _handleCommand(ws, msg) {
        switch (msg.cmd) {
            case 'list':
                send(ws, 'bots_list', {
                    bots: Object.values(botManager.bots).map(b => ({
                        id:          b.id,
                        config:      b.config,
                        isActive:    b.isActive,
                        wins:        b.wins,
                        losses:      b.losses,
                        pnl:         b.pnl,
                        openSignal:  b.openSignal,
                        candleCount: b.candles.length,
                    })),
                    session: { ...botManager.session },
                });
                break;

            case 'start': {
                const bot = botManager.getBot(msg.botId);
                if (!bot) { send(ws, 'error', { msg: `Bot ${msg.botId} not found` }); break; }
                botManager.startBot(msg.botId);
                send(ws, 'ack', { cmd: 'start', botId: msg.botId });
                break;
            }

            case 'stop': {
                const bot = botManager.getBot(msg.botId);
                if (!bot) { send(ws, 'error', { msg: `Bot ${msg.botId} not found` }); break; }
                botManager.stopBot(msg.botId);
                send(ws, 'ack', { cmd: 'stop', botId: msg.botId });
                break;
            }

            case 'status':
                send(ws, 'status', {
                    activeBots: botManager.activeBots().length,
                    session:    { ...botManager.session },
                    uptime:     process.uptime(),
                });
                break;

            default:
                send(ws, 'error', { msg: `Unknown command: ${msg.cmd}` });
        }
    }

    wss.on('error', (err) => {
        console.error('[WsServer] Server error:', err.message);
    });

    return wss;
}
