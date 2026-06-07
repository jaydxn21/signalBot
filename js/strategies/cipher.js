// cipher.js — CIPHER BTC Strategy with Structure Integration
// v2.1 INTRADAY FIXES:
//   - H4 bias slope threshold loosened: 0.0006 → 0.0003 (BTC intraday moves fast)
//   - H4 distance filter loosened: 0.001 → 0.0005
//   - dailyCandles/weeklyCandles now OPTIONAL — strategy fires on M5+H4 alone
//   - Structure score gating relaxed when daily/weekly unavailable (falls back to
//     EMA zone + price position scoring from M5 data only)
//   - RSI confirmation relaxed for intraday: BUY < 52 (was 45), SELL > 48 (was 55)
//   - MIN_PULLBACK_DEPTH lowered to 0.3 (was 0.4) — BTC intraday pullbacks are shallower
//   - MAX_TRADES_PER_HOUR raised to 3 (was 2) to capture intraday momentum sequences
//   - COOLDOWN_CANDLES lowered to 1 (was 2) — M5 moves fast
//   - Added _buildInternalStructure() to derive S/R levels from M5 candles alone
//     when daily/weekly are absent — uses swing highs/lows over 50-candle lookback
//   - isCipherSymbol() updated to include common BTC variants

import { StructureEngine } from '../structure-engine.js';

const CIPHER_SYMBOLS = [
    'cryBTCUSD',
    'BTCUSD',
    'BTC/USD',
    'BTCUSDT',
    'Bitcoin',
];

const CONFIG = {
    MIN_ATR_VALUE:          50.0,  // BTC: was 5.0 (appropriate for BTC price scale)
    MAX_TRADES_PER_HOUR:    3,     // was 2
    COOLDOWN_CANDLES:       1,     // was 2 — M5 intraday needs faster cadence
    MAX_CONSECUTIVE_LOSSES: 6,
    MIN_PULLBACK_DEPTH:     0.3,   // was 0.4 — BTC intraday pullbacks shallower
    MIN_STRUCTURE_SCORE:    45,    // was 50 — relaxed for intraday-only mode
    MIN_RR:                 1.2,
    // When no daily/weekly data available, use internal M5 structure only
    INTERNAL_SWING_LOOKBACK: 50,
};

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

// ─────────────────────────────────────────────────────────────
// INTERNAL STRUCTURE (M5 swing highs/lows — used when no daily/weekly data)
// ─────────────────────────────────────────────────────────────
function _buildInternalStructure(candles, atr) {
    const lookback = Math.min(CONFIG.INTERNAL_SWING_LOOKBACK, candles.length - 1);
    const slice = candles.slice(-lookback);

    let swingHighs = [];
    let swingLows  = [];

    // Detect pivot highs/lows (simple 3-bar pivot)
    for (let i = 1; i < slice.length - 1; i++) {
        if (slice[i].high > slice[i-1].high && slice[i].high > slice[i+1].high) {
            swingHighs.push(slice[i].high);
        }
        if (slice[i].low < slice[i-1].low && slice[i].low < slice[i+1].low) {
            swingLows.push(slice[i].low);
        }
    }

    // Sort descending for highs, ascending for lows
    swingHighs.sort((a, b) => b - a);
    swingLows.sort((a, b) => a - b);

    const price = candles[candles.length - 1].close;

    // Nearest resistance above and support below
    const nearestResistance = swingHighs.find(h => h > price) || price + atr * 3;
    const nearestSupport    = swingLows.find(l => l < price)  || price - atr * 3;

    // Cluster swing highs/lows into supply/demand zones (within 0.5 ATR of each other)
    const supplyZones  = _clusterLevels(swingHighs.filter(h => h > price), atr);
    const demandZones  = _clusterLevels(swingLows.filter(l => l < price), atr);

    return {
        nearestResistance,
        nearestSupport,
        supplyZones:  supplyZones.map(z => ({ low: z - atr * 0.3, high: z + atr * 0.3 })),
        demandZones:  demandZones.map(z => ({ low: z - atr * 0.3, high: z + atr * 0.3 })),
        priceRange:   nearestResistance - nearestSupport,
    };
}

function _clusterLevels(levels, atr) {
    if (!levels.length) return [];
    const clusters = [];
    let current = [levels[0]];

    for (let i = 1; i < levels.length; i++) {
        if (Math.abs(levels[i] - current[current.length - 1]) < atr * 0.5) {
            current.push(levels[i]);
        } else {
            clusters.push(current.reduce((a, b) => a + b, 0) / current.length);
            current = [levels[i]];
        }
    }
    if (current.length) clusters.push(current.reduce((a, b) => a + b, 0) / current.length);
    return clusters;
}

