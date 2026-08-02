// engine/bot-manager.js — Central bot state registry and event hub
//
// All engine components communicate through this EventEmitter.  The
// ws-server subscribes here and fans events out to dashboard clients.
//
// Events emitted:
//   'log'           ({ level, msg })
//   'bots_list'     (snapshot array of all bot summaries)
//   'candle_update' ({ botId, symbol, tf, bar })
//   'trade_event'   ({ botId, symbol, strategy, type, entry, sl, tp, outcome, pnl })
//   'signal'        ({ botId, symbol, type, price, label, confidence })

import { EventEmitter } from 'events';

class BotManager extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);

        // keyed by botId
        this.bots    = {};

        // Global session counters
        this.session = {
            wins:       0,
            losses:     0,
            sessionPnL: 0,
            winRate:    0,
            accountEquity: parseFloat(process.env.INITIAL_EQUITY) || 10_000,
        };
    }

    // ─── BOT LIFECYCLE ───────────────────────────────────────────────────

    addBot(id, config) {
        if (this.bots[id]) return this.bots[id];

        const bot = {
            id,
            config,
            candles:    [],
            h4Candles:  [],
            htfCandles: [],
            htfGran:    14400,
            rsiState:   { prevAvgGain: 0, prevAvgLoss: 0, initialized: false },
            openSignal: null,
            lastFiredMs:   0,
            lastSLTimeMs:  0,
            lastSLBarIdx:  0,
            isActive:   false,
            sessionStart: null,
            wins:   0,
            losses: 0,
            pnl:    0,
            accountEquity: this.session.accountEquity,
            // jump75 multi-tf candle stores
            m5Candles:        [],
            m15Candles:       [],
            lastM5CloseTime:  null,
            lastM15CloseTime: null,
            lastH4CloseTime:  null,
        };

        this.bots[id] = bot;
        this.log('info', `Bot #${id} registered — ${config.strategy} on ${config.symbol}`);
        this._emitBotsList();
        return bot;
    }

    removeBot(id) {
        if (!this.bots[id]) return;
        delete this.bots[id];
        this._emitBotsList();
    }

    startBot(id) {
        const bot = this.bots[id];
        if (!bot) return null;
        bot.isActive     = true;
        bot.sessionStart = Date.now();
        this.log('info', `Bot #${id} started`);
        this._emitBotsList();
        return bot;
    }

    stopBot(id) {
        const bot = this.bots[id];
        if (!bot) return;
        bot.isActive = false;
        this.log('info', `Bot #${id} stopped`);
        this._emitBotsList();
    }

    getBot(id) { return this.bots[id] || null; }

    activeBots() {
        return Object.values(this.bots).filter(b => b.isActive);
    }

    // ─── SESSION STATE ───────────────────────────────────────────────────

    recordTrade({ botId, symbol, strategy, type, entry, sl, tp, outcome, pnl }) {
        const bot = this.bots[botId];

        if (outcome === 'TP') {
            this.session.wins++;
            this.session.sessionPnL += pnl;
            if (bot) { bot.wins++; bot.pnl += pnl; }
        } else {
            this.session.losses++;
            this.session.sessionPnL -= pnl;
            if (bot) { bot.losses++; bot.pnl -= pnl; }
        }

        const total = this.session.wins + this.session.losses;
        this.session.winRate = total > 0
            ? Math.round((this.session.wins / total) * 100)
            : 0;
        this.session.accountEquity = 10_000 + this.session.sessionPnL;

        const event = { botId, symbol, strategy, type, entry, sl, tp, outcome, pnl };
        this.emit('trade_event', event);
        this._emitBotsList();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────

    log(level, msg) {
        console.log(`[${level.toUpperCase()}] ${msg}`);
        this.emit('log', { level, msg, ts: Date.now() });
    }

    /** Broadcast a full snapshot of all bots + session stats. */
    _emitBotsList() {
        const snapshot = {
            bots: Object.values(this.bots).map(b => ({
                id:         b.id,
                config:     b.config,
                isActive:   b.isActive,
                wins:       b.wins,
                losses:     b.losses,
                pnl:        b.pnl,
                openSignal: b.openSignal,
                candleCount: b.candles.length,
            })),
            session: { ...this.session },
        };
        this.emit('bots_list', snapshot);
    }
}

export const botManager = new BotManager();
export default botManager;
