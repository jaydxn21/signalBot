// js/strategies/jump75.js - v24: SIMPLE MOMENTUM + FIB (WORKS FOR JUMP INDICES)

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _tradesCount: 0,
    
    // Quality mode (0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA)
    QUALITY_MODE: 1,  // Start with BALANCED
    
    _getModeConfig() {
        const modes = {
            0: { // QUANTITY - Many signals (50-100/day)
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                minScore: 50,
                cooldownMs: 30000,      // 30 seconds
                minMomentum: 0.10,
                minRangeATR: 2.0,
                nearFibATR: 1.2,
                requireTrend: false,
                riskPercent: 0.5,
                lotMultiplier: 0.8
            },
            1: { // BALANCED - Good signals (20-40/day)
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                minScore: 60,
                cooldownMs: 60000,      // 1 minute
                minMomentum: 0.20,
                minRangeATR: 2.5,
                nearFibATR: 1.0,
                requireTrend: false,
                riskPercent: 0.75,
                lotMultiplier: 1.0
            },
            2: { // QUALITY - Fewer signals (10-20/day)
                name: 'QUALITY',
                displayName: 'QUALITY (Selective)',
                minScore: 70,
                cooldownMs: 120000,     // 2 minutes
                minMomentum: 0.30,
                minRangeATR: 3.0,
                nearFibATR: 0.8,
                requireTrend: true,
                riskPercent: 0.7,
                lotMultiplier: 0.9
            },
            3: { // ULTRA - Very few signals (3-8/day)
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                minScore: 80,
                cooldownMs: 180000,     // 3 minutes
                minMomentum: 0.40,
                minRangeATR: 3.5,
                nearFibATR: 0.6,
                requireTrend: true,
                riskPercent: 0.6,
                lotMultiplier: 0.7
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        const config = this._getModeConfig();
        
        // Minimum candles check
        if (!m5Candles || m5Candles.length < 20) return null;
        if (!h4Candles || h4Candles.length < 10) return null;
        
        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.cooldownMs * 2) return null;
        
        if (!atr || atr === 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        // Calculate H4 range and Fibonacci levels
        const h4High = Math.max(...h4Candles.slice(-12).map(c => c.high));
        const h4Low = Math.min(...h4Candles.slice(-12).map(c => c.low));
        const range = h4High - h4Low;
        
        if (range < atr * config.minRangeATR) return null;
        
        const fib618 = h4High - (range * 0.618);
        const fib50 = h4High - (range * 0.5);
        const fib382 = h4High - (range * 0.382);
        
        const price = latestM5.close;
        const near618 = Math.abs(price - fib618) < atr * config.nearFibATR;
        const near50 = Math.abs(price - fib50) < atr * config.nearFibATR;
        const near382 = Math.abs(price - fib382) < atr * config.nearFibATR;
        
        // Momentum via EMA crossover
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return null;
        
        const momentum = (ema8 - ema21) / atr;
        
        // Candle patterns
        const bullishCandle = latestM5.close > latestM5.open;
        const bearishCandle = latestM5.close < latestM5.open;
        const strongCandle = Math.abs(latestM5.close - latestM5.open) > atr * 0.6;
        
        // Trend on M15
        const m15Trend = this._getM15Trend(m15Candles);
        const trendOk = !config.requireTrend || (momentum > 0 && m15Trend === 'UP') || (momentum < 0 && m15Trend === 'DOWN');
        
        let signal = null;
        let score = config.minScore;
        
        // LONG signal
        if (momentum > config.minMomentum && bullishCandle) {
            if (near618) score += 15;
            else if (near50) score += 10;
            else if (near382) score += 5;
            
            if (strongCandle) score += 8;
            if (trendOk) score += 5;
            
            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : (near382 ? '38.2%' : 'Support'));
                signal = {
                    type: 'BUY',
                    entry: price,
                    score: Math.min(score, 95),
                    tpMultiplier: 2.0,
                    slMultiplier: 1.0,
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    isJump75: true,
                    factors: [`📈 ${zone} bounce`, `Momentum ${momentum.toFixed(2)}`, strongCandle ? 'Strong candle' : ''].filter(f => f)
                };
            }
        }
        
        // SHORT signal
        if (!signal && momentum < -config.minMomentum && bearishCandle) {
            score = config.minScore;
            
            if (near618) score += 15;
            else if (near50) score += 10;
            else if (near382) score += 5;
            
            if (strongCandle) score += 8;
            if (trendOk) score += 5;
            
            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : (near382 ? '38.2%' : 'Resistance'));
                signal = {
                    type: 'SELL',
                    entry: price,
                    score: Math.min(score, 95),
                    tpMultiplier: 2.0,
                    slMultiplier: 1.0,
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    isJump75: true,
                    factors: [`📉 ${zone} rejection`, `Momentum ${Math.abs(momentum).toFixed(2)}`, strongCandle ? 'Strong candle' : ''].filter(f => f)
                };
            }
        }
        
        if (signal) {
            const slDistance = atr * signal.slMultiplier;
            const tpDistance = atr * signal.tpMultiplier;
            signal.sl = signal.type === 'BUY' ? price - slDistance : price + slDistance;
            signal.tp = signal.type === 'BUY' ? price + tpDistance : price - tpDistance;
            
            this._lastTradeTime = now;
            this._tradesCount++;
            
            console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
            console.log(`   Entry: ${price.toFixed(2)} | TP: ${signal.tp.toFixed(2)} | SL: ${signal.sl.toFixed(2)}`);
            
            return signal;
        }
        
        return null;
    },
    
    _calculateEMA(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    _getM15Trend(m15Candles) {
        if (!m15Candles || m15Candles.length < 10) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        if (latest.close > ema8 && ema8 > ema21) return 'UP';
        if (latest.close < ema8 && ema8 < ema21) return 'DOWN';
        return 'NEUTRAL';
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        if (trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.tp - trade.entry) * (trade.lotSize || 0.01);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.entry - trade.sl) * (trade.lotSize || 0.01);
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.entry - trade.tp) * (trade.lotSize || 0.01);
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.sl - trade.entry) * (trade.lotSize || 0.01);
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            displayName: config.displayName,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            dailyProfit: this._dailyProfit,
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0
        };
    },
    
    getCurrentConfig() {
        return this._getModeConfig();
    },
    
    getCurrentMode() {
        return this.QUALITY_MODE;
    },
    
    getAllModes() {
        return {
            0: this._getModeConfig.call({ QUALITY_MODE: 0 }),
            1: this._getModeConfig.call({ QUALITY_MODE: 1 }),
            2: this._getModeConfig.call({ QUALITY_MODE: 2 }),
            3: this._getModeConfig.call({ QUALITY_MODE: 3 })
        };
    },
    
    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using BALANCED (1).`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName}`);
        console.log(`   Min Score: ${config.minScore} | Min Momentum: ${config.minMomentum}`);
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
    }
};

export default Jump75Strategy;