// Score how well price position matches bias, using internal structure
function _internalStructureScore(internalStruct, price, bias, atr) {
    const { nearestResistance, nearestSupport, priceRange } = internalStruct;
    const distToSupport    = price - nearestSupport;
    const distToResistance = nearestResistance - price;

    if (bias === 'BUY') {
        // Good score when close to support and far from resistance
        const proxScore = Math.max(0, 1 - distToSupport / (atr * 3)) * 60;
        const roomScore = Math.min(40, (distToResistance / (atr * 2)) * 40);
        return Math.round(proxScore + roomScore);
    } else {
        const proxScore = Math.max(0, 1 - distToResistance / (atr * 3)) * 60;
        const roomScore = Math.min(40, (distToSupport / (atr * 2)) * 40);
        return Math.round(proxScore + roomScore);
    }
}

// ─────────────────────────────────────────────────────────────
// H4 BIAS
// FIX v2.1: Loosened slope threshold for intraday BTC trading.
// Old 0.0006 slope threshold was too strict — BTC H4 EMAs move fast
// and a tight threshold caused zero signals during active sessions.
// ─────────────────────────────────────────────────────────────
function _h4Bias(h4Candles) {
    if (!h4Candles || h4Candles.length < 20) return null; // was 25

    const ema10now  = _ema(h4Candles, 10);
    const ema10prev = _ema(h4Candles.slice(0, -3), 10);
    if (!ema10now || !ema10prev) return null;

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema10now - ema10prev;
    const slopePct = slope / price;

    // FIX: 0.0003 (was 0.0006) — catches intraday momentum earlier
    if (Math.abs(slopePct) < 0.0003) return null;

    // FIX: 0.0005 (was 0.001) — BTC intraday price hugs EMA more than daily
    const distPct = Math.abs(price - ema10now) / price;
    if (distPct < 0.0005) return null;

    if (price > ema10now && slope > 0) return 'BUY';
    if (price < ema10now && slope < 0) return 'SELL';
    return null;
}

// ─────────────────────────────────────────────────────────────
// PULLBACK TO EMA ZONE
// ─────────────────────────────────────────────────────────────
function _pullbackDepth(candles, atr, bias) {
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const e8  = _ema(cl, 8);
    const e21 = _ema(cl, 21);
    if (!e8 || !e21) return 0;

    const zoneMid = (e8 + e21) / 2;

    if (bias === 'BUY') {
        return (zoneMid - c0.low) / atr;
    }
    return (c0.high - zoneMid) / atr;
}

function _triggerCandle(candles, bias) {
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    if (!c0 || !c1) return false;

    const range = c0.high - c0.low;
    if (range === 0) return false;
    const body = Math.abs(c0.close - c0.open);
    if (body / range < 0.65) return false;

    if (bias === 'BUY') {
        return c0.close > c0.open && c0.close > c1.high;
    }
    return c0.close < c0.open && c0.close < c1.low;
}

