// cipher.js — CIPHER BTC Strategy with Structure Integration
//
// ENTRY RULES:
//   - H4 trend bias (EMA10 slope)
//   - MUST be at demand zone for BUY, or supply zone for SELL
//   - Pullback to EMA zone
//   - Trigger candle confirmation
//
// EXIT RULES:
//   - TP at nearest supply/demand zone
//   - Dynamic R:R based on distance to next level

import { StructureEngine } from '../structure-engine.js';

const CIPHER_SYMBOLS = ['cryBTCUSD', 'BTCUSD'];

// ─────────────────────────────────────────────────────────────
// SINGLE EXPORT at the bottom — remove duplicate
// ─────────────────────────────────────────────────────────────

const CONFIG = {
    MIN_ATR_VALUE: 5.0,           // Was 8.0 — lower
    MAX_TRADES_PER_HOUR: 2,        // Was 1
    COOLDOWN_CANDLES: 2,           // Was 5
    MAX_CONSECUTIVE_LOSSES: 6,     // Was 4
    MIN_PULLBACK_DEPTH: 0.4,       // Was 0.8 — much lower
    MIN_STRUCTURE_SCORE: 50,       // Was 70 — much lower
    MIN_RR: 1.2,                   // Was 1.5
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
// H4 BIAS (using EMA10 for faster response)
// ─────────────────────────────────────────────────────────────
function _h4Bias(h4Candles) {
    if (!h4Candles || h4Candles.length < 25) return null;

    const ema10now = _ema(h4Candles, 10);
    const ema10prev = _ema(h4Candles.slice(0, -3), 10);
    if (!ema10now || !ema10prev) return null;

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema10now - ema10prev;
    const slopePct = slope / price;
    
    if (Math.abs(slopePct) < 0.0006) return null;
    
    const distPct = Math.abs(price - ema10now) / price;
    if (distPct < 0.001) return null;
    
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
    const e8 = _ema(cl, 8);
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
                consLosses: 0, 
                lastFiredMs: 0, 
                tradeCount: 0, 
                windowStart: Date.now(),
                totalTrades: 0,
                totalWins: 0,
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

    checkEntry(m5Candles, h4Candles, atr, botId, dailyCandles = [], weeklyCandles = []) {
        if (!m5Candles || m5Candles.length < 50 || !atr) return null;
        if (this.isHalted(botId)) return null;
        if (this.isTooFrequent(botId)) return null;
        if (atr < CONFIG.MIN_ATR_VALUE) return null;
        
        // Cooldown
        const s = this._getStats(botId);
        const cooldownMs = CONFIG.COOLDOWN_CANDLES * 300 * 1000;
        if (Date.now() - s.lastFiredMs < cooldownMs) return null;
        
        // ── H4 BIAS ────────────────────────────────────────────
        const bias = _h4Bias(h4Candles);
        if (!bias) return null;
        
        // ── STRUCTURE MAP ──────────────────────────────────────
        const structureMap = StructureEngine.getStructureMap(m5Candles, dailyCandles, weeklyCandles);
        if (!structureMap.dailyLevels) return null;
        
        const price = m5Candles[m5Candles.length - 1].close;
        const structureScore = structureMap.getStructureScore(price, bias);
        const position = structureMap.getPricePosition(price);
        
        // STRUCTURE FILTER: Must be at support for BUY, resistance for SELL
        if (bias === 'BUY' && position !== 'SUPPORT' && position !== 'BREAKOUT_UP') {
            console.log(`[CIPHER] BUY signal but price at ${position} — skipping`);
            return null;
        }
        if (bias === 'SELL' && position !== 'RESISTANCE' && position !== 'BREAKOUT_DOWN') {
            console.log(`[CIPHER] SELL signal but price at ${position} — skipping`);
            return null;
        }
        
        if (structureScore < CONFIG.MIN_STRUCTURE_SCORE) return null;
        
        // ── PULLBACK TO EMA ZONE ───────────────────────────────
        const pullbackDepth = _pullbackDepth(m5Candles, atr, bias);
        if (pullbackDepth < CONFIG.MIN_PULLBACK_DEPTH) return null;
        
        // ── TRIGGER CANDLE ─────────────────────────────────────
        if (!_triggerCandle(m5Candles, bias)) return null;
        
        // ── RSI CONFIRMATION ───────────────────────────────────
        const rsiVal = _rsi(m5Candles.slice(0, -1));
        if (bias === 'BUY' && rsiVal && rsiVal > 45) return null;
        if (bias === 'SELL' && rsiVal && rsiVal < 55) return null;
        
        // ── SET TP/SL BASED ON STRUCTURE ───────────────────────
        let sl, tp, risk, reward, rr;
        
        if (bias === 'BUY') {
            // Find nearest support for SL
            let supportLevel = structureMap.dailyLevels.dailyLow;
            if (structureMap.demandZones.length > 0) {
                supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
            }
            sl = supportLevel * 0.998;
            
            // Find nearest resistance for TP
            let resistanceLevel = structureMap.dailyLevels.dailyMid;
            if (structureMap.supplyZones.length > 0) {
                resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
            }
            tp = resistanceLevel;
        } else {
            // Find nearest resistance for SL
            let resistanceLevel = structureMap.dailyLevels.dailyHigh;
            if (structureMap.supplyZones.length > 0) {
                resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
            }
            sl = resistanceLevel * 1.002;
            
            // Find nearest support for TP
            let supportLevel = structureMap.dailyLevels.dailyMid;
            if (structureMap.demandZones.length > 0) {
                supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
            }
            tp = supportLevel;
        }
        
        risk = Math.abs(price - sl);
        reward = Math.abs(tp - price);
        rr = reward / risk;
        
        if (rr < CONFIG.MIN_RR) return null;
        
        // ── RECORD AND RETURN ──────────────────────────────────
        this.recordTrade(botId);
        
        const factors = [
            `H4 bias ${bias}`,
            `${position} (score ${structureScore})`,
            `Pullback ${pullbackDepth.toFixed(1)}x ATR`,
            `RSI ${rsiVal?.toFixed(0)}`,
            `R:R ${rr.toFixed(1)}:1`
        ];
        
        console.log(`[CIPHER] ✅ ${bias} on BTC | ${factors.join(' · ')}`);
        
        return {
            type: bias,
            label: `CIPHER ${bias} [${position}]`,
            score: structureScore,
            factors: factors,
            tpMultiplier: reward / atr,
            slMultiplier: risk / atr,
            isCipher: true,
            _meta: { position, structureScore, pullbackDepth, rr, sl, tp, price, rsi: rsiVal }
        };
    },
};

// ─────────────────────────────────────────────────────────────
// SINGLE EXPORT — no duplicates
// ─────────────────────────────────────────────────────────────
export function isCipherSymbol(symbol) {
    return CIPHER_SYMBOLS.includes(symbol);
}