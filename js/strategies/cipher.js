// cipher.js — CIPHER v2 Enhanced — BTC Hybrid Strategy
//
// IMPROVEMENTS over v1:
//   1. H4+M5 multi-TF alignment — both must agree for high confidence
//   2. Confidence gating — signals generate but only trade if score ≥ 65
//   3. Rejected signal logging — tracks bad signals for tuning
//   4. Stricter H4 bias — requires EMA21 slope to be consistent
//   5. M5 entry now requires H4 direction agreement
//
// SYMBOLS: cryBTCUSD, BTCUSD (any BTC pair on Deriv)
// TIMEFRAME: M5 entry, H4 bias
// SESSIONS: 24/7 — self-filters via volatility regime gate
// CONFIDENCE GATE: ≥ 65 to execute (tune down to 60 if needing 20-30/day)

const CIPHER_SYMBOLS = ['cryBTCUSD', 'BTCUSD'];

export function isCipherSymbol(symbol) {
    return CIPHER_SYMBOLS.includes(symbol);
}

// ─────────────────────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────────────────────
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let v = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) v = candles[i].close * k + v * (1 - k);
    return v;
}

function _atr(candles, period = 10) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = candles.length - period - 1; i < candles.length; i++) {
        if (i === 0) continue;
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
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

// Average ATR over last N bars — volatility regime gate
function _atrAvg(candles, period = 10, lookback = 20) {
    if (candles.length < period + lookback + 1) return null;
    const atrs = [];
    for (let i = lookback; i >= 1; i--) {
        const a = _atr(candles.slice(0, candles.length - i), period);
        if (a) atrs.push(a);
    }
    return atrs.length ? atrs.reduce((a, b) => a + b) / atrs.length : null;
}

// ─────────────────────────────────────────────────────────────
// H4 BIAS — ENHANCED: Requires slope + price alignment
// Returns { bias: 'BUY'|'SELL'|null, strength: 0-100 }
// ─────────────────────────────────────────────────────────────
function _h4BiasEnhanced(h4Candles) {
    if (!h4Candles || h4Candles.length < 25) return { bias: null, strength: 0 };

    const ema21now  = _ema(h4Candles, 21);
    const ema21prev = _ema(h4Candles.slice(0, -5), 21);
    if (!ema21now || !ema21prev) return { bias: null, strength: 0 };

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema21now - ema21prev;

    // Require both price position AND slope direction (stricter)
    const flatThreshold = price * 0.002;
    if (Math.abs(slope) < flatThreshold) return { bias: null, strength: 0 };

    // Strength metric: how aligned is price + slope?
    let strength = 50;
    const distToEMA = Math.abs(price - ema21now);
    const emaPercent = distToEMA / price;
    
    if (emaPercent < 0.002) strength += 25; // very close to EMA
    else if (emaPercent < 0.005) strength += 15;
    
    const slopeStrength = Math.abs(slope) / price;
    if (slopeStrength > 0.003) strength += 10;

    if (price > ema21now && slope > 0) return { bias: 'BUY', strength: Math.min(100, strength) };
    if (price < ema21now && slope < 0) return { bias: 'SELL', strength: Math.min(100, strength) };
    
    return { bias: null, strength: 0 }; // price and slope disagree
}

// ─────────────────────────────────────────────────────────────
// M5 ENTRY CONDITIONS
// ─────────────────────────────────────────────────────────────

function _inEMAZone(candles, atr, bias) {
    const cl  = candles.slice(0, -1);
    const c0  = cl[cl.length - 1];
    const e8  = _ema(cl, 8);
    const e21 = _ema(cl, 21);
    if (!e8 || !e21) return false;

    const zoneTop    = Math.max(e8, e21) + atr * 0.3;
    const zoneBottom = Math.min(e8, e21) - atr * 0.3;

    if (bias === 'BUY')  return c0.low  <= zoneTop    && c0.close >= zoneBottom;
    if (bias === 'SELL') return c0.high >= zoneBottom && c0.close <= zoneTop;
    return false;
}

function _rsiOk(rsiVal, bias) {
    if (!rsiVal) return false;
    if (bias === 'BUY')  return rsiVal >= 35 && rsiVal <= 60;
    if (bias === 'SELL') return rsiVal >= 40 && rsiVal <= 65;
    return false;
}

function _triggerCandle(candles, bias) {
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    if (!c0 || !c1) return false;

    const range = c0.high - c0.low;
    if (range === 0) return false;
    const body = Math.abs(c0.close - c0.open);
    if (body / range < 0.6) return false;

    if (bias === 'BUY')  return c0.close > c0.open && c0.close > c1.high;
    if (bias === 'SELL') return c0.close < c0.open && c0.close < c1.low;
    return false;
}

// ─────────────────────────────────────────────────────────────
// CIPHER STRATEGY — ENHANCED WITH CONFIDENCE GATING
// ─────────────────────────────────────────────────────────────
export const CipherStrategy = {

    _stats: {}, // { [botId]: { consLosses, lastFiredMs, tradeCount, windowStart, rejectedSignals } }

    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = {
                consLosses: 0,
                lastFiredMs: 0,
                tradeCount: 0,
                windowStart: Date.now(),
                rejectedSignals: [],
            };
        }
        return this._stats[botId];
    },

    recordOutcome(botId, outcome) {
        const s = this._getStats(botId);
        if (outcome === 'TP') s.consLosses = 0;
        else s.consLosses++;
    },

    isHalted(botId) {
        return this._getStats(botId).consLosses >= 5;
    },

    // Max 4 trades per hour — rate limit for volatile conditions
    isTooFrequent(botId) {
        const s   = this._getStats(botId);
        const now = Date.now();
        if (now - s.windowStart > 3600000) {
            s.tradeCount  = 0;
            s.windowStart = now;
        }
        return s.tradeCount >= 4;
    },

    recordTrade(botId) {
        const s = this._getStats(botId);
        s.tradeCount++;
        s.lastFiredMs = Date.now();
    },

    // Log a rejected signal for analysis
    logRejectedSignal(botId, confidence, reason) {
        const s = this._getStats(botId);
        s.rejectedSignals.push({
            time: Date.now(),
            score: confidence,
            reason,
        });
        // Keep last 100 rejected signals
        if (s.rejectedSignals.length > 100) s.rejectedSignals.shift();
    },

    checkEntry(m5Candles, h4Candles, atr, botId) {
        if (!m5Candles || m5Candles.length < 25 || !atr) return null;
        if (this.isHalted(botId))      return null;
        if (this.isTooFrequent(botId)) return null;

        // ── 3-candle cooldown between entries ─────────────────
        const s          = this._getStats(botId);
        const tfSecs     = 300; // M5
        const cooldownMs = tfSecs * 3 * 1000;
        if (Date.now() - s.lastFiredMs < cooldownMs) return null;

        // ── Volatility regime gate ────────────────────────────
        const avgAtr = _atrAvg(m5Candles);
        if (avgAtr && atr < avgAtr * 0.4) return null;

        // ── H4 bias with strength ─────────────────────────────
        const h4result = _h4BiasEnhanced(h4Candles);
        const bias = h4result.bias;
        const h4Strength = h4result.strength;
        if (!bias) return null; // No H4 bias = no trade

        // ── RSI ───────────────────────────────────────────────
        const rsiVal = _rsi(m5Candles.slice(0, -1));
        if (!_rsiOk(rsiVal, bias)) return null;

        // ── Pullback to EMA zone ──────────────────────────────
        if (!_inEMAZone(m5Candles, atr, bias)) return null;

        // ── Trigger candle ────────────────────────────────────
        if (!_triggerCandle(m5Candles, bias)) return null;

        // ── CONFIDENCE CALCULATION ────────────────────────────
        // Base: 50 + H4 strength + M5 confluence
        let confidence = 50 + (h4Strength / 100) * 25; // H4 can add up to 25
        
        // M5 confluence
        if (rsiVal && bias === 'BUY'  && rsiVal < 50) confidence += 10;
        if (rsiVal && bias === 'SELL' && rsiVal > 50) confidence += 10;
        confidence = Math.min(100, confidence);

        // ── CONFIDENCE GATE — Only trade if score ≥ 65 ────────
        // Tune this threshold:
        //   65 = strict, fewer trades but higher quality
        //   60 = balanced, ~20-30 trades/day
        //   55 = loose, more trades but lower quality
        const CONFIDENCE_THRESHOLD = 65;
        
        if (confidence < CONFIDENCE_THRESHOLD) {
            // Signal generated but rejected due to low confidence
            this.logRejectedSignal(botId, confidence, 'confidence gate');
            return null; // Do NOT trade
        }

        return {
            type:         bias,
            label:        `CIPHER ${bias} [H4+M5 ${Math.round(confidence)}]`,
            score:        Math.round(confidence),
            factors:      [
                `H4 bias ${bias} (str ${h4Strength.toFixed(0)})`,
                `EMA zone pullback`,
                `RSI ${rsiVal?.toFixed(0)}`,
                `Trigger candle`,
            ],
            tpMultiplier: 2.0,
            slMultiplier: 1.0,
            isCipher:     true,
        };
    },
};