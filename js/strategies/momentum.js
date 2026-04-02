// momentum.js — Momentum Strategy with Structure Integration
//
// ENTRY RULES:
//   - MUST be at daily support for BUY, or daily resistance for SELL
//   - Structure score must be ≥ 65
//   - Trend confirmation (EMA alignment)
//   - Engulfing or strong momentum candle
//
// EXIT RULES:
//   - TP at nearest supply/demand zone or daily mid
//   - Trailing stop after 1x ATR profit

import { StructureEngine } from '../structure-engine.js';

export const MomentumStrategy = {
    
    _cooldownCandles: 0,
    _lastTradeTime: 0,
    _tradeCount: 0,
    _weekStart: null,
    
    // ─────────────────────────────────────────────────────────────
    // PAIR-SPECIFIC CONFIGURATIONS
    // ─────────────────────────────────────────────────────────────
    _pairConfig: {
        'EURGBP': { enabled: true, bias: 'BOTH', minStructureScore: 65, riskPercent: 0.75 },
        'CADCHF': { enabled: true, bias: 'SHORT', minStructureScore: 60, riskPercent: 0.7 },
        'GBPUSD': { enabled: true, bias: 'BOTH', minStructureScore: 65, riskPercent: 0.75 },
        'EURUSD': { enabled: true, bias: 'BOTH', minStructureScore: 65, riskPercent: 0.75 },
        'USDJPY': { enabled: true, bias: 'BOTH', minStructureScore: 65, riskPercent: 0.7 },
        'CHFJPY': { enabled: false, bias: 'NONE', minStructureScore: 0, riskPercent: 0 },
        'default': { enabled: true, bias: 'BOTH', minStructureScore: 65, riskPercent: 0.7 }
    },
    
    // ─────────────────────────────────────────────────────────────
    // INDICATORS
    // ─────────────────────────────────────────────────────────────
    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    _atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const trs = [];
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i], p = candles[i - 1];
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        }
        return trs.reduce((a, b) => a + b, 0) / period;
    },
    
    _isBigBody(candle, atr) {
        const body = Math.abs(candle.close - candle.open);
        return body > atr * 0.5;
    },
    
    _isEngulfing(prev, curr) {
        const bullEngulf = curr.close > curr.open &&
                           curr.open < prev.close &&
                           curr.close > prev.open &&
                           prev.close < prev.open;
        const bearEngulf = curr.close < curr.open &&
                           curr.open > prev.close &&
                           curr.close < prev.open &&
                           prev.close > prev.open;
        return { bullEngulf, bearEngulf };
    },
    
    _isThreeConsecutive(c1, c2, c3) {
        const allBull = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
        const allBear = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;
        return { allBull, allBear };
    },
    
    _getTrendDirection(candles) {
        const fast = this._ema(candles, 8);
        const slow = this._ema(candles, 21);
        if (!fast || !slow) return null;
        if (fast > slow) return 'BULL';
        if (fast < slow) return 'BEAR';
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // STRUCTURE-BASED ENTRY
    // ─────────────────────────────────────────────────────────────
    checkEntry(candles, atr, symbol = '', dailyCandles = [], weeklyCandles = []) {
        if (!atr || candles.length < 30) return null;
        
        // Get pair config
        const cfg = this._pairConfig[symbol] || this._pairConfig['default'];
        if (!cfg.enabled) return null;
        
        // ── COOLDOWN (max 3 trades per week, 1 per day) ─────────
        const now = Date.now();
        if (now - this._lastTradeTime < 24 * 60 * 60 * 1000) return null;
        
        const currentWeek = this._getWeekStart();
        if (currentWeek !== this._weekStart) {
            this._tradeCount = 0;
            this._weekStart = currentWeek;
        }
        if (this._tradeCount >= 3) return null;
        
        // ── GET STRUCTURE MAP ───────────────────────────────────
        const structureMap = StructureEngine.getStructureMap(candles, dailyCandles, weeklyCandles);
        if (!structureMap.dailyLevels) return null;
        
        const price = candles[candles.length - 1].close;
        const position = structureMap.getPricePosition(price);
        const structureScore = structureMap.getStructureScore(price, 'BUY'); // Will check both
        
        // ── STRUCTURE FILTER ────────────────────────────────────
        // Determine if we should look for BUY or SELL based on structure
        let allowedBias = null;
        
        if (cfg.bias === 'BOTH') {
            if (position === 'SUPPORT') allowedBias = 'BUY';
            else if (position === 'RESISTANCE') allowedBias = 'SELL';
            else if (position === 'BREAKOUT_UP') allowedBias = 'BUY';
            else if (position === 'BREAKOUT_DOWN') allowedBias = 'SELL';
            else return null; // No clear structure bias
        } else if (cfg.bias === 'SHORT') {
            if (position !== 'RESISTANCE' && position !== 'BREAKOUT_DOWN') return null;
            allowedBias = 'SELL';
        } else if (cfg.bias === 'LONG') {
            if (position !== 'SUPPORT' && position !== 'BREAKOUT_UP') return null;
            allowedBias = 'BUY';
        }
        
        if (!allowedBias) return null;
        
        // Structure score check
        const biasScore = structureMap.getStructureScore(price, allowedBias);
        if (biasScore < cfg.minStructureScore) return null;
        
        // ── MOMENTUM CONFIRMATION ───────────────────────────────
        const c1 = candles[candles.length - 4];
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        
        if (!c1 || !c2 || !c3) return null;
        
        const { bullEngulf, bearEngulf } = this._isEngulfing(c2, c3);
        const { allBull, allBear } = this._isThreeConsecutive(c1, c2, c3);
        const bigBullBody = c3.close > c3.open && this._isBigBody(c3, atr);
        const bigBearBody = c3.close < c3.open && this._isBigBody(c3, atr);
        
        const bullScore = (bullEngulf ? 1 : 0) + (allBull ? 1 : 0) + (bigBullBody ? 1 : 0);
        const bearScore = (bearEngulf ? 1 : 0) + (allBear ? 1 : 0) + (bigBearBody ? 1 : 0);
        
        // Need at least 2 confirmations
        if (allowedBias === 'BUY' && bullScore < 2) return null;
        if (allowedBias === 'SELL' && bearScore < 2) return null;
        
        // ── TREND CONFIRMATION (optional, not required at support/resistance) ──
        const trend = this._getTrendDirection(candles.slice(0, -1));
        
        // ── SET TP/SL BASED ON STRUCTURE ────────────────────────
        let sl, tp;
        const nearest = structureMap.getDistanceToNearestLevel(price);
        
        if (allowedBias === 'BUY') {
            // Find nearest support below for SL
            let supportLevel = structureMap.dailyLevels.dailyLow;
            if (structureMap.demandZones.length > 0) {
                supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
            }
            sl = supportLevel * 0.998; // Just below support
            
            // Find nearest resistance above for TP
            let resistanceLevel = structureMap.dailyLevels.dailyMid;
            if (structureMap.supplyZones.length > 0) {
                resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
            }
            tp = resistanceLevel;
        } else {
            // Find nearest resistance above for SL
            let resistanceLevel = structureMap.dailyLevels.dailyHigh;
            if (structureMap.supplyZones.length > 0) {
                resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
            }
            sl = resistanceLevel * 1.002; // Just above resistance
            
            // Find nearest support below for TP
            let supportLevel = structureMap.dailyLevels.dailyMid;
            if (structureMap.demandZones.length > 0) {
                supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
            }
            tp = supportLevel;
        }
        
        // Calculate R:R
        const risk = Math.abs(price - sl);
        const reward = Math.abs(tp - price);
        const rr = reward / risk;
        
        if (rr < 1.5) return null; // Minimum 1.5:1 R:R
        
        // ── RECORD TRADE ────────────────────────────────────────
        this._lastTradeTime = now;
        this._tradeCount++;
        
        const factors = [
            `${position} (score ${biasScore})`,
            `${allowedBias === 'BUY' ? 'Bull' : 'Bear'} score ${allowedBias === 'BUY' ? bullScore : bearScore}/3`,
            `R:R ${rr.toFixed(1)}:1`,
            `Nearest: ${nearest.type || 'none'}`
        ];
        
        console.log(`[Momentum] 📍 ${allowedBias} on ${symbol} | ${factors.join(' · ')}`);
        
        return {
            type: allowedBias,
            label: `MOMENTUM ${allowedBias} [${position}]`,
            score: biasScore,
            factors: factors,
            tpMultiplier: reward / atr,
            slMultiplier: risk / atr,
            isMomentum: true,
            pairConfig: cfg,
            _meta: { position, structureScore: biasScore, rr, sl, tp, price }
        };
    },
    
    _getWeekStart() {
        const now = new Date();
        const day = now.getUTCDay();
        const diff = (day === 0 ? 6 : day - 1);
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - diff);
        monday.setUTCHours(0, 0, 0, 0);
        return monday.getTime();
    },
    
    registerLoss() {
        this._cooldownCandles = 3;
    },
    
    // Legacy methods for compatibility
    _isVolatileEnough() { return true; },
    _isTrending() { return true; },
    _isActiveSession() { return true; },
    _isConfirmed() { return true; },
    analyze() { return null; }
};