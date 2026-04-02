// nova-v3.js — FIXED Crash & Boom Strategy
//
// UPDATED: Fixed 11% win rate issue
//   - Much stricter spike detection
//   - Higher confidence threshold
//   - Better R:R calculation (1:1.5 emergency mode)
//   - Win rate gate added
//   - Tighter reversion confirmation
//
// SYMBOLS: CRASH1000, BOOM1000, CRASH500, BOOM500

const NOVA_SYMBOLS_V3 = {
    'CRASH1000':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.5 },  // Reduced from 0.6
    'BOOM1000':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.5 },
    'CRASH_1000': { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.5 },
    'BOOM_1000':  { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.5 },
    'CRASH500':   { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.4 },
    'BOOM500':    { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.4 },
    'CRASH_500':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.4 },
    'BOOM_500':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.4 },
};

// Emergency mode configuration
const EMERGENCY_CONFIG = {
    enabled: true,  // Set to false after win rate improves
    forceRR: 1.5,   // Force 1:1.5 R:R
    minSpikeMagnitude: 4.5,  // Minimum 4.5x ATR spike (was 3x)
    minConfidence: 75,       // Much higher threshold
    maxTradesPerHour: 1,
    cooldownMinutes: 20,
    minWinRatePercent: 15
};

// ─────────────────────────────────────────────────────────────
// EXPORTED SYMBOL CONFIG FUNCTION
// ─────────────────────────────────────────────────────────────
export function novaSymbolConfig(symbol) {
    return NOVA_SYMBOLS_V3[symbol] || null;
}

// ─────────────────────────────────────────────────────────────
// EXPORTED SPIKE DETECTION
// ─────────────────────────────────────────────────────────────
export function detectSpike(candles, atr) {
    return _detectLiveSpike(candles, atr);
}

// Improved spike detection — MUCH STRICTER
function _detectLiveSpike(candles, atr) {
    if (!candles || candles.length < 2 || !atr || atr <= 0) return null;
    
    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    if (!current || !previous) return null;
    
    const candlesToCheck = [previous, current];
    let bestSpike = null;
    
    // Use higher threshold in emergency mode
    const spikeMultiplier = EMERGENCY_CONFIG.enabled ? 4.5 : 3.5;
    const spikeThreshold = atr * spikeMultiplier;
    
    for (const c of candlesToCheck) {
        const wickUp = c.high - Math.max(c.open, c.close);
        const wickDown = Math.min(c.open, c.close) - c.low;
        const body = Math.abs(c.close - c.open);
        
        const isUpSpike = wickUp >= spikeThreshold && wickUp > body * 1.5;
        const isDownSpike = wickDown >= spikeThreshold && wickDown > body * 1.5;
        const isBullBody = c.close > c.open && body >= spikeThreshold && body > wickUp * 1.5;
        const isBearBody = c.close < c.open && body >= spikeThreshold && body > wickDown * 1.5;
        
        if (isUpSpike || isBullBody) {
            const magnitude = (isBullBody ? body : wickUp) / atr;
            if (!bestSpike || magnitude > bestSpike.magnitude) {
                bestSpike = { direction: 'up', magnitude, time: c.time, candleAge: c === current ? 'live' : 'previous' };
            }
        }
        if (isDownSpike || isBearBody) {
            const magnitude = (isBearBody ? body : wickDown) / atr;
            if (!bestSpike || magnitude > bestSpike.magnitude) {
                bestSpike = { direction: 'down', magnitude, time: c.time, candleAge: c === current ? 'live' : 'previous' };
            }
        }
    }
    
    // Minimum magnitude check
    if (bestSpike && bestSpike.magnitude < spikeMultiplier) return null;
    
    return bestSpike;
}

