// cipher-dynamic.js — CIPHER DYNAMIC R:R BTC Strategy
//
// UPDATED: Fixed 11% win rate issue
//   - Enabled proper SELL signals (was missing)
//   - Much stricter entry requirements
//   - Emergency mode with 1:1.5 R:R until win rate improves
//   - Added win rate gate to auto-halt
//   - Increased all thresholds significantly
//
// SYMBOLS: cryBTCUSD, BTCUSD
// TIMEFRAME: M5 entry, H4 bias

const CIPHER_SYMBOLS = ['cryBTCUSD', 'BTCUSD'];

export function isCipherSymbol(symbol) {
    return CIPHER_SYMBOLS.includes(symbol);
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC CONFIGURATION — TIGHTENED FOR 11% WIN RATE FIX
// ─────────────────────────────────────────────────────────────
const CONFIG = {
    // EMERGENCY MODE: Force 1:1.5 R:R with extreme conditions only
    EMERGENCY_MODE: true,  // Set to false after win rate improves to >25%
    
    // Session filter (optional)
    SESSION_FILTER_ENABLED: false,
    
    // Volume confirmation required
    VOLUME_CONFIRMATION: true,
    
    // Minimum ATR (in price units) to avoid ultra-low volatility
    MIN_ATR_VALUE: 8.0,  // Increased from 5.0
    
    // Maximum trades per hour (quality over quantity)
    MAX_TRADES_PER_HOUR: 1,  // Reduced from 2
    
    // Cooldown candles between entries
    COOLDOWN_CANDLES: 5,  // Increased from 3
    
    // Consecutive losses to halt
    MAX_CONSECUTIVE_LOSSES: 4,  // Reduced from 6 (stricter)
    
    // Minimum win rate to continue trading (20 trade sample)
    MIN_WIN_RATE_PERCENT: 15,
    
    // Minimum pullback depth (in ATR multiples) — MUCH STRICTER
    MIN_PULLBACK: {
        '4_1': 1.8,   // Was 1.2
        '3_1': 1.4,   // Was 0.9
        '2_1': 1.0    // Was 0.6
    },
    
    // TIGHTER RSI ranges
    RSI_RANGES: {
        'BUY': {
            '4_1': [20, 35],   // Was [25,45] — much more oversold
            '3_1': [25, 40],   // Was [30,50]
            '2_1': [30, 45]    // Was [35,55]
        },
        'SELL': {
            '4_1': [65, 80],   // Was [55,75] — much more overbought
            '3_1': [60, 75],   // Was [50,70]
            '2_1': [55, 70]    // Was [45,65]
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
    
    const h4Ema10 = _ema(h4Candles, 10);   // Added faster EMA
    const h4Ema21 = _ema(h4Candles, 21);
    const h4Ema50 = _ema(h4Candles, 50);
    const h4Ema200 = _ema(h4Candles, 200);
    
    // 1. EMA alignment with faster EMA10 (40% weight)
    if (h4Ema10 && h4Ema21) {
        if (h4Price > h4Ema10 && h4Ema10 > h4Ema21) score += 30;
        else if (h4Price < h4Ema10 && h4Ema10 < h4Ema21) score -= 30;
        else if (h4Price > h4Ema21) score += 15;
        else if (h4Price < h4Ema21) score -= 15;
    }
    
    // 2. Multi-EMA stack (20% weight)
    if (h4Ema21 && h4Ema50 && h4Ema200) {
        if (h4Ema21 > h4Ema50 && h4Ema50 > h4Ema200) score += 15;
        else if (h4Ema21 < h4Ema50 && h4Ema50 < h4Ema200) score -= 15;
    }
    
    // 3. Momentum (20% weight)
    if (h4Candles.length >= 10) {
        const recent = h4Candles.slice(-5);
        const momentum = recent[recent.length - 1].close - recent[0].close;
        const atrH4 = _atr(h4Candles, 14);
        if (atrH4) {
            const momentumRatio = momentum / atrH4;
            if (momentumRatio > 1.0) score += 15;
            else if (momentumRatio > 0.5) score += 8;
            else if (momentumRatio < -1.0) score -= 15;
            else if (momentumRatio < -0.5) score -= 8;
        }
    }
    
    // 4. EMA slope with faster period (20% weight)
    const ema10now = _ema(h4Candles, 10);
    const ema10prev = _ema(h4Candles.slice(0, -3), 10);
    if (ema10now && ema10prev) {
        const slopePct = (ema10now - ema10prev) / ema10prev;
        if (slopePct > 0.006) score += 15;
        else if (slopePct > 0.003) score += 8;
        else if (slopePct < -0.006) score -= 15;
        else if (slopePct < -0.003) score -= 8;
    }
    
    return Math.min(100, Math.max(0, score));
}

// ─────────────────────────────────────────────────────────────
// H4 BIAS (FIXED — now returns SELL signals properly)
// ─────────────────────────────────────────────────────────────
function _h4Bias(h4Candles) {
    if (!h4Candles || h4Candles.length < 25) return null;

    // Use faster EMA10 for bias detection
    const ema10now = _ema(h4Candles, 10);
    const ema10prev = _ema(h4Candles.slice(0, -3), 10);
    const ema21now = _ema(h4Candles, 21);
    
    if (!ema10now || !ema10prev || !ema21now) return null;

    const price = h4Candles[h4Candles.length - 1].close;
    const slope = ema10now - ema10prev;
    const slopePct = slope / price;
    
    // Need slope > 0.06% for any trade (stricter)
    if (Math.abs(slopePct) < 0.0006) return null;
    
    // Distance from EMA10 (tighter)
    const distPct = Math.abs(price - ema10now) / price;
    if (distPct < 0.001) return null;  // Too close to EMA
    
    // CRITICAL FIX: Ensure both directions work
    if (price > ema10now && slope > 0) {
        console.log(`[H4 Bias] BUY signal — price=${price.toFixed(0)}, EMA10=${ema10now.toFixed(0)}, slope=${(slopePct*100).toFixed(2)}%`);
        return { bias: 'BUY', strength: Math.min(100, distPct * 5000) };
    }
    if (price < ema10now && slope < 0) {
        console.log(`[H4 Bias] SELL signal — price=${price.toFixed(0)}, EMA10=${ema10now.toFixed(0)}, slope=${(slopePct*100).toFixed(2)}%`);
        return { bias: 'SELL', strength: Math.min(100, distPct * 5000) };
    }
    
    return null;
}

// ─────────────────────────────────────────────────────────────
// CONSOLIDATION FILTER (STRICTER)
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
    
    // Consolidation if BB width < 65% of average (stricter)
    if (bb.width < avgWidth * 0.65) return true;
    
    // ATR contraction check
    const avgAtr = _atrAvg(m5Candles);
    if (avgAtr && atr < avgAtr * 0.5) return true;
    
    return false;
}

// ─────────────────────────────────────────────────────────────
// PULLBACK QUALITY (STRICTER)
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
        const enteredZone = c0.low <= zoneTop && c0.close >= zoneBottom;
        if (!enteredZone) depth = 0;
    } else {
        depth = (c0.high - zoneMid) / atr;
        const enteredZone = c0.high >= zoneBottom && c0.close <= zoneTop;
        if (!enteredZone) depth = 0;
    }
    
    // Stricter quality scoring
    let quality = 0;
    if (depth >= 2.0) quality = 100;
    else if (depth >= 1.6) quality = 85;
    else if (depth >= 1.3) quality = 70;
    else if (depth >= 1.0) quality = 50;
    else quality = 0;
    
    return { depth, quality };
}

