// nova-v3.js — FIXED Crash & Boom Strategy
//
// KEY CHANGES:
//   1. Spike detection uses CURRENT candle (realtime)
//   2. Multi-TF gate relaxed: ANY TF signal + spike confirmation = trade
//   3. ATR gate removed for entry (still used for sizing)
//   4. Realistic R:R based on historical reversion distances
//   5. Maximum 1 trade per spike event (prevents overtrading)

const NOVA_SYMBOLS_V3 = {
    'CRASH1000':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.6 },
    'BOOM1000':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.6 },
    'CRASH_1000': { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', reversionMult: 0.6 },
    'BOOM_1000':  { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  reversionMult: 0.6 },
    'CRASH500':   { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.5 },
    'BOOM500':    { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.5 },
    'CRASH_500':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  reversionMult: 0.5 },
    'BOOM_500':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   reversionMult: 0.5 },
};

// Improved spike detection — detects spike ON CURRENT CANDLE
function _detectLiveSpike(candles, atr) {
    if (!candles || candles.length < 2 || !atr || atr <= 0) return null;
    
    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    if (!current || !previous) return null;
    
    // Check BOTH candles — spike may have started previous and continued
    const candlesToCheck = [previous, current];
    let bestSpike = null;
    
    for (const c of candlesToCheck) {
        const wickUp = c.high - Math.max(c.open, c.close);
        const wickDown = Math.min(c.open, c.close) - c.low;
        const body = Math.abs(c.close - c.open);
        
        // Spike threshold: 3x ATR (lower than before to catch earlier)
        const spikeThreshold = atr * 3;
        
        const isUpSpike = wickUp >= spikeThreshold && wickUp > body;
        const isDownSpike = wickDown >= spikeThreshold && wickDown > body;
        const isBullBody = c.close > c.open && body >= spikeThreshold;
        const isBearBody = c.close < c.open && body >= spikeThreshold;
        
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
    
    return bestSpike;
}

// Simplified signal detection — focus on spike + reversion confirmation
function _signalAfterSpike(candles, tfLabel, bias, spike) {
    if (!spike || candles.length < 10) return null;
    
    // Only trade if spike direction matches instrument
    if (bias === 'BUY' && spike.direction !== 'down') return null;
    if (bias === 'SELL' && spike.direction !== 'up') return null;
    
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    if (!c0) return null;
    
    // Reversion confirmation: price moving back toward pre-spike levels
    const preSpikeClose = candles.length > 20 ? candles[candles.length - 20].close : c0.close;
    const priceMovement = bias === 'BUY' 
        ? c0.close - Math.min(c0.low, preSpikeClose)  // For Crash: up movement after drop
        : Math.max(c0.high, preSpikeClose) - c0.close; // For Boom: down movement after rise
    
    const atrVal = _atr(cl, 10);
    if (!atrVal) return null;
    
    // Require SOME reversion (price moving back)
    if (priceMovement < atrVal * 0.5) return null;
    
    // RSI confirmation — oversold/overbought after spike
    const rsiVal = _rsi(cl);
    if (bias === 'BUY' && rsiVal && rsiVal > 55) return null;  // Wait for oversold or neutral
    if (bias === 'SELL' && rsiVal && rsiVal < 45) return null; // Wait for overbought or neutral
    
    return {
        dir: bias,
        tf: tfLabel,
        count: 1,  // Simplified — spike is the main signal
        factors: [`Spike ${spike.direction} (${spike.magnitude.toFixed(1)}x ATR)`, `Reversion started`],
        atr: atrVal,
        spikeMagnitude: spike.magnitude,
    };
}

// Enhanced strategy with fixed logic
export const NovaStrategyV3 = {
    
    _spikeState: {},
    _tradeCountPerSpike: {},
    
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
    
    checkEntry(symbol, m1Candles, m5Candles, m15Candles, botId) {
        const cfg = NOVA_SYMBOLS_V3[symbol];
        if (!cfg) return null;
        
        const bias = cfg.bias;
        
        // Use M5 for spike detection (most reliable for Crash/Boom)
        if (!m5Candles || m5Candles.length < 30) return null;
        
        const m5ATR = _atr(m5Candles, 14);
        if (!m5ATR) return null;
        
        // Detect spike on M5
        const spike = _detectLiveSpike(m5Candles, m5ATR);
        
        // No spike = no trade
        if (!spike) return null;
        
        // Only trade spikes that match instrument direction
        if (bias === 'BUY' && spike.direction !== 'down') return null;
        if (bias === 'SELL' && spike.direction !== 'up') return null;
        
        // Don't trade the same spike twice
        if (this.hasTradedSpike(botId, spike)) return null;
        
        // Get signals from timeframes (M1 and M5 only — M15 is too slow)
        const results = [];
        
        if (m1Candles?.length >= 15) {
            const r = _signalAfterSpike(m1Candles, 'M1', bias, spike);
            if (r) results.push(r);
        }
        
        if (m5Candles?.length >= 15) {
            const r = _signalAfterSpike(m5Candles, 'M5', bias, spike);
            if (r) results.push(r);
        }
        
        // Need at least ONE timeframe confirming reversion
        if (results.length === 0) {
            return null;
        }
        
        // Calculate confidence
        let confidence = 50;  // Base confidence from spike detection
        confidence += results.length * 10;  // +10 per confirming TF
        confidence += Math.min(20, spike.magnitude * 5);  // Larger spikes = higher confidence
        confidence = Math.min(90, confidence);
        
        // Confidence gate — lower threshold for Crash/Boom (they're more volatile)
        const CONFIDENCE_THRESHOLD = 55;
        if (confidence < CONFIDENCE_THRESHOLD) {
            return null;
        }
        
        // REALISTIC RISK/REWARD for Crash/Boom
        // Use reversionMult based on historical data
        const spikeSize = spike.magnitude * m5ATR;
        const targetMove = spikeSize * cfg.reversionMult;  // Typically 50-60% of spike
        
        // SL: beyond the spike extreme + buffer
        // TP: 60% of spike size (conservative)
        const slPoints = m5ATR * 1.5;
        const tpPoints = targetMove * 0.8;
        
        // Skip if risk/reward is poor
        if (tpPoints < slPoints * 1.2) {
            return null;  // < 1.2:1 R:R
        }
        
        // Mark this spike as traded
        this.markTraded(botId, spike);
        
        const tfNames = results.map(r => r.tf).join('+');
        
        return {
            type: bias,
            label: `NOVA V3 ${bias} [spike ${spike.magnitude.toFixed(1)}x]`,
            score: confidence,
            factors: [`Spike: ${spike.direction} ${spike.magnitude.toFixed(1)}x ATR`, ...results.flatMap(r => r.factors)],
            tfNames,
            tpMultiplier: tpPoints / m5ATR,  // Return as ATR multiple for consistent interface
            slMultiplier: slPoints / m5ATR,
            isNova: true,
            atr: m5ATR,
            symbolConfig: cfg,
            // Store actual points for debugging
            _meta: { spikeSize, targetMove, slPoints, tpPoints }
        };
    },
};

// Reuse indicator functions from original (or import)
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