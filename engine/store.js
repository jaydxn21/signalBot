import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export class Store extends EventEmitter {
    constructor({ persistFile }) {
        super();
        this.persistFile = persistFile;
        this.bots = new Map();
        this.logs = [];
        this.tradeHistory = [];
        this._persistTimer = null;
        this._load();
    }

    _load() {
        if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
            for (const bot of raw.bots || []) {
                this.bots.set(String(bot.id), bot);
            }
            this.logs = Array.isArray(raw.logs) ? raw.logs : [];
            this.tradeHistory = Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [];
        } catch (error) {
            console.error('[store] Failed to load persisted state:', error.message);
        }
    }

    _schedulePersist() {
        if (!this.persistFile) return;
        clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => this._persist(), 300);
    }

    _persist() {
        try {
            fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
            const payload = {
                bots: Array.from(this.bots.values()),
                logs: this.logs.slice(0, 500),
                tradeHistory: this.tradeHistory.slice(0, 2000),
            };
            fs.writeFileSync(this.persistFile, JSON.stringify(payload, null, 2));
        } catch (error) {
            console.error('[store] Failed to persist state:', error.message);
        }
    }

    setBot(bot) {
        const id = String(bot.id);
        this.bots.set(id, bot);
        this.emitBotsList();
        this._schedulePersist();
    }

    updateBot(id, patch) {
        const key = String(id);
        const bot = this.bots.get(key);
        if (!bot) return null;
        Object.assign(bot, patch);
        this.bots.set(key, bot);
        this.emitBotsList();
        this._schedulePersist();
        return bot;
    }

    removeBot(id) {
        this.bots.delete(String(id));
        this.emitBotsList();
        this._schedulePersist();
    }

    getBot(id) {
        return this.bots.get(String(id)) || null;
    }

    getBots() {
        return Array.from(this.bots.values());
    }

    botsListPayload() {
        return this.getBots().map((bot) => ({
            id: bot.id,
            config: bot.config,
            isActive: !!bot.isActive,
            wins: bot.wins || 0,
            losses: bot.losses || 0,
            pnl: bot.pnl || 0,
            openSignal: bot.openSignal || null,
        }));
    }

    emitBotsList() {
        this.emit('bots_list', this.botsListPayload());
    }

    pushLog(text, type = 'info') {
        const line = { text, type, time: Date.now() };
        this.logs.unshift(line);
        if (this.logs.length > 500) this.logs.pop();
        this.emit('log_line', line);
        this._schedulePersist();
    }

    pushTrade(event) {
        this.tradeHistory.unshift(event);
        if (this.tradeHistory.length > 2000) this.tradeHistory.pop();
        this.emit('trade_event', event);
        this._schedulePersist();
    }
}

