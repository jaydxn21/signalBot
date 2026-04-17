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
        'EURGBP': { enabled: true, bias: 'BOTH', minStructureScore: 55, riskPercent: 0.75 },
        'CADCHF': { enabled: true, bias: 'SHORT', minStructureScore: 50, riskPercent: 0.7 },
        'GBPUSD': { enabled: true, bias: 'BOTH', minStructureScore: 55, riskPercent: 0.75 },
        'EURUSD': { enabled: true, bias: 'BOTH', minStructureScore: 55, riskPercent: 0.75 },
        'USDJPY': { enabled: true, bias: 'BOTH', minStructureScore: 55, riskPercent: 0.7 },
        'CHFJPY': { enabled: false, bias: 'NONE', minStructureScore: 0, riskPercent: 0 },
        'default': { enabled: true, bias: 'BOTH', minStructureScore: 55, riskPercent: 0.7 }
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
        return body > atr * 0.3;  // Relaxed from 0.5
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
        
        // ── RELAXED COOLDOWN (max 5 trades per week, no daily limit) ─────────
        const now = Date.now();
        
        const currentWeek = this._getWeekStart();
        if (currentWeek !== this._weekStart) {
            this._tradeCount = 0;
            this._weekStart = currentWeek;
        }
        if (this._tradeCount >= 5) return null;
        
        // ── GET STRUCTURE MAP ───────────────────────────────────
        let structureMap;
        try {
            structureMap = StructureEngine.getStructureMap(candles, dailyCandles, weeklyCandles);
        } catch(e) {
            console.log('[Momentum] StructureEngine error:', e);
            // Fallback: trade without structure if engine fails
            return this._fallbackEntry(candles, atr, symbol, cfg);
        }
        
        if (!structureMap || !structureMap.dailyLevels) {
            // Fallback to momentum-only entry
            return this._fallbackEntry(candles, atr, symbol, cfg);
        }
        
        const price = candles[candles.length - 1].close;
        const position = structureMap.getPricePosition(price);
        
        // ── STRUCTURE FILTER (RELAXED) ──────────────────────────
        let allowedBias = null;
        
        if (cfg.bias === 'BOTH') {
            if (position === 'SUPPORT') allowedBias = 'BUY';
            else if (position === 'RESISTANCE') allowedBias = 'SELL';
            else if (position === 'BREAKOUT_UP') allowedBias = 'BUY';
            else if (position === 'BREAKOUT_DOWN') allowedBias = 'SELL';
            else if (position === 'MID_RANGE') {
                // In mid-range, follow trend
                const trend = this._getTrendDirection(candles.slice(0, -1));
                if (trend === 'BULL') allowedBias = 'BUY';
                else if (trend === 'BEAR') allowedBias = 'SELL';
                else return null;
            }
            else return null;
        } else if (cfg.bias === 'SHORT') {
            if (position !== 'RESISTANCE' && position !== 'BREAKOUT_DOWN' && position !== 'MID_RANGE') return null;
            allowedBias = 'SELL';
        } else if (cfg.bias === 'LONG') {
            if (position !== 'SUPPORT' && position !== 'BREAKOUT_UP' && position !== 'MID_RANGE') return null;
            allowedBias = 'BUY';
        }
        
        if (!allowedBias) return null;
        
        // ── MOMENTUM CONFIRMATION (RELAXED) ─────────────────────
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
        
        // Need at least 1 confirmation (relaxed from 2)
        if (allowedBias === 'BUY' && bullScore < 1) return null;
        if (allowedBias === 'SELL' && bearScore < 1) return null;
        
        // ── SET TP/SL BASED ON STRUCTURE OR ATR ─────────────────
        let sl, tp, risk, reward, rr;
        
        if (structureMap && structureMap.dailyLevels) {
            if (allowedBias === 'BUY') {
                let supportLevel = structureMap.dailyLevels.dailyLow;
                if (structureMap.demandZones && structureMap.demandZones.length > 0) {
                    supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
                }
                sl = supportLevel * 0.998;
                
                let resistanceLevel = structureMap.dailyLevels.dailyMid;
                if (structureMap.supplyZones && structureMap.supplyZones.length > 0) {
                    resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
                }
                tp = resistanceLevel;
            } else {
                let resistanceLevel = structureMap.dailyLevels.dailyHigh;
                if (structureMap.supplyZones && structureMap.supplyZones.length > 0) {
                    resistanceLevel = Math.min(resistanceLevel, structureMap.supplyZones[0].low);
                }
                sl = resistanceLevel * 1.002;
                
                let supportLevel = structureMap.dailyLevels.dailyMid;
                if (structureMap.demandZones && structureMap.demandZones.length > 0) {
                    supportLevel = Math.max(supportLevel, structureMap.demandZones[0].high);
                }
                tp = supportLevel;
            }
            
            risk = Math.abs(price - sl);
            reward = Math.abs(tp - price);
            rr = reward / risk;
        } else {
            // Fallback: use ATR-based SL/TP
            risk = atr * 1.0;
            reward = atr * 1.5;
            sl = allowedBias === 'BUY' ? price - risk : price + risk;
            tp = allowedBias === 'BUY' ? price + reward : price - reward;
            rr = 1.5;
        }
        
        if (rr < 1.2) return null; // Minimum 1.2:1 R:R (relaxed)
        
        // ── RECORD TRADE ────────────────────────────────────────
        this._lastTradeTime = now;
        this._tradeCount++;
        
        const factors = [
            `${position || 'MID'} ${allowedBias}`,
            `${allowedBias === 'BUY' ? 'Bull' : 'Bear'} score ${allowedBias === 'BUY' ? bullScore : bearScore}/3`,
            `R:R ${rr.toFixed(1)}:1`
        ];
        
        console.log(`[Momentum] 📍 ${allowedBias} on ${symbol} | ${factors.join(' · ')}`);
        
        return {
            type: allowedBias,
            label: `MOMENTUM ${allowedBias} [${position || 'MID'}]`,
            score: 65,
            factors: factors,
            tpMultiplier: reward / atr,
            slMultiplier: risk / atr,
            isMomentum: true,
            pairConfig: cfg,
            _meta: { position, rr, sl, tp, price }
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // FALLBACK: Momentum-only entry (no structure)
    // ─────────────────────────────────────────────────────────────
    _fallbackEntry(candles, atr, symbol, cfg) {
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
        
        let allowedBias = null;
        if (cfg.bias === 'BOTH') {
            if (bullScore >= 2) allowedBias = 'BUY';
            else if (bearScore >= 2) allowedBias = 'SELL';
        } else if (cfg.bias === 'SHORT' && bearScore >= 2) {
            allowedBias = 'SELL';
        } else if (cfg.bias === 'LONG' && bullScore >= 2) {
            allowedBias = 'BUY';
        }
        
        if (!allowedBias) return null;
        
        const risk = atr * 1.0;
        const reward = atr * 1.5;
        const price = candles[candles.length - 1].close;
        const sl = allowedBias === 'BUY' ? price - risk : price + risk;
        const tp = allowedBias === 'BUY' ? price + reward : price - reward;
        
        console.log(`[Momentum] 📍 FALLBACK ${allowedBias} on ${symbol} | Momentum only`);
        
        return {
            type: allowedBias,
            label: `MOMENTUM ${allowedBias} [FALLBACK]`,
            score: 55,
            factors: [`${allowedBias === 'BUY' ? 'Bull' : 'Bear'} score ${allowedBias === 'BUY' ? bullScore : bearScore}/3`, `FALLBACK (no structure)`],
            tpMultiplier: reward / atr,
            slMultiplier: risk / atr,
            isMomentum: true,
            pairConfig: cfg,
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
        this._cooldownCandles = 2;
    },
    
    // Legacy methods for compatibility
    _isVolatileEnough() { return true; },
    _isTrending() { return true; },
    _isActiveSession() { return true; },
    _isConfirmed() { return true; },
    analyze() { return null; }
};