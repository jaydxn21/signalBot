// momentum.js — Momentum Strategy with AUTO-CALCULATED SL/TP (v2.1)
// 
// AUTO FEATURES:
//   - Dynamic stop/target based on current ATR (no hardcoded pips)
//   - Volatility-based position sizing
//   - Session-specific volatility adjustment
//   - Auto R:R optimization (targets 1:1.8 to 1:2.5 based on volatility)

import { StructureEngine } from '../structure-engine.js';

export const MomentumStrategy = {
    
    _tradeCount: 0,
    _sessionStart: null,
    _currentSession: null,
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _rollingVolatility: {},  // Store volatility per symbol
    
    // ─────────────────────────────────────────────────────────────
    // AUTO-CALCULATED PAIR CONFIGURATION
    // These are MINIMUM/MAXIMUM limits, not fixed values
    // ─────────────────────────────────────────────────────────────
    _pairConfig: {
        // Major Pairs
        'EURUSD': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.75,
            session: 'ALL',
            minSpread: 0.0001,
            maxSpread: 0.0003,
            // AUTO limits (not fixed values)
            minStopATR: 0.8,      // Minimum stop in ATR multiples
            maxStopATR: 1.5,      // Maximum stop in ATR multiples
            minTargetATR: 1.5,    // Minimum target in ATR multiples
            maxTargetATR: 3.0,    // Maximum target in ATR multiples
            targetRR: 1.8         // Desired R:R (will adjust within limits)
        },
        'GBPUSD': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.75,
            session: 'OVERLAP',
            minSpread: 0.0001,
            maxSpread: 0.00035,
            minStopATR: 0.9,
            maxStopATR: 1.6,
            minTargetATR: 1.8,
            maxTargetATR: 3.2,
            targetRR: 2.0
        },
        'USDJPY': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.7,
            session: 'ASIAN',
            minSpread: 0.01,
            maxSpread: 0.025,
            minStopATR: 0.8,
            maxStopATR: 1.5,
            minTargetATR: 1.5,
            maxTargetATR: 2.8,
            targetRR: 1.8
        },
        'AUDUSD': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 50, 
            riskPercent: 0.7,
            session: 'ASIAN',
            minSpread: 0.0001,
            maxSpread: 0.00025,
            minStopATR: 0.7,
            maxStopATR: 1.4,
            minTargetATR: 1.3,
            maxTargetATR: 2.5,
            targetRR: 1.8
        },
        'USDCAD': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 50, 
            riskPercent: 0.7,
            session: 'NY',
            minSpread: 0.0001,
            maxSpread: 0.00025,
            minStopATR: 0.7,
            maxStopATR: 1.4,
            minTargetATR: 1.3,
            maxTargetATR: 2.5,
            targetRR: 1.8
        },
        'USDCHF': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 50, 
            riskPercent: 0.7,
            session: 'LONDON',
            minSpread: 0.0001,
            maxSpread: 0.0003,
            minStopATR: 0.8,
            maxStopATR: 1.5,
            minTargetATR: 1.5,
            maxTargetATR: 2.8,
            targetRR: 1.8
        },
        
        // Cross Pairs
        'EURGBP': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 50, 
            riskPercent: 0.65,
            session: 'LONDON',
            minSpread: 0.0001,
            maxSpread: 0.00035,
            minStopATR: 0.7,
            maxStopATR: 1.3,
            minTargetATR: 1.2,
            maxTargetATR: 2.2,
            targetRR: 1.7
        },
        'GBPJPY': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.6,
            session: 'OVERLAP',
            minSpread: 0.015,
            maxSpread: 0.04,
            minStopATR: 1.0,
            maxStopATR: 1.8,
            minTargetATR: 1.8,
            maxTargetATR: 3.5,
            targetRR: 2.0
        },
        'EURJPY': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.65,
            session: 'ASIAN',
            minSpread: 0.01,
            maxSpread: 0.03,
            minStopATR: 0.9,
            maxStopATR: 1.6,
            minTargetATR: 1.6,
            maxTargetATR: 3.0,
            targetRR: 1.8
        },
        
        'default': { 
            enabled: true, 
            bias: 'BOTH', 
            minStructureScore: 55, 
            riskPercent: 0.7,
            session: 'ALL',
            minSpread: 0.0001,
            maxSpread: 0.0005,
            minStopATR: 0.8,
            maxStopATR: 1.5,
            minTargetATR: 1.5,
            maxTargetATR: 2.8,
            targetRR: 1.8
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // SESSION VOLATILITY MULTIPLIERS (Auto-adjusts to market conditions)
    // ─────────────────────────────────────────────────────────────
    _sessionMultipliers: {
        'ASIAN':    { stopMultiplier: 0.9, targetMultiplier: 0.85 },  // Lower volatility
        'LONDON':   { stopMultiplier: 1.0, targetMultiplier: 1.0 },   // Baseline
        'NY':       { stopMultiplier: 1.1, targetMultiplier: 1.15 },  // Higher volatility
        'OVERLAP':  { stopMultiplier: 1.2, targetMultiplier: 1.25 },  // Highest volatility
        'OFF_HOURS':{ stopMultiplier: 0.7, targetMultiplier: 0.6 },   // Very low
        'WEEKEND':  { stopMultiplier: 0,   targetMultiplier: 0 }       // No trading
    },
    
    // ─────────────────────────────────────────────────────────────
    // AUTO-CALCULATE OPTIMAL STOP/TARGET BASED ON CURRENT VOLATILITY
    // ─────────────────────────────────────────────────────────────
    _calculateOptimalSLTP(atr, cfg, currentSession, volatilityPercentile = 50) {
        // Get base multipliers from config
        let stopATR = cfg.minStopATR + (cfg.maxStopATR - cfg.minStopATR) * (volatilityPercentile / 100);
        let targetATR = cfg.minTargetATR + (cfg.maxTargetATR - cfg.minTargetATR) * (volatilityPercentile / 100);
        
        // Apply session multiplier
        const sessionMult = this._sessionMultipliers[currentSession] || this._sessionMultipliers['LONDON'];
        stopATR = stopATR * sessionMult.stopMultiplier;
        targetATR = targetATR * sessionMult.targetMultiplier;
        
        // Ensure minimums
        stopATR = Math.max(cfg.minStopATR, Math.min(cfg.maxStopATR, stopATR));
        targetATR = Math.max(cfg.minTargetATR, Math.min(cfg.maxTargetATR, targetATR));
        
        // Calculate actual prices
        const stopDistance = atr * stopATR;
        const targetDistance = atr * targetATR;
        const actualRR = targetDistance / stopDistance;
        
        return {
            stopDistance,
            targetDistance,
            stopATR,
            targetATR,
            actualRR,
            sessionMultiplier: sessionMult.stopMultiplier
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // CALCULATE VOLATILITY PERCENTILE (How volatile is current market)
    // ─────────────────────────────────────────────────────────────
    _calculateVolatilityPercentile(candles, symbol) {
        if (candles.length < 30) return 50; // Default mid
        
        // Calculate recent ATR values
        const atrValues = [];
        for (let i = candles.length - 30; i < candles.length; i++) {
            if (i < 1) continue;
            const periodCandles = candles.slice(Math.max(0, i - 14), i);
            if (periodCandles.length < 14) continue;
            
            const trs = [];
            for (let j = 1; j < periodCandles.length; j++) {
                const c = periodCandles[j], p = periodCandles[j - 1];
                trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
            }
            if (trs.length > 0) {
                atrValues.push(trs.reduce((a, b) => a + b, 0) / trs.length);
            }
        }
        
        if (atrValues.length < 10) return 50;
        
        // Get current ATR
        const currentATR = atrValues[atrValues.length - 1];
        
        // Sort and find percentile
        const sorted = [...atrValues].sort((a, b) => a - b);
        const index = sorted.findIndex(v => v >= currentATR);
        const percentile = (index / sorted.length) * 100;
        
        // Store for future reference
        this._rollingVolatility[symbol] = {
            currentATR,
            percentile,
            lastUpdate: Date.now(),
            recentATRs: atrValues.slice(-10)
        };
        
        return Math.min(90, Math.max(10, percentile));
    },
    
    // ─────────────────────────────────────────────────────────────
    // SESSION DETECTION
    // ─────────────────────────────────────────────────────────────
    _getCurrentSession() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay();
        
        if (utcDay === 0 || utcDay === 6) return 'WEEKEND';
        
        const isAsian = utcHour >= 0 && utcHour < 8;
        const isLondon = utcHour >= 8 && utcHour < 17;
        const isNY = utcHour >= 13 && utcHour < 22;
        
        if (isLondon && isNY) return 'OVERLAP';
        if (isLondon) return 'LONDON';
        if (isNY) return 'NY';
        if (isAsian) return 'ASIAN';
        
        return 'OFF_HOURS';
    },
    
    _isSessionActive(session) {
        const current = this._getCurrentSession();
        if (session === 'ALL') return current !== 'WEEKEND' && current !== 'OFF_HOURS';
        if (session === 'OVERLAP') return current === 'OVERLAP';
        if (session === 'LONDON') return current === 'LONDON';
        if (session === 'NY') return current === 'NY';
        if (session === 'ASIAN') return current === 'ASIAN';
        return false;
    },
    
    // ─────────────────────────────────────────────────────────────
    // SPREAD CHECK
    // ─────────────────────────────────────────────────────────────
    _checkSpread(candles, cfg) {
        if (!candles || candles.length < 5) return false;
        const recent = candles.slice(-5);
        const avgSpread = recent.reduce((sum, c) => sum + (c.high - c.low), 0) / 5;
        
        if (avgSpread > cfg.maxSpread) {
            console.log(`[Momentum] Spread too high: ${(avgSpread * 10000).toFixed(1)} pips > ${(cfg.maxSpread * 10000).toFixed(1)}`);
            return false;
        }
        return true;
    },
    
    // ─────────────────────────────────────────────────────────────
    // INDICATORS
    // ─────────────────────────────────────────────────────────────
    _ema(candles, period, field = 'close') {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b[field], 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i][field] * k + ema * (1 - k);
        }
        return ema;
    },
    
    _rsi(candles, period = 14) {
        if (candles.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const change = candles[i].close - candles[i - 1].close;
            if (change >= 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
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
        return body > atr * 0.35;
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
    
    _isPinBar(candle, atr) {
        const body = Math.abs(candle.close - candle.open);
        const upperWick = candle.high - Math.max(candle.close, candle.open);
        const lowerWick = Math.min(candle.close, candle.open) - candle.low;
        const bodyRatio = body / (body + upperWick + lowerWick);
        
        if (bodyRatio < 0.3) {
            if (upperWick > body * 2) return 'REJECTION_HIGH';
            if (lowerWick > body * 2) return 'REJECTION_LOW';
        }
        return null;
    },
    
    _getTrendStrength(candles) {
        const ema8 = this._ema(candles, 8);
        const ema21 = this._ema(candles, 21);
        const ema50 = this._ema(candles, 50);
        
        if (!ema8 || !ema21 || !ema50) return { direction: null, strength: 0 };
        
        const bullAlign = ema8 > ema21 && ema21 > ema50;
        const bearAlign = ema8 < ema21 && ema21 < ema50;
        
        let strength = 0;
        if (bullAlign) strength = 75;
        else if (bearAlign) strength = 75;
        else if (ema8 > ema21) strength = 55;
        else if (ema8 < ema21) strength = 55;
        else strength = 40;
        
        return {
            direction: ema8 > ema21 ? 'BULL' : 'BEAR',
            strength: strength,
            ema8, ema21, ema50
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // MAIN ENTRY FUNCTION (AUTO-CALCULATED)
    // ─────────────────────────────────────────────────────────────
    checkEntry(candles, atr, symbol = '', dailyCandles = [], weeklyCandles = [], h4Candles = []) {
        if (!atr || candles.length < 30) return null;
        
        // Get pair config
        const cfg = this._pairConfig[symbol] || this._pairConfig['default'];
        if (!cfg.enabled) return null;
        
        // Check session
        if (!this._isSessionActive(cfg.session)) {
            return null;
        }
        
        // Check spread
        if (!this._checkSpread(candles, cfg)) return null;
        
        // Check cooldown after consecutive losses
        if (this._consecutiveLosses >= 3) {
            return null;
        }
        
        // Limit trades per session
        const currentSession = this._getCurrentSession();
        if (this._sessionStart !== currentSession) {
            this._tradeCount = 0;
            this._sessionStart = currentSession;
        }
        if (this._tradeCount >= 3) return null;
        
        // ── CALCULATE CURRENT VOLATILITY PERCENTILE ────────────
        const volatilityPercentile = this._calculateVolatilityPercentile(candles, symbol);
        
        // ── AUTO-CALCULATE OPTIMAL SL/TP ───────────────────────
        const optimalSLTP = this._calculateOptimalSLTP(atr, cfg, currentSession, volatilityPercentile);
        
        // ── GET STRUCTURE MAP ──────────────────────────────────
        let structureMap;
        try {
            const structCandles = (h4Candles && h4Candles.length > 50) ? h4Candles : dailyCandles;
            structureMap = StructureEngine.getStructureMap(structCandles, dailyCandles, weeklyCandles);
        } catch(e) {
            return this._momentumOnlyEntry(candles, atr, symbol, cfg, optimalSLTP);
        }
        
        const price = candles[candles.length - 1].close;
        const position = structureMap ? structureMap.getPricePosition(price) : 'MID_RANGE';
        
        // ── STRUCTURE FILTER ───────────────────────────────────
        let allowedBias = null;
        let structureScore = 0;
        
        if (cfg.bias === 'BOTH') {
            if (position === 'SUPPORT') {
                allowedBias = 'BUY';
                structureScore = 70;
            } else if (position === 'RESISTANCE') {
                allowedBias = 'SELL';
                structureScore = 70;
            } else if (position === 'BREAKOUT_UP') {
                allowedBias = 'BUY';
                structureScore = 65;
            } else if (position === 'BREAKOUT_DOWN') {
                allowedBias = 'SELL';
                structureScore = 65;
            } else if (position === 'MID_RANGE') {
                const trend = this._getTrendStrength(candles.slice(0, -1));
                if (trend.direction === 'BULL') allowedBias = 'BUY';
                else if (trend.direction === 'BEAR') allowedBias = 'SELL';
                structureScore = 50;
            }
        } else if (cfg.bias === 'SHORT') {
            if (position === 'RESISTANCE' || position === 'BREAKOUT_DOWN' || position === 'MID_RANGE') {
                allowedBias = 'SELL';
                structureScore = position === 'RESISTANCE' ? 70 : 55;
            }
        } else if (cfg.bias === 'LONG') {
            if (position === 'SUPPORT' || position === 'BREAKOUT_UP' || position === 'MID_RANGE') {
                allowedBias = 'BUY';
                structureScore = position === 'SUPPORT' ? 70 : 55;
            }
        }
        
        if (!allowedBias) return null;
        if (structureScore < cfg.minStructureScore) return null;
        
        // ── MOMENTUM CONFIRMATION ──────────────────────────────
        const c1 = candles[candles.length - 4];
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        
        if (!c1 || !c2 || !c3) return null;
        
        const { bullEngulf, bearEngulf } = this._isEngulfing(c2, c3);
        const pinBar = this._isPinBar(c3, atr);
        const bigBullBody = c3.close > c3.open && this._isBigBody(c3, atr);
        const bigBearBody = c3.close < c3.open && this._isBigBody(c3, atr);
        
        const rsi = this._rsi(candles);
        if (rsi && ((allowedBias === 'BUY' && rsi > 75) || (allowedBias === 'SELL' && rsi < 25))) {
            return null;
        }
        
        let momentumScore = 0;
        if (allowedBias === 'BUY') {
            if (bullEngulf) momentumScore += 35;
            if (bigBullBody) momentumScore += 30;
            if (pinBar === 'REJECTION_LOW') momentumScore += 25;
            if (c3.close > c3.open && c2.close > c2.open) momentumScore += 15;
        } else {
            if (bearEngulf) momentumScore += 35;
            if (bigBearBody) momentumScore += 30;
            if (pinBar === 'REJECTION_HIGH') momentumScore += 25;
            if (c3.close < c3.open && c2.close < c2.open) momentumScore += 15;
        }
        
        if (momentumScore < 40) return null;
        
        // ── TREND CONFIRMATION ─────────────────────────────────
        const trend = this._getTrendStrength(candles.slice(0, -1));
        const trendAlign = (allowedBias === 'BUY' && trend.direction === 'BULL') ||
                          (allowedBias === 'SELL' && trend.direction === 'BEAR');
        
        if (!trendAlign && momentumScore < 55) return null;
        
        // ── APPLY AUTO-CALCULATED SL/TP ────────────────────────
        let sl, tp, risk, reward;
        
        if (allowedBias === 'BUY') {
            sl = price - optimalSLTP.stopDistance;
            tp = price + optimalSLTP.targetDistance;
        } else {
            sl = price + optimalSLTP.stopDistance;
            tp = price - optimalSLTP.targetDistance;
        }
        
        risk = Math.abs(price - sl);
        reward = Math.abs(tp - price);
        
        // If structure provides better levels, use them
        if (structureMap && structureMap.dailyLevels && reward / risk < optimalSLTP.actualRR * 0.8) {
            // Try structure-based levels
            if (allowedBias === 'BUY' && structureMap.dailyLevels.dailyHigh) {
                const structTP = structureMap.dailyLevels.dailyHigh;
                const structReward = structTP - price;
                if (structReward / risk > optimalSLTP.actualRR) {
                    tp = structTP;
                    reward = structReward;
                }
            } else if (allowedBias === 'SELL' && structureMap.dailyLevels.dailyLow) {
                const structTP = structureMap.dailyLevels.dailyLow;
                const structReward = price - structTP;
                if (structReward / risk > optimalSLTP.actualRR) {
                    tp = structTP;
                    reward = structReward;
                }
            }
        }
        
        const finalRR = reward / risk;
        
        if (finalRR < 1.2) return null;
        
        // ── PARTIAL LEVELS ─────────────────────────────────────
        const partialLevel1 = allowedBias === 'BUY' ? price + (reward * 0.5) : price - (reward * 0.5);
        const partialLevel2 = allowedBias === 'BUY' ? price + (reward * 0.75) : price - (reward * 0.75);
        
        // ── RECORD TRADE ───────────────────────────────────────
        this._lastTradeTime = Date.now();
        this._tradeCount++;
        
        const factors = [
            `${position || 'MID'} ${allowedBias}`,
            `Momentum: ${momentumScore}`,
            `R:R ${finalRR.toFixed(1)}:1`,
            `Vol: ${Math.round(volatilityPercentile)}%`,
            `Stop: ${(optimalSLTP.stopDistance / atr).toFixed(1)}× ATR`,
            `Session: ${currentSession}`
        ];
        
        console.log(`[Momentum] 📍 ${allowedBias} on ${symbol} | ${factors.join(' · ')}`);
        console.log(`   → SL: ${optimalSLTP.stopDistance.toFixed(5)} (${optimalSLTP.stopATR.toFixed(1)}× ATR) | TP: ${optimalSLTP.targetDistance.toFixed(5)} (${optimalSLTP.targetATR.toFixed(1)}× ATR) | Actual RR: ${finalRR.toFixed(1)}:1`);
        
        return {
            type: allowedBias,
            label: `MOMENTUM ${allowedBias} [${position || 'MID'}]`,
            score: Math.min(85, 50 + momentumScore),
            factors: factors,
            tpMultiplier: optimalSLTP.targetATR,
            slMultiplier: optimalSLTP.stopATR,
            isMomentum: true,
            pairConfig: cfg,
            partialLevels: [partialLevel1, partialLevel2],
            _meta: { 
                position, 
                rr: finalRR, 
                sl, 
                tp, 
                price, 
                session: currentSession, 
                momentumScore,
                volatilityPercentile,
                stopATR: optimalSLTP.stopATR,
                targetATR: optimalSLTP.targetATR,
                sessionMultiplier: optimalSLTP.sessionMultiplier
            }
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // FALLBACK: Momentum-only with AUTO CALCULATION
    // ─────────────────────────────────────────────────────────────
    _momentumOnlyEntry(candles, atr, symbol, cfg, optimalSLTP) {
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        
        if (!c2 || !c3) return null;
        
        const { bullEngulf, bearEngulf } = this._isEngulfing(c2, c3);
        const pinBar = this._isPinBar(c3, atr);
        const bigBullBody = c3.close > c3.open && this._isBigBody(c3, atr);
        const bigBearBody = c3.close < c3.open && this._isBigBody(c3, atr);
        
        let allowedBias = null;
        let momentumScore = 0;
        
        if (bullEngulf || bigBullBody || pinBar === 'REJECTION_LOW') {
            allowedBias = 'BUY';
            if (bullEngulf) momentumScore = 45;
            else if (bigBullBody) momentumScore = 40;
            else momentumScore = 35;
        } else if (bearEngulf || bigBearBody || pinBar === 'REJECTION_HIGH') {
            allowedBias = 'SELL';
            if (bearEngulf) momentumScore = 45;
            else if (bigBearBody) momentumScore = 40;
            else momentumScore = 35;
        }
        
        if (!allowedBias) return null;
        if (momentumScore < 40) return null;
        
        const price = candles[candles.length - 1].close;
        const sl = allowedBias === 'BUY' ? price - optimalSLTP.stopDistance : price + optimalSLTP.stopDistance;
        const tp = allowedBias === 'BUY' ? price + optimalSLTP.targetDistance : price - optimalSLTP.targetDistance;
        const finalRR = optimalSLTP.actualRR;
        
        console.log(`[Momentum] 📍 FALLBACK ${allowedBias} on ${symbol} | Momentum only | RR: ${finalRR.toFixed(1)}:1`);
        
        return {
            type: allowedBias,
            label: `MOMENTUM ${allowedBias} [FALLBACK]`,
            score: 55,
            factors: [`Momentum only`, `Auto stop: ${optimalSLTP.stopATR.toFixed(1)}× ATR`],
            tpMultiplier: optimalSLTP.targetATR,
            slMultiplier: optimalSLTP.stopATR,
            isMomentum: true,
            pairConfig: cfg,
            _meta: { rr: finalRR, sl, tp, price, momentumScore, optimalSLTP }
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // TRAILING STOP CALCULATION
    // ─────────────────────────────────────────────────────────────
    calculateTrailingStop(entryPrice, currentPrice, type, atr, highestPrice, lowestPrice) {
        const profit = type === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
        const profitPips = profit / atr;
        
        if (profitPips < 1.0) return null;
        
        let trailDistance;
        if (profitPips >= 2.0) trailDistance = atr * 0.75;
        else if (profitPips >= 1.5) trailDistance = atr * 0.5;
        else trailDistance = atr * 0.35;
        
        if (type === 'BUY') {
            const newSL = currentPrice - trailDistance;
            if (newSL > entryPrice && newSL > (highestPrice - trailDistance)) {
                return newSL;
            }
        } else {
            const newSL = currentPrice + trailDistance;
            if (newSL < entryPrice && newSL < (lowestPrice + trailDistance)) {
                return newSL;
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // UTILITY METHODS
    // ─────────────────────────────────────────────────────────────
    registerLoss() {
        this._consecutiveLosses++;
    },
    
    registerWin() {
        this._consecutiveLosses = 0;
    },
    
    resetCooldown() {
        this._consecutiveLosses = 0;
        this._tradeCount = 0;
        this._sessionStart = null;
    },
    
    getCurrentVolatility(symbol) {
        return this._rollingVolatility[symbol] || null;
    },
    
    // Legacy compatibility
    _isVolatileEnough() { return true; },
    _isTrending() { return true; },
    _isActiveSession() { return true; },
    _isConfirmed() { return true; },
    analyze() { return null; }
};