// STRICTER signal detection
function _signalAfterSpike(candles, tfLabel, bias, spike) {
    if (!spike || candles.length < 15) return null;  // Increased from 10
    
    if (bias === 'BUY' && spike.direction !== 'down') return null;
    if (bias === 'SELL' && spike.direction !== 'up') return null;
    
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    if (!c0 || !c1) return null;
    
    // Require reversion to have started (price moving back)
    const preSpikeClose = candles.length > 30 ? candles[candles.length - 30].close : c0.close;
    let priceMovement = 0;
    
    if (bias === 'BUY') {
        priceMovement = c0.close - Math.min(c0.low, preSpikeClose);
    } else {
        priceMovement = Math.max(c0.high, preSpikeClose) - c0.close;
    }
    
    const atrVal = _atr(cl, 10);
    if (!atrVal) return null;
    
    // Require stronger reversion (0.8x ATR instead of 0.5x)
    if (priceMovement < atrVal * 0.8) return null;
    
    // RSI confirmation — TIGHTER ranges
    const rsiVal = _rsi(cl);
    if (bias === 'BUY' && rsiVal && rsiVal > 45) return null;  // Was 55
    if (bias === 'SELL' && rsiVal && rsiVal < 55) return null; // Was 45
    
    // Additional: require a bullish/bearish candle for confirmation
    const isConfirmingCandle = (bias === 'BUY' && c0.close > c0.open && c0.close > c1.high) ||
                                (bias === 'SELL' && c0.close < c0.open && c0.close < c1.low);
    if (!isConfirmingCandle) return null;
    
    return {
        dir: bias,
        tf: tfLabel,
        count: 1,
        factors: [`Spike ${spike.direction} (${spike.magnitude.toFixed(1)}x ATR)`, `Reversion confirmed`, `RSI ${rsiVal?.toFixed(0)}`],
        atr: atrVal,
        spikeMagnitude: spike.magnitude,
        rsiValue: rsiVal
    };
}

