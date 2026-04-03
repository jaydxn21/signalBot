// nova.js — Crash & Boom Spike Reversion Strategy
//
// Crash/Boom has NO structural levels (synthetic indices)
// This strategy trades ONLY spike reversions
//
// RULES:
//   - Detect spike of 4x+ ATR
//   - Enter fade after confirmation candle
//   - TP at 50% of spike size
//   - SL beyond spike extreme

const NOVA_SYMBOLS = {
    'CRASH1000':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.5 },
    'BOOM1000':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.5 },
    'CRASH_1000': { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.5 },
    'BOOM_1000':  { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.5 },
    'CRASH500':   { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.4 },
    'BOOM500':    { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.4 },
    'CRASH_500':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.4 },
    'BOOM_500':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.4 },
};

const CONFIG = {
    MIN_SPIKE_MAGNITUDE: 2.5,     // Was 4.0 — much lower
    MIN_CONFIDENCE: 50,            // Was 65
    MAX_TRADES_PER_HOUR: 2,        // Was 1
    COOLDOWN_MINUTES: 5,           // Was 15
    MAX_CONSECUTIVE_LOSSES: 6,     // Was 4
    SL_BUFFER: 1.5,                // Was 1.2
    TP_RATIO: 0.5,                 // Was 0.6
};

export function novaSymbolConfig(symbol) {
    return NOVA_SYMBOLS[symbol] || null;
}

function _atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _detectSpike(candles, atr) {
    if (!candles || candles.length < 2 || !atr || atr <= 0) return null;
    
    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    if (!current || !previous) return null;
    
    const candlesToCheck = [previous, current];
    let bestSpike = null;
    const spikeThreshold = atr * CONFIG.MIN_SPIKE_MAGNITUDE;
    
    for (const c of candlesToCheck) {
        const wickUp = c.high - Math.max(c.open, c.close);
        const wickDown = Math.min(c.open, c.close) - c.low;
        const body = Math.abs(c.close - c.open);
        
        const isUpSpike = wickUp >= spikeThreshold && wickUp > body;
        const isDownSpike = wickDown >= spikeThreshold && wickDown > body;
        const isBullBody = c.close > c.open && body >= spikeThreshold;
        const isBearBody = c.close < c.open && body >= spikeThreshold;
        
        if (isUpSpike || isBullBody) {
            const magnitude = (isBullBody ? body : wickUp) / atr;
            if (!bestSpike || magnitude > bestSpike.magnitude) {
                bestSpike = { direction: 'up', magnitude, time: c.time };
            }
        }
        if (isDownSpike || isBearBody) {
            const magnitude = (isBearBody ? body : wickDown) / atr;
            if (!bestSpike || magnitude > bestSpike.magnitude) {
                bestSpike = { direction: 'down', magnitude, time: c.time };
            }
        }
    }
    
    return bestSpike;
}

export function detectSpike(candles, atr) {
    return _detectSpike(candles, atr);
}

export const NovaStrategy = {
    
    _spikeState: {},
    _stats: {},
    
    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = { consLosses: 0, tradeCount: 0, windowStart: Date.now(), totalTrades: 0, totalWins: 0 };
        }
        return this._stats[botId];
    },
    
    getSpikeState(botId) {
        if (!this._spikeState[botId]) {
            this._spikeState[botId] = { spike: null, spikeId: null, traded: false, recordedAt: 0 };
        }
        return this._spikeState[botId];
    },
    
    recordSpike(botId, spike, tfSecs) {
        const spikeId = `${spike.time}_${spike.direction}`;
        this._spikeState[botId] = { spike, spikeId, traded: false, recordedAt: Date.now() };
    },
    
    hasTradedSpike(botId, spike) {
        const state = this._spikeState[botId];
        if (!state || !spike) return false;
        return state.spikeId === `${spike.time}_${spike.direction}` && state.traded === true;
    },
    
    markTraded(botId, spike) {
        const state = this._spikeState[botId];
        if (state && spike) state.traded = true;
    },
    
    inCooldown(botId) {
        const state = this._spikeState[botId];
        if (!state || !state.recordedAt) return false;
        return Date.now() - state.recordedAt < CONFIG.COOLDOWN_MINUTES * 60 * 1000;
    },
    
    isTooFrequent(botId) {
        const s = this._getStats(botId);
        const now = Date.now();
        if (now - s.windowStart > 3600000) {
            s.tradeCount = 0;
            s.windowStart = now;
        }
        return s.tradeCount >= CONFIG.MAX_TRADES_PER_HOUR;
    },
    
    recordTrade(botId) {
        const s = this._getStats(botId);
        s.tradeCount++;
    },
    
    recordOutcome(botId, outcome) {
        const s = this._getStats(botId);
        s.totalTrades++;
        if (outcome === 'TP') {
            s.consLosses = 0;
            s.totalWins++;
        } else {
            s.consLosses++;
        }
    },
    
    isHalted(botId) {
        return this._getStats(botId).consLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES;
    },
    
    checkEntry(symbol, m1Candles, m5Candles, m15Candles, botId) {
        const cfg = novaSymbolConfig(symbol);
        if (!cfg) return null;
        if (this.isHalted(botId)) return null;
        if (this.isTooFrequent(botId)) return null;
        if (this.inCooldown(botId)) return null;
        
        if (!m5Candles || m5Candles.length < 30) return null;
        
        const atr = _atr(m5Candles, 14);
        if (!atr) return null;
        
        const spike = _detectSpike(m5Candles, atr);
        if (!spike) return null;
        
        // Check direction matches instrument
        if (cfg.bias === 'BUY' && spike.direction !== 'down') return null;
        if (cfg.bias === 'SELL' && spike.direction !== 'up') return null;
        
        if (this.hasTradedSpike(botId, spike)) return null;
        
        // Wait for confirmation candle after spike
        const lastCandle = m5Candles[m5Candles.length - 2];
        const isConfirming = (cfg.bias === 'BUY' && lastCandle.close > lastCandle.open) ||
                             (cfg.bias === 'SELL' && lastCandle.close < lastCandle.open);
        
        if (!isConfirming) return null;
        
        this.markTraded(botId, spike);
        this.recordTrade(botId);
        
        // Calculate SL and TP based on spike
        const spikePrice = spike.direction === 'up' ? m5Candles[m5Candles.length - 2].high : m5Candles[m5Candles.length - 2].low;
        const spikeSize = spike.magnitude * atr;
        const slDistance = spikeSize * CONFIG.SL_BUFFER;
        const tpDistance = spikeSize * CONFIG.TP_RATIO;
        
        const confidence = Math.min(90, 50 + spike.magnitude * 8);
        
        if (confidence < CONFIG.MIN_CONFIDENCE) return null;
        
        console.log(`[NOVA] 💥 ${cfg.bias} on ${cfg.name} | Spike: ${spike.magnitude.toFixed(1)}x | Confidence: ${Math.round(confidence)}`);
        
        return {
            type: cfg.bias,
            label: `NOVA ${cfg.bias} [${spike.magnitude.toFixed(1)}x spike]`,
            score: confidence,
            factors: [`Spike ${spike.direction} ${spike.magnitude.toFixed(1)}x ATR`, `Confirmed`],
            tpMultiplier: tpDistance / atr,
            slMultiplier: slDistance / atr,
            isNova: true,
            _meta: { spikeMagnitude: spike.magnitude, spikePrice, confidence }
        };
    },
};