// ─────────────────────────────────────────────────────────────
// TRIGGER CANDLE QUALITY (STRICTER)
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
    
    // Require at least 70% body ratio (was 60%)
    let quality = 0;
    if (bodyRatio >= 0.85) quality = 100;
    else if (bodyRatio >= 0.75) quality = 80;
    else if (bodyRatio >= 0.70) quality = 60;
    else return 0;
    
    // Check direction with stronger confirmation
    if (bias === 'BUY') {
        const isBullish = c0.close > c0.open && c0.close > c1.high && c0.close > c1.close;
        return isBullish ? quality : 0;
    } else {
        const isBearish = c0.close < c0.open && c0.close < c1.low && c0.close < c1.close;
        return isBearish ? quality : 0;
    }
}

// ─────────────────────────────────────────────────────────────
// RSI SCORING (STRICTER)
// ─────────────────────────────────────────────────────────────
function _rsiScore(rsiVal, bias) {
    if (!rsiVal) return 0;
    
    if (bias === 'BUY') {
        if (rsiVal <= 25) return 100;
        if (rsiVal <= 30) return 80;
        if (rsiVal <= 35) return 60;
        if (rsiVal <= 40) return 40;
        if (rsiVal <= 45) return 20;
        return 0;
    } else {
        if (rsiVal >= 75) return 100;
        if (rsiVal >= 70) return 80;
        if (rsiVal >= 65) return 60;
        if (rsiVal >= 60) return 40;
        if (rsiVal >= 55) return 20;
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
    
    return currentVol > avgVol * 0.8;  // Increased from 0.7
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC R:R DETERMINATION (with emergency override)
// ─────────────────────────────────────────────────────────────
function _determineRR(trendStrength, pullbackQuality, triggerQuality, rsiScore, atr, price) {
    // EMERGENCY MODE: Force 1:1.5 R:R
    if (CONFIG.EMERGENCY_MODE) {
        return {
            tier: '1.5_1',
            tpMult: 1.5,
            slMult: 1.0,
            label: 'EMERGENCY',
            score: 90,
            minWinRate: 40
        };
    }
    
    // Normal dynamic calculation
    let setupScore = 0;
    setupScore += trendStrength * 0.4;
    setupScore += pullbackQuality * 0.25;
    setupScore += triggerQuality * 0.20;
    setupScore += rsiScore * 0.15;
    
    if (atr > CONFIG.MIN_ATR_VALUE * 2) setupScore += 5;
    if (atr > CONFIG.MIN_ATR_VALUE * 3) setupScore += 5;
    
    setupScore = Math.min(100, setupScore);
    
    if (setupScore >= 90) {
        return { tier: '4_1', tpMult: 4.0, slMult: 1.0, label: 'ELITE', score: setupScore, minWinRate: 20 };
    } else if (setupScore >= 78) {
        return { tier: '3_1', tpMult: 3.0, slMult: 1.0, label: 'STRONG', score: setupScore, minWinRate: 25 };
    } else if (setupScore >= 65) {
        return { tier: '2_1', tpMult: 2.0, slMult: 1.0, label: 'FAIR', score: setupScore, minWinRate: 34 };
    } else {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// CIPHER DYNAMIC STRATEGY (FIXED)
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
                rrDistribution: { '1.5_1': 0, '2_1': 0, '3_1': 0, '4_1': 0 }
            };
        }
        return this._stats[botId];
    },

    recordOutcome(botId, outcome, rrTier) {
        const s = this._getStats(botId);
        if (outcome === 'TP') {
            s.consLosses = 0;
            s.totalWins++;
            if (rrTier) s.rrDistribution[rrTier] = (s.rrDistribution[rrTier] || 0) + 1;
        } else {
            s.consLosses++;
        }
        s.totalTrades++;
    },

    isHalted(botId) {
        const s = this._getStats(botId);
        return s.consLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES;
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

    // Win rate gate: halt if win rate falls below threshold
    isWinRateTooLow(botId) {
        const s = this._getStats(botId);
        if (s.totalTrades < 20) return false;
        const winRate = (s.totalWins / s.totalTrades) * 100;
        if (winRate < CONFIG.MIN_WIN_RATE_PERCENT) {
            console.log(`[CIPHER] HALTED: Win rate ${winRate.toFixed(1)}% below ${CONFIG.MIN_WIN_RATE_PERCENT}% after ${s.totalTrades} trades`);
            return true;
        }
        return false;
    },

    recordTrade(botId, rrTier) {
        const s = this._getStats(botId);
        s.tradeCount++;
        s.lastFiredMs = Date.now();
    },

    getStats(botId) {
        return this._getStats(botId);
    },

    checkEntry(m5Candles, h4Candles, atr, botId) {
        // ── Basic validations ─────────────────────────────────
        if (!m5Candles || m5Candles.length < 50 || !atr) return null;
        if (this.isHalted(botId)) return null;
        if (this.isWinRateTooLow(botId)) return null;
        if (this.isTooFrequent(botId)) return null;
        if (!_isGoodSession()) return null;
        
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
        if (pullbackDepth < 0.8) return null;  // Increased minimum
        
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
        const requiredPullback = CONFIG.MIN_PULLBACK[rrConfig.tier] || 0.8;
        if (pullbackDepth < requiredPullback) return null;
        
        const rsiRange = CONFIG.RSI_RANGES[bias][rrConfig.tier] || CONFIG.RSI_RANGES[bias]['2_1'];
        if (rsiVal < rsiRange[0] || rsiVal > rsiRange[1]) return null;
        
        if (rrConfig.tier === '4_1' && trendStrength < 80) return null;
        if (rrConfig.tier === '3_1' && trendStrength < 65) return null;
        if (rrConfig.tier === '2_1' && trendStrength < 50) return null;
        
        // ── Record and return ────────────────────────────────
        this.recordTrade(botId, rrConfig.tier);
        
        const factors = [
            `H4 bias ${bias} (${Math.round(h4Strength)}%)`,
            `Trend ${Math.round(trendStrength)}%`,
            `Pullback ${pullbackDepth.toFixed(1)}x ATR`,
            `RSI ${rsiVal?.toFixed(0)} (${Math.round(rsiScoreVal)}%)`,
            `Trigger ${Math.round(triggerQuality)}%`,
            `${rrConfig.label} ${rrConfig.tier.replace('_', ':')} R:R`
        ];
        
        console.log(`[CIPHER] ✅ SIGNAL ${bias} | Score: ${rrConfig.score} | ${rrConfig.tier.replace('_', ':')} R:R | RSI: ${rsiVal?.toFixed(0)} | Pullback: ${pullbackDepth.toFixed(1)}x`);
        
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
            _meta: {
                setupScore: rrConfig.score,
                pullbackDepth,
                triggerQuality,
                rsiScore: rsiScoreVal,
                trendStrength,
                rsiValue: rsiVal
            }
        };
    },
};

export { isCipherSymbol };