// ─────────────────────────────────────────────────────────────
// INDICATOR FUNCTIONS
// ─────────────────────────────────────────────────────────────
function _atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _rsi(candles, period = 14) {
    if (candles.length < period + 2) return null;
    const cl = candles.slice(-period - 1).map(c => c.close);
    let g = 0, l = 0;
    for (let i = 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ─────────────────────────────────────────────────────────────
// NOVA STRATEGY V3 — FIXED
// ─────────────────────────────────────────────────────────────
export const NovaStrategyV3 = {
    
    _spikeState: {},
    _stats: {},
    
    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = {
                totalTrades: 0,
                totalWins: 0,
                consLosses: 0,
                lastFiredMs: 0,
                tradeCount: 0,
                windowStart: Date.now()
            };
        }
        return this._stats[botId];
    },
    
    getSpikeState(botId) {
        if (!this._spikeState[botId]) {
            this._spikeState[botId] = { spike: null, spikeId: null, traded: false };
        }
        return this._spikeState[botId];
    },
    
    _getSpikeId(spike) {
        if (!spike || !spike.time) return null;
        return `${spike.time}_${spike.direction}`;
    },
    
    recordSpike(botId, spike) {
        const spikeId = this._getSpikeId(spike);
        this._spikeState[botId] = {
            spike,
            spikeId,
            traded: false,
            recordedAt: Date.now(),
        };
    },
    
    hasTradedSpike(botId, spike) {
        const state = this._spikeState[botId];
        if (!state || !spike) return false;
        return state.spikeId === this._getSpikeId(spike) && state.traded === true;
    },
    
    markTraded(botId, spike) {
        const state = this._spikeState[botId];
        if (state && spike) {
            state.traded = true;
        }
    },
    
    inCooldown(botId) {
        const state = this._spikeState[botId];
        if (!state || !state.recordedAt) return false;
        const cooldownMs = EMERGENCY_CONFIG.cooldownMinutes * 60 * 1000;
        return Date.now() - state.recordedAt < cooldownMs;
    },
    
    isHalted(botId) {
        return this._getStats(botId).consLosses >= 4;  // Stricter: halt after 4 losses
    },
    
    isTooFrequent(botId) {
        const s = this._getStats(botId);
        const now = Date.now();
        if (now - s.windowStart > 3600000) {
            s.tradeCount = 0;
            s.windowStart = now;
        }
        return s.tradeCount >= EMERGENCY_CONFIG.maxTradesPerHour;
    },
    
    isWinRateTooLow(botId) {
        const s = this._getStats(botId);
        if (s.totalTrades < 20) return false;
        const winRate = (s.totalWins / s.totalTrades) * 100;
        if (winRate < EMERGENCY_CONFIG.minWinRatePercent) {
            console.log(`[NOVA] HALTED: Win rate ${winRate.toFixed(1)}% below ${EMERGENCY_CONFIG.minWinRatePercent}%`);
            return true;
        }
        return false;
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
    
    recordTrade(botId) {
        const s = this._getStats(botId);
        s.tradeCount++;
        s.lastFiredMs = Date.now();
    },
    
    checkEntry(symbol, m1Candles, m5Candles, m15Candles, botId) {
        const cfg = novaSymbolConfig(symbol);
        if (!cfg) return null;
        
        const stats = this._getStats(botId);
        if (this.isHalted(botId)) {
            console.log(`[NOVA] Bot ${botId} halted after ${stats.consLosses} losses`);
            return null;
        }
        if (this.isWinRateTooLow(botId)) return null;
        if (this.isTooFrequent(botId)) return null;
        
        const bias = cfg.bias;
        
        if (!m5Candles || m5Candles.length < 30) return null;
        
        const m5ATR = _atr(m5Candles, 14);
        if (!m5ATR) return null;
        
        const spike = _detectLiveSpike(m5Candles, m5ATR);
        if (!spike) return null;
        
        if (bias === 'BUY' && spike.direction !== 'down') return null;
        if (bias === 'SELL' && spike.direction !== 'up') return null;
        
        if (this.hasTradedSpike(botId, spike)) return null;
        if (this.inCooldown(botId)) return null;
        
        const results = [];
        
        if (m1Candles?.length >= 15) {
            const r = _signalAfterSpike(m1Candles, 'M1', bias, spike);
            if (r) results.push(r);
        }
        
        if (m5Candles?.length >= 15) {
            const r = _signalAfterSpike(m5Candles, 'M5', bias, spike);
            if (r) results.push(r);
        }
        
        // Need at least ONE timeframe confirming
        if (results.length === 0) return null;
        
        // Calculate confidence — MUCH STRICTER
        let confidence = 40;  // Lower base
        confidence += results.length * 15;  // +15 per TF
        confidence += Math.min(25, spike.magnitude * 4);  // Higher weight for magnitude
        confidence = Math.min(100, confidence);
        
        const minConfidence = EMERGENCY_CONFIG.enabled ? EMERGENCY_CONFIG.minConfidence : 60;
        if (confidence < minConfidence) return null;
        
        this.markTraded(botId, spike);
        this.recordTrade(botId);
        
        let tpMult, slMult, rrLabel;
        
        if (EMERGENCY_CONFIG.enabled) {
            // Force 1:1.5 R:R in emergency mode
            tpMult = 1.5;
            slMult = 1.0;
            rrLabel = '1:1.5';
        } else {
            // Normal calculation
            const spikeSize = spike.magnitude * m5ATR;
            const targetMove = spikeSize * cfg.reversionMult;
            const slPoints = m5ATR * 1.2;
            const tpPoints = targetMove * 0.7;
            
            tpMult = tpPoints / m5ATR;
            slMult = slPoints / m5ATR;
            rrLabel = `${tpMult.toFixed(1)}:1`;
        }
        
        const tfNames = results.map(r => r.tf).join('+');
        const rsiVal = results[0]?.rsiValue || '?';
        
        console.log(`[NOVA] ✅ SIGNAL ${bias} on ${symbol} | Spike: ${spike.magnitude.toFixed(1)}x | RSI: ${rsiVal} | ${rrLabel} R:R | Confidence: ${Math.round(confidence)}`);
        
        return {
            type: bias,
            label: `NOVA ${bias} [${rrLabel}]`,
            score: confidence,
            factors: [`Spike: ${spike.direction} ${spike.magnitude.toFixed(1)}x ATR`, ...results.flatMap(r => r.factors)],
            tfNames,
            tfCount: results.length,
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isNova: true,
            atr: m5ATR,
            symbolConfig: cfg,
            _meta: { spikeMagnitude: spike.magnitude, confidence, rsi: rsiVal }
        };
    },
};

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
export const NovaStrategy = NovaStrategyV3;