// ─────────────────────────────────────────────────────────────
// CIPHER STRATEGY WITH STRUCTURE
// ─────────────────────────────────────────────────────────────
export const CipherStrategy = {

    _stats: {},

    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = {
                consLosses:  0,
                lastFiredMs: 0,
                tradeCount:  0,
                windowStart: Date.now(),
                totalTrades: 0,
                totalWins:   0,
            };
        }
        return this._stats[botId];
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
        s.lastFiredMs = Date.now();
    },

    // ─────────────────────────────────────────────────────────
    // MAIN ENTRY
    // FIX v2.1: dailyCandles and weeklyCandles are now truly optional.
    // When absent, the strategy derives structure from M5 swing highs/lows.
    // This allows intraday-only deployments to fire signals without needing
    // a separate daily/weekly data feed connected to the signal bot.
    // ─────────────────────────────────────────────────────────
    checkEntry(m5Candles, h4Candles, atr, botId, dailyCandles = [], weeklyCandles = []) {
        if (!m5Candles || m5Candles.length < 50 || !atr) return null;
        if (this.isHalted(botId)) return null;
        if (this.isTooFrequent(botId)) return null;
        if (atr < CONFIG.MIN_ATR_VALUE) return null;

        // Cooldown
        const s = this._getStats(botId);
        const cooldownMs = CONFIG.COOLDOWN_CANDLES * 300 * 1000; // COOLDOWN_CANDLES M5 bars
        if (Date.now() - s.lastFiredMs < cooldownMs) return null;

        // ── H4 BIAS ────────────────────────────────────────────
        const bias = _h4Bias(h4Candles);
        if (!bias) return null;

        const price = m5Candles[m5Candles.length - 1].close;
        let structureScore, position, sl, tp, risk, reward;

        // ── STRUCTURE — DAILY/WEEKLY MODE (preferred) ─────────
        const hasDailyData = dailyCandles && dailyCandles.length >= 5;

        if (hasDailyData) {
            // Full structure engine path (original behaviour)
            const structureMap = StructureEngine.getStructureMap(m5Candles, dailyCandles, weeklyCandles);
            if (!structureMap.dailyLevels) return null;

            structureScore = structureMap.getStructureScore(price, bias);
            position       = structureMap.getPricePosition(price);

            if (bias === 'BUY'  && position !== 'SUPPORT'    && position !== 'BREAKOUT_UP')   return null;
            if (bias === 'SELL' && position !== 'RESISTANCE' && position !== 'BREAKOUT_DOWN') return null;

            if (structureScore < CONFIG.MIN_STRUCTURE_SCORE) return null;

            // SL/TP from daily structure
            if (bias === 'BUY') {
                let supportLevel = structureMap.dailyLevels.dailyLow;
                if (structureMap.demandZones.length > 0)
                    supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
                sl = supportLevel * 0.998;

                let resistanceLevel = structureMap.dailyLevels.dailyMid;
                if (structureMap.supplyZones.length > 0)
                    resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
                tp = resistanceLevel;
            } else {
                let resistanceLevel = structureMap.dailyLevels.dailyHigh;
                if (structureMap.supplyZones.length > 0)
                    resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
                sl = resistanceLevel * 1.002;

                let supportLevel = structureMap.dailyLevels.dailyMid;
                if (structureMap.demandZones.length > 0)
                    supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
                tp = supportLevel;
            }

        } else {
            // ── INTRADAY-ONLY MODE — derive structure from M5 swings ──
            const internal = _buildInternalStructure(m5Candles, atr);

            structureScore = _internalStructureScore(internal, price, bias, atr);
            position       = bias === 'BUY' ? 'NEAR_SUPPORT' : 'NEAR_RESISTANCE';

            if (structureScore < CONFIG.MIN_STRUCTURE_SCORE) {
                console.log(`[CIPHER] Intraday structure score too low: ${structureScore} — skipping`);
                return null;
            }

            // SL/TP from internal swing structure
            if (bias === 'BUY') {
                sl = internal.nearestSupport * 0.998;
                // TP: nearest internal resistance, or atr-based minimum
                const tpCandidate = internal.supplyZones.length > 0
                    ? internal.supplyZones[0].low
                    : price + atr * 3;
                tp = Math.max(tpCandidate, price + atr * 2);
            } else {
                sl = internal.nearestResistance * 1.002;
                const tpCandidate = internal.demandZones.length > 0
                    ? internal.demandZones[0].high
                    : price - atr * 3;
                tp = Math.min(tpCandidate, price - atr * 2);
            }
        }

        risk   = Math.abs(price - sl);
        reward = Math.abs(tp - price);

        // Guard: risk or reward of zero means structure is broken
        if (!risk || !reward || risk === 0) return null;

        const rr = reward / risk;
        if (rr < CONFIG.MIN_RR) return null;

        // ── PULLBACK TO EMA ZONE ───────────────────────────────
        const pullbackDepth = _pullbackDepth(m5Candles, atr, bias);
        if (pullbackDepth < CONFIG.MIN_PULLBACK_DEPTH) return null;

        // ── TRIGGER CANDLE ─────────────────────────────────────
        if (!_triggerCandle(m5Candles, bias)) return null;

        // ── RSI CONFIRMATION ───────────────────────────────────
        // FIX v2.1: Relaxed for intraday — BTC M5 RSI mid-range is 45–55, not <45/<55
        const rsiVal = _rsi(m5Candles.slice(0, -1));
        if (bias === 'BUY'  && rsiVal && rsiVal > 52) return null; // was > 45
        if (bias === 'SELL' && rsiVal && rsiVal < 48) return null; // was < 55

        // ── RECORD AND RETURN ──────────────────────────────────
        this.recordTrade(botId);

        const mode    = hasDailyData ? 'FULL' : 'INTRADAY';
        const factors = [
            `H4 bias ${bias}`,
            `${position} (score ${structureScore}) [${mode}]`,
            `Pullback ${pullbackDepth.toFixed(1)}x ATR`,
            rsiVal ? `RSI ${rsiVal.toFixed(0)}` : 'RSI n/a',
            `R:R ${rr.toFixed(1)}:1`,
        ];

        console.log(`[CIPHER] ✅ ${bias} on BTC | ${factors.join(' · ')}`);

        return {
            type:           bias,
            label:          `CIPHER ${bias} [${position}] [${mode}]`,
            score:          structureScore,
            factors:        factors,
            tpMultiplier:   reward / atr,
            slMultiplier:   risk / atr,
            isCipher:       true,
            _meta: {
                position,
                structureScore,
                pullbackDepth,
                rr,
                sl,
                tp,
                price,
                rsi:  rsiVal,
                mode,
            },
        };
    },
};

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
export function isCipherSymbol(symbol) {
    return CIPHER_SYMBOLS.some(s => s.toLowerCase() === (symbol || '').toLowerCase());
}