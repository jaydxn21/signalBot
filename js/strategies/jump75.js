// js/strategies/jump75.js - v27: OPTIMIZED THRESHOLDS FOR JUMP INDICES
// Based on real Jump 75 Index behavior analysis
// QUALITY mode momentum reduced from 0.30 → 0.22 (realistic)
// ULTRA mode momentum reduced from 0.40 → 0.30

const feedMonitor = {
    _lastPriceTime: {},
    _sessionStartTime: null,
    
    init(symbol) {
        if (!symbol) return;
        if (!this._sessionStartTime) {
            this._sessionStartTime = Date.now();
        }
        if (!this._lastPriceTime[symbol]) {
            this._lastPriceTime[symbol] = Date.now();
        }
    },
    
    isSymbolActive(symbol, currentCandleTime) {
        const now = Date.now();
        const lastTime = this._lastPriceTime[symbol];
        
        let candleTimeMs = currentCandleTime;
        if (candleTimeMs && candleTimeMs < 10000000000) {
            candleTimeMs = candleTimeMs * 1000;
        }
        
        const candleAge = candleTimeMs ? (now - candleTimeMs) : (now - (lastTime || now));
        
        if (candleAge > 15000 && lastTime && lastTime > 0) {
            console.log(`⚠️ ${symbol} feed stale: ${(candleAge/1000).toFixed(1)}s old`);
            return false;
        }
        
        if (candleTimeMs) {
            this._lastPriceTime[symbol] = candleTimeMs;
        } else if (lastTime) {
            this._lastPriceTime[symbol] = now;
        }
        return true;
    },
    
    isSessionStartBufferPassed(bufferMs = 5000) {
        if (!this._sessionStartTime) return true;
        const elapsed = Date.now() - this._sessionStartTime;
        return elapsed >= bufferMs;
    },
    
    resetSession() {
        this._sessionStartTime = Date.now();
        this._lastPriceTime = {};
        console.log(`[FeedMonitor] Session reset`);
    }
};

