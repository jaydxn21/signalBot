// cipher.js — CIPHER v1  BTC Hybrid Strategy
//
// APPROACH: Structure + Trend
//   H4 bias first — EMA21 slope determines direction. No trades against it.
//   M5 entry — pullback to EMA zone + RSI recovery + body momentum trigger.
//   Volatility gate — skip consolidation (ATR < 40% of 20-bar average).
//   2:1 R:R minimum — breakeven WR = 33%. Wide margin for error.
//
// SYMBOLS: cryBTCUSD, BTCUSD (any BTC pair on Deriv)
// TIMEFRAME: M5 entry, H4 bias
// SESSIONS: 24/7 — self-filters via volatility regime gate

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
// H4 BIAS
// Returns 'BUY', 'SELL', or null (flat — no trade)
// Uses EMA21 on H4. Requires slope confirmation (last 3 bars).
// ─────────────────────────────────────────────────────────────
function _h4Bias(h4Candles) {
    if (!h4Candles || h4Candles.length < 25) return null;

    const ema21now  = _ema(h4Candles, 21);
    const ema21prev = _ema(h4Candles.slice(0, -3), 21);
    if (!ema21now || !ema21prev) return null;

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema21now - ema21prev;

    // Require both price position AND slope direction
    // Flat slope (< 0.1% of price) = no bias
    const flatThreshold = price * 0.001;
    if (Math.abs(slope) < flatThreshold) return null;

    if (price > ema21now && slope > 0) return 'BUY';
    if (price < ema21now && slope < 0) return 'SELL';
    return null; // price and slope disagree — skip
}

// ─────────────────────────────────────────────────────────────
// M5 ENTRY CONDITIONS
// ─────────────────────────────────────────────────────────────

// Pullback to EMA zone: price within 1×ATR of EMA8/EMA21 band
function _inEMAZone(candles, atr, bias) {
    const cl  = candles.slice(0, -1);
    const c0  = cl[cl.length - 1];
    const e8  = _ema(cl, 8);
    const e21 = _ema(cl, 21);
    if (!e8 || !e21) return false;

    const zoneTop    = Math.max(e8, e21) + atr * 0.3;
    const zoneBottom = Math.min(e8, e21) - atr * 0.3;

    if (bias === 'BUY')  return c0.low  <= zoneTop    && c0.close >= zoneBottom;
    if (bias === 'SELL') return c0.high >= zoneBottom  && c0.close <= zoneTop;
    return false;
}

// RSI in recovery zone — not overextended in entry direction
function _rsiOk(rsiVal, bias) {
    if (!rsiVal) return false;
    if (bias === 'BUY')  return rsiVal >= 35 && rsiVal <= 60;
    if (bias === 'SELL') return rsiVal >= 40 && rsiVal <= 65;
    return false;
}

// Trigger candle: body > 60% of range, closing in bias direction
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
// CIPHER STRATEGY
// ─────────────────────────────────────────────────────────────
export const CipherStrategy = {

    _stats: {}, // { [botId]: { consLosses, lastFiredMs, tradeCount, windowStart } }

    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = { consLosses: 0, lastFiredMs: 0, tradeCount: 0, windowStart: Date.now() };
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
        // Skip consolidation. ATR must be >= 40% of 20-bar average.
        const avgAtr = _atrAvg(m5Candles);
        if (avgAtr && atr < avgAtr * 0.4) return null;

        // ── H4 bias ───────────────────────────────────────────
        const bias = _h4Bias(h4Candles);
        if (!bias) return null;

        // ── RSI ───────────────────────────────────────────────
        const rsiVal = _rsi(m5Candles.slice(0, -1));
        if (!_rsiOk(rsiVal, bias)) return null;

        // ── Pullback to EMA zone ──────────────────────────────
        if (!_inEMAZone(m5Candles, atr, bias)) return null;

        // ── Trigger candle ────────────────────────────────────
        if (!_triggerCandle(m5Candles, bias)) return null;

        const score = 70
            + (rsiVal && bias === 'BUY'  && rsiVal < 50 ? 10 : 0)
            + (rsiVal && bias === 'SELL' && rsiVal > 50 ? 10 : 0);

        return {
            type:         bias,
            label:        `CIPHER ${bias} [H4+M5 ${score}]`,
            score,
            factors:      [
                `H4 bias ${bias}`,
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