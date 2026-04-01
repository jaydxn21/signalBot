// cipher-dynamic.js — CIPHER DYNAMIC R:R BTC Strategy
//
// DYNAMIC R:R ADJUSTMENT:
//   - 1:4 ratio when conditions are PERFECT (strong trend + deep pullback + ideal RSI)
//   - 1:3 ratio when conditions are GOOD (moderate trend + proper setup)
//   - 1:2 ratio when conditions are FAIR (minimum viable setup)
//   - No trade when conditions are WEAK
//
// ADAPTIVE FILTERS:
//   - Trend strength (H4 EMA stack + momentum)
//   - Pullback quality (depth into EMA zone)
//   - RSI alignment (oversold/overbought recovery)
//   - Volume confirmation
//   - Volatility regime (ATR expansion)
//
// SYMBOLS: cryBTCUSD, BTCUSD
// TIMEFRAME: M5 entry, H4 bias

const CIPHER_SYMBOLS = ['cryBTCUSD', 'BTCUSD'];

export function isCipherSymbol(symbol) {
    return CIPHER_SYMBOLS.includes(symbol);
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC CONFIGURATION
// ─────────────────────────────────────────────────────────────
const CONFIG = {
    // Session filter (optional)
    SESSION_FILTER_ENABLED: false,
    
    // Volume confirmation required
    VOLUME_CONFIRMATION: true,
    
    // Minimum ATR (in price units) to avoid ultra-low volatility
    MIN_ATR_VALUE: 5.0,  // Adjust based on BTC price level
    
    // Maximum trades per hour (quality over quantity)
    MAX_TRADES_PER_HOUR: 2,
    
    // Cooldown candles between entries
    COOLDOWN_CANDLES: 3,
    
    // Consecutive losses to halt (dynamic R:R allows more)
    MAX_CONSECUTIVE_LOSSES: 6,
    
    // Minimum pullback depth (in ATR multiples) for each tier
    MIN_PULLBACK: {
        '4_1': 1.2,   // Deep pullback for 1:4
        '3_1': 0.9,   // Moderate pullback for 1:3
        '2_1': 0.6    // Light pullback for 1:2
    },
    
    // RSI ranges for each tier
    RSI_RANGES: {
        'BUY': {
            '4_1': [25, 45],   // Very oversold for 1:4
            '3_1': [30, 50],   // Oversold for 1:3
            '2_1': [35, 55]    // Neutral for 1:2
        },
        'SELL': {
            '4_1': [55, 75],   // Very overbought for 1:4
            '3_1': [50, 70],   // Overbought for 1:3
            '2_1': [45, 65]    // Neutral for 1:2
        }
    }
};

// ─────────────────────────────────────────────────────────────
// SESSION FILTER (optional)
// ─────────────────────────────────────────────────────────────
function _isGoodSession() {
    if (!CONFIG.SESSION_FILTER_ENABLED) return true;
    
    const hourUTC = new Date().getUTCHours();
    // Avoid Asian session (00-06 UTC) — lower volatility
    if (hourUTC >= 0 && hourUTC < 6) return false;
    
    // Best sessions: London (07-15) and NY (12-20)
    return true;
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

function _bbWidth(candles, period = 20) {
    if (candles.length < period) return null;
    const sl = candles.slice(-period);
    const mean = sl.reduce((a, c) => a + c.close, 0) / period;
    const std = Math.sqrt(sl.reduce((a, c) => a + (c.close - mean) ** 2, 0) / period);
    return { width: (mean + 2 * std) - (mean - 2 * std), mean, std };
}

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
// ENHANCED TREND STRENGTH (0-100)
// ─────────────────────────────────────────────────────────────
function _trendStrength(h4Candles) {
    if (!h4Candles || h4Candles.length < 50) return 50;
    
    let score = 50;
    const h4Price = h4Candles[h4Candles.length - 1].close;
    
    // 1. EMA alignment (40% weight)
    const h4Ema21 = _ema(h4Candles, 21);
    const h4Ema50 = _ema(h4Candles, 50);
    const h4Ema200 = _ema(h4Candles, 200);
    
    if (h4Ema21 && h4Ema50) {
        // Strong uptrend: price > EMA21 > EMA50
        if (h4Price > h4Ema21 && h4Ema21 > h4Ema50) score += 25;
        // Strong downtrend: price < EMA21 < EMA50
        else if (h4Price < h4Ema21 && h4Ema21 < h4Ema50) score -= 25;
        // Moderate uptrend
        else if (h4Price > h4Ema21) score += 12;
        // Moderate downtrend
        else if (h4Price < h4Ema21) score -= 12;
    }
    
    // 2. Multi-EMA stack (20% weight)
    if (h4Ema21 && h4Ema50 && h4Ema200) {
        if (h4Ema21 > h4Ema50 && h4Ema50 > h4Ema200) score += 15;
        else if (h4Ema21 < h4Ema50 && h4Ema50 < h4Ema200) score -= 15;
        else if (h4Ema21 > h4Ema50) score += 8;
        else if (h4Ema21 < h4Ema50) score -= 8;
    }
    
    // 3. Momentum (20% weight)
    if (h4Candles.length >= 10) {
        const recent = h4Candles.slice(-5);
        const momentum = recent[recent.length - 1].close - recent[0].close;
        const atrH4 = _atr(h4Candles, 14);
        if (atrH4) {
            const momentumRatio = momentum / atrH4;
            if (momentumRatio > 1.2) score += 15;
            else if (momentumRatio > 0.6) score += 8;
            else if (momentumRatio < -1.2) score -= 15;
            else if (momentumRatio < -0.6) score -= 8;
        }
    }
    
    // 4. EMA slope (20% weight)
    const ema21now = _ema(h4Candles, 21);
    const ema21prev = _ema(h4Candles.slice(0, -5), 21);
    if (ema21now && ema21prev) {
        const slopePct = (ema21now - ema21prev) / ema21prev;
        if (slopePct > 0.008) score += 15;
        else if (slopePct > 0.004) score += 8;
        else if (slopePct < -0.008) score -= 15;
        else if (slopePct < -0.004) score -= 8;
    }
    
    return Math.min(100, Math.max(0, score));
}

// ─────────────────────────────────────────────────────────────
// H4 BIAS (with confidence)
// ─────────────────────────────────────────────────────────────
function _h4Bias(h4Candles) {
    if (!h4Candles || h4Candles.length < 25) return null;

    const ema21now = _ema(h4Candles, 21);
    const ema21prev = _ema(h4Candles.slice(0, -5), 21);
    if (!ema21now || !ema21prev) return null;

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema21now - ema21prev;
    const slopePct = slope / price;
    
    // Need slope > 0.04% for any trade
    if (Math.abs(slopePct) < 0.0004) return null;
    
    // Distance from EMA21
    const distPct = Math.abs(price - ema21now) / price;
    
    if (price > ema21now && slope > 0) {
        return { bias: 'BUY', strength: Math.min(100, distPct * 5000) };
    }
    if (price < ema21now && slope < 0) {
        return { bias: 'SELL', strength: Math.min(100, distPct * 5000) };
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// CONSOLIDATION FILTER
// ─────────────────────────────────────────────────────────────
function _isConsolidating(m5Candles, atr) {
    if (m5Candles.length < 50) return true;
    
    const bb = _bbWidth(m5Candles, 20);
    if (!bb) return true;
    
    // Calculate average BB width over last 50 bars
    let widthSum = 0;
    for (let i = 50; i >= 1; i--) {
        const slice = m5Candles.slice(0, m5Candles.length - i);
        if (slice.length >= 20) {
            const w = _bbWidth(slice, 20);
            if (w) widthSum += w.width;
        }
    }
    const avgWidth = widthSum / 50;
    
    // Consolidation if BB width < 55% of average
    if (bb.width < avgWidth * 0.55) return true;
    
    // ATR contraction check
    const avgAtr = _atrAvg(m5Candles);
    if (avgAtr && atr < avgAtr * 0.4) return true;
    
    return false;
}

// ─────────────────────────────────────────────────────────────
// PULLBACK QUALITY
// ─────────────────────────────────────────────────────────────
function _pullbackMetrics(candles, atr, bias) {
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const e8 = _ema(cl, 8);
    const e21 = _ema(cl, 21);
    if (!e8 || !e21) return { depth: 0, quality: 0 };
    
    const zoneTop = Math.max(e8, e21);
    const zoneBottom = Math.min(e8, e21);
    const zoneMid = (e8 + e21) / 2;
    
    let depth = 0;
    if (bias === 'BUY') {
        depth = (zoneMid - c0.low) / atr;
        // Check if price actually entered the zone
        const enteredZone = c0.low <= zoneTop && c0.close >= zoneBottom;
        if (!enteredZone) depth = 0;
    } else {
        depth = (c0.high - zoneMid) / atr;
        const enteredZone = c0.high >= zoneBottom && c0.close <= zoneTop;
        if (!enteredZone) depth = 0;
    }
    
    // Quality score based on depth
    let quality = 0;
    if (depth >= 1.5) quality = 100;
    else if (depth >= 1.2) quality = 85;
    else if (depth >= 1.0) quality = 70;
    else if (depth >= 0.8) quality = 55;
    else if (depth >= 0.6) quality = 40;
    else quality = 20;
    
    return { depth, quality };
}

// ─────────────────────────────────────────────────────────────
// TRIGGER CANDLE QUALITY
// ─────────────────────────────────────────────────────────────
function _triggerQuality(candles, bias) {
    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    if (!c0 || !c1) return 0;
    
    const range = c0.high - c0.low;
    if (range === 0) return 0;
    const body = Math.abs(c0.close - c0.open);
    const bodyRatio = body / range;
    
    let quality = 0;
    if (bodyRatio >= 0.8) quality = 100;
    else if (bodyRatio >= 0.7) quality = 80;
    else if (bodyRatio >= 0.6) quality = 60;
    else return 0;
    
    // Check direction
    if (bias === 'BUY') {
        const isBullish = c0.close > c0.open && c0.close > c1.high;
        return isBullish ? quality : 0;
    } else {
        const isBearish = c0.close < c0.open && c0.close < c1.low;
        return isBearish ? quality : 0;
    }
}

// ─────────────────────────────────────────────────────────────
// RSI SCORING
// ─────────────────────────────────────────────────────────────
function _rsiScore(rsiVal, bias) {
    if (!rsiVal) return 0;
    
    if (bias === 'BUY') {
        if (rsiVal <= 30) return 100;      // Deep oversold
        if (rsiVal <= 35) return 85;
        if (rsiVal <= 40) return 70;
        if (rsiVal <= 45) return 55;
        if (rsiVal <= 50) return 40;
        if (rsiVal <= 55) return 25;
        return 0;
    } else {
        if (rsiVal >= 70) return 100;      // Deep overbought
        if (rsiVal >= 65) return 85;
        if (rsiVal >= 60) return 70;
        if (rsiVal >= 55) return 55;
        if (rsiVal >= 50) return 40;
        if (rsiVal >= 45) return 25;
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────
// VOLUME CONFIRMATION
// ─────────────────────────────────────────────────────────────
function _volumeOk(candles) {
    if (!CONFIG.VOLUME_CONFIRMATION) return true;
    if (!candles[0] || typeof candles[0].volume === 'undefined') return true;
    
    const cl = candles.slice(-15);
    const avgVol = cl.reduce((a, c) => a + (c.volume || 0), 0) / 15;
    const currentVol = candles[candles.length - 2]?.volume || 0;
    
    return currentVol > avgVol * 0.7;
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC R:R DETERMINATION
// ─────────────────────────────────────────────────────────────
function _determineRR(trendStrength, pullbackQuality, triggerQuality, rsiScore, atr, price) {
    // Calculate overall setup score (0-100)
    let setupScore = 0;
    
    // Trend strength (40% weight)
    setupScore += trendStrength * 0.4;
    
    // Pullback quality (25% weight)
    setupScore += pullbackQuality * 0.25;
    
    // Trigger quality (20% weight)
    setupScore += triggerQuality * 0.20;
    
    // RSI score (15% weight)
    setupScore += rsiScore * 0.15;
    
    // Bonus for high ATR (volatility expansion)
    if (atr > CONFIG.MIN_ATR_VALUE * 2) setupScore += 5;
    if (atr > CONFIG.MIN_ATR_VALUE * 3) setupScore += 5;
    
    // Cap at 100
    setupScore = Math.min(100, setupScore);
    
    // Determine R:R based on setup score
    if (setupScore >= 85) {
        return {
            tier: '4_1',
            tpMult: 4.0,
            slMult: 1.0,
            label: 'ELITE',
            score: setupScore,
            minWinRate: 20  // 1:4 needs >20% win rate
        };
    } else if (setupScore >= 70) {
        return {
            tier: '3_1',
            tpMult: 3.0,
            slMult: 1.0,
            label: 'STRONG',
            score: setupScore,
            minWinRate: 25  // 1:3 needs >25% win rate
        };
    } else if (setupScore >= 55) {
        return {
            tier: '2_1',
            tpMult: 2.0,
            slMult: 1.0,
            label: 'FAIR',
            score: setupScore,
            minWinRate: 34  // 1:2 needs >34% win rate
        };
    } else {
        return null;  // No trade
    }
}

// ─────────────────────────────────────────────────────────────
// CIPHER DYNAMIC STRATEGY
// ─────────────────────────────────────────────────────────────
export const CipherStrategy = {

    _stats: {},
    _dailyStats: { trades: [], wins: 0, losses: 0, pnl: 0, date: null },

    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = { 
                consLosses: 0, 
                lastFiredMs: 0, 
                tradeCount: 0, 
                windowStart: Date.now(),
                rrDistribution: { '2_1': 0, '3_1': 0, '4_1': 0 }
            };
        }
        return this._stats[botId];
    },

    recordOutcome(botId, outcome, rrTier) {
        const s = this._getStats(botId);
        if (outcome === 'TP') {
            s.consLosses = 0;
            if (rrTier) s.rrDistribution[rrTier] = (s.rrDistribution[rrTier] || 0) + 1;
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

    recordTrade(botId, rrTier) {
        const s = this._getStats(botId);
        s.tradeCount++;
        s.lastFiredMs = Date.now();
        if (rrTier) s.rrDistribution[rrTier] = (s.rrDistribution[rrTier] || 0);
    },

    getStats(botId) {
        return this._getStats(botId);
    },

    checkEntry(m5Candles, h4Candles, atr, botId) {
        // ── Basic validations ─────────────────────────────────
        if (!m5Candles || m5Candles.length < 50 || !atr) return null;
        if (this.isHalted(botId)) {
            console.log(`[CIPHER] Bot ${botId} halted after ${this._getStats(botId).consLosses} losses`);
            return null;
        }
        if (this.isTooFrequent(botId)) return null;
        if (!_isGoodSession()) return null;
        
        // Skip if ATR too low
        if (atr < CONFIG.MIN_ATR_VALUE) return null;
        
        // ── Cooldown ─────────────────────────────────────────
        const s = this._getStats(botId);
        const cooldownMs = CONFIG.COOLDOWN_CANDLES * 300 * 1000;
        if (Date.now() - s.lastFiredMs < cooldownMs) return null;
        
        // ── Market regime ────────────────────────────────────
        if (_isConsolidating(m5Candles, atr)) return null;
        
        // ── H4 bias ──────────────────────────────────────────
        const h4BiasResult = _h4Bias(h4Candles);
        if (!h4BiasResult) return null;
        const { bias, strength: h4Strength } = h4BiasResult;
        
        // ── Trend strength ───────────────────────────────────
        const trendStrength = _trendStrength(h4Candles);
        
        // ── Pullback quality ─────────────────────────────────
        const { depth: pullbackDepth, quality: pullbackQuality } = _pullbackMetrics(m5Candles, atr, bias);
        if (pullbackDepth < 0.5) return null;  // Minimum threshold
        
        // ── Trigger quality ──────────────────────────────────
        const triggerQuality = _triggerQuality(m5Candles, bias);
        if (triggerQuality === 0) return null;
        
        // ── RSI ──────────────────────────────────────────────
        const rsiVal = _rsi(m5Candles.slice(0, -1));
        const rsiScoreVal = _rsiScore(rsiVal, bias);
        if (rsiScoreVal === 0) return null;
        
        // ── Volume ───────────────────────────────────────────
        if (!_volumeOk(m5Candles)) return null;
        
        // ── Dynamic R:R determination ────────────────────────
        const rrConfig = _determineRR(
            trendStrength, 
            pullbackQuality, 
            triggerQuality, 
            rsiScoreVal,
            atr,
            m5Candles[m5Candles.length - 1].close
        );
        
        if (!rrConfig) return null;
        
        // ── Additional tier-specific checks ──────────────────
        if (rrConfig.tier === '4_1') {
            // 1:4 requires extra confirmation
            if (pullbackDepth < CONFIG.MIN_PULLBACK['4_1']) return null;
            const rsiRange = CONFIG.RSI_RANGES[bias]['4_1'];
            if (rsiVal < rsiRange[0] || rsiVal > rsiRange[1]) return null;
            if (trendStrength < 75) return null;
        } else if (rrConfig.tier === '3_1') {
            if (pullbackDepth < CONFIG.MIN_PULLBACK['3_1']) return null;
            const rsiRange = CONFIG.RSI_RANGES[bias]['3_1'];
            if (rsiVal < rsiRange[0] || rsiVal > rsiRange[1]) return null;
            if (trendStrength < 60) return null;
        } else if (rrConfig.tier === '2_1') {
            if (pullbackDepth < CONFIG.MIN_PULLBACK['2_1']) return null;
            const rsiRange = CONFIG.RSI_RANGES[bias]['2_1'];
            if (rsiVal < rsiRange[0] || rsiVal > rsiRange[1]) return null;
        }
        
        // ── Record and return ────────────────────────────────
        this.recordTrade(botId, rrConfig.tier);
        
        // Build factor list for logging
        const factors = [
            `H4 bias ${bias} (${Math.round(h4Strength)}%)`,
            `Trend ${Math.round(trendStrength)}%`,
            `Pullback ${pullbackDepth.toFixed(1)}x ATR`,
            `RSI ${rsiVal?.toFixed(0)} (${Math.round(rsiScoreVal)}%)`,
            `Trigger ${Math.round(triggerQuality)}%`,
            `${rrConfig.label} ${rrConfig.tier.replace('_', ':')} R:R`
        ];
        
        // Log the dynamic decision
        console.log(`[CIPHER] Setup score: ${rrConfig.score} → ${rrConfig.tier.replace('_', ':')} R:R`);
        
        return {
            type: bias,
            label: `CIPHER ${bias} [${rrConfig.label} ${rrConfig.tier.replace('_', ':')}]`,
            score: rrConfig.score,
            factors: factors,
            tpMultiplier: rrConfig.tpMult,
            slMultiplier: rrConfig.slMult,
            isCipher: true,
            trendStrength,
            rrTier: rrConfig.tier,
            // Store metadata for debugging
            _meta: {
                setupScore: rrConfig.score,
                pullbackDepth,
                triggerQuality,
                rsiScore: rsiScoreVal,
                trendStrength
            }
        };
    },
};

export { isCipherSymbol };