const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _tradesCount: 0,
    _symbol: null,
    _lastDebugLog: 0,
    
    QUALITY_MODE: 1, // Start with BALANCED
    
    setSymbol(symbol) {
        if (!symbol) {
            console.warn('[Jump75] setSymbol called with null/undefined symbol');
            return;
        }
        this._symbol = symbol;
        feedMonitor.init(symbol);
        console.log(`[Jump75] Symbol initialized: ${symbol}`);
    },
    
    _getModeConfig() {
        const modes = {
            0: { // QUANTITY - Aggressive, many signals
                name: 'QUANTITY',
                displayName: '🚀 QUANTITY (High Frequency)',
                minScore: 48,
                cooldownMs: 25000,
                minMomentum: 0.06,      // Very low threshold
                minRangeATR: 1.5,
                nearFibATR: 1.8,
                requireTrend: false,
                riskPercent: 0.6
            },
            1: { // BALANCED - Default, moderate signals
                name: 'BALANCED',
                displayName: '⚖️ BALANCED (Recommended)',
                minScore: 60,
                cooldownMs: 60000,
                minMomentum: 0.12,      // Realistic for Jump indices
                minRangeATR: 2.0,
                nearFibATR: 1.2,
                requireTrend: false,
                riskPercent: 0.75
            },
            2: { // QUALITY - Selective, fewer signals
                name: 'QUALITY',
                displayName: '🎯 QUALITY (Selective)',
                minScore: 70,
                cooldownMs: 120000,
                minMomentum: 0.22,      // FIXED: Was 0.30 (too high)
                minRangeATR: 2.5,
                nearFibATR: 0.9,
                requireTrend: true,
                riskPercent: 0.7
            },
            3: { // ULTRA - Very selective, rare signals
                name: 'ULTRA',
                displayName: '👑 ULTRA (Very Selective)',
                minScore: 80,
                cooldownMs: 180000,
                minMomentum: 0.30,      // FIXED: Was 0.40 (impossible)
                minRangeATR: 3.0,
                nearFibATR: 0.7,
                requireTrend: true,
                riskPercent: 0.6
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    _calculateEMA(candles, period) {
        if (!candles || candles.length < period + 5) {
            return null;
        }
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    _getM15Trend(m15Candles) {
        if (!m15Candles || m15Candles.length < 21) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        if (latest.close > ema8 && ema8 > ema21) return 'UP';
        if (latest.close < ema8 && ema8 < ema21) return 'DOWN';
        return 'NEUTRAL';
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        const symbol = this._symbol || 'UNKNOWN';
        const now = Date.now();
        
        // Diagnostic every 30 seconds
        if (!this._lastDebugLog || now - this._lastDebugLog > 30000) {
            const config = this._getModeConfig();
            console.log(`[J75] ${symbol} | M5:${m5Candles?.length || 0} M15:${m15Candles?.length || 0} H4:${h4Candles?.length || 0} | Mode:${config.name} (minMom:${config.minMomentum})`);
            this._lastDebugLog = now;
        }

        // Gate 1: Basic candle checks
        if (!m5Candles || m5Candles.length < 30) return null;
        if (!h4Candles || h4Candles.length < 12) return null;
        if (!m15Candles || m15Candles.length < 21) return null;

        const latestCandle = m5Candles[m5Candles.length - 1];
        
        if (!latestCandle || !latestCandle.close || latestCandle.close <= 0) return null;

        if (!feedMonitor.isSymbolActive(symbol, latestCandle.time)) return null;
        if (!feedMonitor.isSessionStartBufferPassed(5000)) return null;

        const config = this._getModeConfig();

        if (this._lastTradeTime > 0 && (now - this._lastTradeTime) < config.cooldownMs) return null;
        if (!atr || atr <= 0 || isNaN(atr)) return null;

        // Calculate range and Fibonacci levels
        const h4High = Math.max(...h4Candles.slice(-12).map(c => c.high));
        const h4Low = Math.min(...h4Candles.slice(-12).map(c => c.low));
        const range = h4High - h4Low;

        if (range < atr * config.minRangeATR) return null;

        const fib618 = h4High - (range * 0.618);
        const fib50 = h4High - (range * 0.5);
        const fib382 = h4High - (range * 0.382);

        const price = latestCandle.close;
        const near618 = Math.abs(price - fib618) < atr * config.nearFibATR;
        const near50 = Math.abs(price - fib50) < atr * config.nearFibATR;
        const near382 = Math.abs(price - fib382) < atr * config.nearFibATR;

        if (!near618 && !near50 && !near382) return null;

        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return null;

        const momentum = (ema8 - ema21) / atr;

        const bullishCandle = latestCandle.close > latestCandle.open;
        const bearishCandle = latestCandle.close < latestCandle.open;
        const strongCandle = Math.abs(latestCandle.close - latestCandle.open) > atr * 0.6;

        const m15Trend = this._getM15Trend(m15Candles);
        const trendOk = !config.requireTrend || 
                       (momentum > 0 && m15Trend === 'UP') || 
                       (momentum < 0 && m15Trend === 'DOWN');

        let signal = null;
        let score = config.minScore;

        // LONG Signal - more permissive momentum check
        if (momentum > config.minMomentum && bullishCandle) {
            if (near618) score += 15;
            else if (near50) score += 10;
            else if (near382) score += 5;
            if (strongCandle) score += 8;
            if (trendOk) score += 5;

            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : '38.2%');
                signal = {
                    type: 'BUY',
                    entry: price,
                    score: Math.min(score, 95),
                    tpMultiplier: 2.0,
                    slMultiplier: 1.0,
                    isJump75: true,
                    mode: zone,
                    factors: [`📈 ${zone} bounce`, `Mom ${momentum.toFixed(2)}`, strongCandle ? 'Strong' : ''].filter(Boolean)
                };
            }
        }

        // SHORT Signal
        if (!signal && momentum < -config.minMomentum && bearishCandle) {
            score = config.minScore;
            if (near618) score += 15;
            else if (near50) score += 10;
            else if (near382) score += 5;
            if (strongCandle) score += 8;
            if (trendOk) score += 5;

            if (score >= config.minScore) {
                const zone = near618 ? '61.8%' : (near50 ? '50%' : '38.2%');
                signal = {
                    type: 'SELL',
                    entry: price,
                    score: Math.min(score, 95),
                    tpMultiplier: 2.0,
                    slMultiplier: 1.0,
                    isJump75: true,
                    mode: zone,
                    factors: [`📉 ${zone} reject`, `Mom ${Math.abs(momentum).toFixed(2)}`, strongCandle ? 'Strong' : ''].filter(Boolean)
                };
            }
        }

        if (signal) {
            this._lastTradeTime = now;
            this._tradesCount++;
            console.log(`✅ [J75] ${signal.type} @ ${price.toFixed(2)} | Score:${signal.score} | ${signal.mode} | Mom:${momentum.toFixed(3)}`);
        }

        return signal;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        const pnl = trade.type === 'BUY' ? currentCandle.close - trade.entry : trade.entry - currentCandle.close;
        const tpDist = Math.abs(trade.tp - trade.entry);
        const slDist = Math.abs(trade.sl - trade.entry);
        
        if (pnl >= tpDist * 0.7) {
            this._consecutiveLosses = 0;
            return { action: 'CLOSE', reason: 'TP' };
        }
        if (pnl <= -slDist * 0.95) {
            this._consecutiveLosses++;
            return { action: 'CLOSE', reason: 'SL' };
        }
        
        if (pnl >= tpDist * 0.5 && !trade.trailSet) {
            const newSL = trade.type === 'BUY' ? trade.entry + (pnl * 0.4) : trade.entry - (pnl * 0.4);
            trade.trailSet = true;
            return { action: 'UPDATE_SL', newSL };
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
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0,
            symbol: this._symbol
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
            0: { ...this._getModeConfig.call({ QUALITY_MODE: 0 }) },
            1: { ...this._getModeConfig.call({ QUALITY_MODE: 1 }) },
            2: { ...this._getModeConfig.call({ QUALITY_MODE: 2 }) },
            3: { ...this._getModeConfig.call({ QUALITY_MODE: 3 }) }
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
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName} (minMomentum: ${config.minMomentum})`);
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
        feedMonitor.resetSession();
    },
    
    resetSession() {
        feedMonitor.resetSession();
    }
};

export { Jump75Strategy };
export default Jump75Strategy;