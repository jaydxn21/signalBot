// js/strategies/jump75.js - v25: FULL FIX (Session Delay + Price Validation + Feed Monitor)

// 🆚 FEED MONITOR MODULE
const feedMonitor = {
    _lastPriceTime: {},
    _sessionStartTime: null,
    
    init(symbol) {
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
        const candleAge = currentCandleTime ? (now - currentCandleTime) : (now - lastTime);
        
        // If no price update in 10 seconds, feed might be dead
        if (candleAge > 10000 && lastTime > 0) {
            console.log(`⚠️ ${symbol} feed stale: ${(candleAge/1000).toFixed(1)}s old`);
            return false;
        }
        
        if (currentCandleTime) {
            this._lastPriceTime[symbol] = currentCandleTime;
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
        console.log(`[FeedMonitor] Session reset at ${new Date().toISOString()}`);
    }
};

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _tradesCount: 0,
    _symbol: null,
    
    // Quality mode (0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA)
    QUALITY_MODE: 1,  // Start with BALANCED
    
    setSymbol(symbol) {
        this._symbol = symbol;
        feedMonitor.init(symbol);
    },
    
    _getModeConfig() {
        const modes = {
            0: { // QUANTITY - Much more aggressive
            name: 'QUANTITY',
            displayName: 'QUANTITY (High Frequency)',
            minScore: 48,           // Lowered
            cooldownMs: 25000,      // Faster entries
            minMomentum: 0.08,      // Much lower threshold
            minRangeATR: 1.5,       // Easier to qualify
            nearFibATR: 1.8,        // Wider fib acceptance
            requireTrend: false,
            riskPercent: 0.6,
            lotMultiplier: 0.9
        },
            1: { // BALANCED
            name: 'BALANCED',
            displayName: 'BALANCED (Recommended)',
            minScore: 60,
            cooldownMs: 60000,
            minMomentum: 0.18,
            minRangeATR: 2.3,
            nearFibATR: 1.2,
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
        // 🆚 FIX 1: Validate price first (QUICK CHECK)
        if (!m5Candles || m5Candles.length < 2) return null;
        
        const latestCandle = m5Candles[m5Candles.length - 1];
        const previousCandle = m5Candles[m5Candles.length - 2];
        
        if (!latestCandle || !latestCandle.close || latestCandle.close <= 0 || isNaN(latestCandle.close)) {
            console.log(`❌ [${this._symbol}] Invalid price in candle: ${latestCandle?.close}`);
            return null;
        }
        
        // 🆚 FIX 2: Check feed is active
        if (!feedMonitor.isSymbolActive(this._symbol, latestCandle.time)) {
            console.log(`⏸️ [${this._symbol}] Skipping — no active feed`);
            return null;
        }
        
        // 🆚 FIX 3: Session startup buffer (don't trade in first 5 seconds)
        if (!feedMonitor.isSessionStartBufferPassed(5000)) {
            // console.log(`⏳ [${this._symbol}] Session startup buffer — waiting`);
            return null;
        }
        
        const config = this._getModeConfig();
        
        // Minimum candles check
        if (!m5Candles || m5Candles.length < 20) return null;
        if (!h4Candles || h4Candles.length < 10) return null;
        
        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.cooldownMs * 2) return null;
        
        if (!atr || atr === 0) return null;
        
        // Calculate H4 range and Fibonacci levels
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
        
        // Momentum via EMA crossover
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return null;
        
        const momentum = (ema8 - ema21) / atr;
        
        // Candle patterns
        const bullishCandle = latestCandle.close > latestCandle.open;
        const bearishCandle = latestCandle.close < latestCandle.open;
        const strongCandle = Math.abs(latestCandle.close - latestCandle.open) > atr * 0.6;
        
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
        
        // 🆚 FIX 4: Price validation with retry (FULL VERSION)
        if (signal) {
            const slDistance = atr * signal.slMultiplier;
            const tpDistance = atr * signal.tpMultiplier;
            
            let validatedPrice = null;
            let priceValid = false;
            
            // Try up to 3 times to get a valid price
            for (let retry = 0; retry < 3; retry++) {
                try {
                    // Get the absolute latest price from the most recent candle
                    const freshCandle = m5Candles[m5Candles.length - 1];
                    
                    if (freshCandle && freshCandle.close && freshCandle.close > 0 && !isNaN(freshCandle.close)) {
                        validatedPrice = freshCandle.close;
                        priceValid = true;
                        break;
                    }
                    
                    // Alternative: Check if there's a newer candle since we started
                    if (retry === 0 && previousCandle && previousCandle.close > 0) {
                        // Use previous candle as fallback on first try
                        validatedPrice = previousCandle.close;
                        priceValid = true;
                        console.log(`⚠️ [${this._symbol}] Using previous candle price: ${validatedPrice}`);
                        break;
                    }
                    
                    if (!priceValid) {
                        console.log(`⚠️ [${this._symbol}] Invalid price — retry ${retry + 1}/3`);
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (err) {
                    console.log(`⚠️ [${this._symbol}] Price check error: ${err.message}`);
                }
            }
            
            // Final validation
            if (!priceValid || !validatedPrice || validatedPrice <= 0 || isNaN(validatedPrice)) {
                console.log(`❌ [${this._symbol}] CRITICAL: Cannot get valid price — ABORTING signal`);
                console.log(`   Original price: ${price}, Validated: ${validatedPrice}`);
                return null;
            }
            
            // Update signal with validated price
            signal.entry = validatedPrice;
            
            // Recalculate SL/TP with validated price
            if (signal.type === 'BUY') {
                signal.sl = validatedPrice - slDistance;
                signal.tp = validatedPrice + tpDistance;
            } else {
                signal.sl = validatedPrice + slDistance;
                signal.tp = validatedPrice - tpDistance;
            }
            
            // Ensure minimum stop distance (broker requirement)
            const minStop = 0.01 * validatedPrice; // 1% minimum
            if (signal.type === 'BUY' && (validatedPrice - signal.sl) < minStop) {
                signal.sl = validatedPrice - minStop;
                console.log(`⚠️ [${this._symbol}] Adjusted SL to minimum: ${minStop.toFixed(2)}`);
            }
            if (signal.type === 'SELL' && (signal.sl - validatedPrice) < minStop) {
                signal.sl = validatedPrice + minStop;
                console.log(`⚠️ [${this._symbol}] Adjusted SL to minimum: ${minStop.toFixed(2)}`);
            }
            
            this._lastTradeTime = now;
            this._tradesCount++;
            
            console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
            console.log(`   Entry: ${validatedPrice.toFixed(2)} | TP: ${signal.tp.toFixed(2)} | SL: ${signal.sl.toFixed(2)} | Risk: ${((Math.abs(validatedPrice - signal.sl) / atr)).toFixed(1)}x ATR`);
            
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
        feedMonitor.resetSession();
    },
    
    resetSession() {
        feedMonitor.resetSession();
    }
};

export default Jump75Strategy;