// js/strategies/range_boundary.js - VERSION 3 (FULL FIX: Session Delay + Price Validation + Feed Monitor)

// 🆚 FEED MONITOR MODULE (same as jump75)
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
        
        if (candleAge > 10000 && lastTime > 0) {
            console.log(`⚠️ [RangeBoundary] ${symbol} feed stale: ${(candleAge/1000).toFixed(1)}s old`);
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
        console.log(`[RangeBoundary] Session reset`);
    }
};

export const RangeBoundaryStrategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _tradesCount: 0,
    _hasOpenPosition: false,
    _symbol: null,
    
    // Quality mode (0=FAST, 1=BALANCED, 2=SAFE)
    QUALITY_MODE: 1,
    
    setSymbol(symbol) {
        this._symbol = symbol;
        feedMonitor.init(symbol);
    },
    
    _getModeConfig() {
        const modes = {
            0: { // FAST - more trades, tighter stops
                name: 'FAST',
                minScore: 55,
                cooldownMs: 60000,
                rsiOverbought: 65,
                rsiOversold: 35,
                tpMultiplier: 1.2,
                slMultiplier: 0.5,
                riskPercent: 0.5,
                lotMultiplier: 0.6
            },
            1: { // BALANCED (DEFAULT)
                name: 'BALANCED',
                minScore: 65,
                cooldownMs: 120000,
                rsiOverbought: 70,
                rsiOversold: 30,
                tpMultiplier: 1.5,
                slMultiplier: 0.6,
                riskPercent: 0.75,
                lotMultiplier: 0.8
            },
            2: { // SAFE - fewer trades, wider stops
                name: 'SAFE',
                minScore: 75,
                cooldownMs: 180000,
                rsiOverbought: 75,
                rsiOversold: 25,
                tpMultiplier: 1.8,
                slMultiplier: 0.7,
                riskPercent: 0.6,
                lotMultiplier: 0.6
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    async checkEntry(candles, rsiState, h4Candles, atr) {
        // 🆚 FIX 1: Validate price first (QUICK CHECK)
        if (!candles || candles.length < 2) return null;
        
        const latestCandle = candles[candles.length - 1];
        const previousCandle = candles[candles.length - 2];
        
        if (!latestCandle || !latestCandle.close || latestCandle.close <= 0 || isNaN(latestCandle.close)) {
            console.log(`❌ [RangeBoundary] Invalid price: ${latestCandle?.close}`);
            return null;
        }
        
        // 🆚 FIX 2: Check feed is active
        if (!feedMonitor.isSymbolActive(this._symbol, latestCandle.time)) {
            console.log(`⏸️ [RangeBoundary] Skipping ${this._symbol} — no active feed`);
            return null;
        }
        
        // 🆚 FIX 3: Session startup buffer
        if (!feedMonitor.isSessionStartBufferPassed(5000)) {
            return null;
        }
        
        // Don't enter with open position
        if (this._hasOpenPosition) return null;
        
        if (!candles || candles.length < 50) return null;
        
        const now = Date.now();
        const config = this._getModeConfig();
        
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.cooldownMs * 2) return null;
        
        const bar = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const prev2 = candles[candles.length - 3];
        if (!bar || !prev) return null;
        
        // Calculate all indicators
        const rsi = this._calculateRSI(candles, rsiState, 14);
        const bb = this._calculateBB(candles, 20, 2);
        const atrValue = atr || this._calculateATR(candles, 14);
        
        if (!bb || !atrValue || rsi === null) return null;
        
        // Calculate additional indicators for confirmation
        const stoch = this._calculateStochastic(candles, 14, 3);
        const macd = this._calculateMACD(candles);
        
        // Price position within Bollinger Bands
        const bbWidth = (bb.upper - bb.lower) / bb.middle;
        const isVolatile = bbWidth > 0.02;  // For Step Index
        
        // Only trade when volatility is normal (not expanding)
        if (isVolatile) return null;
        
        const nearUpper = bar.close > bb.upper - (atrValue * 0.25);
        const nearLower = bar.close < bb.lower + (atrValue * 0.25);
        const atMiddle = Math.abs(bar.close - bb.middle) < atrValue * 0.3;
        
        // Don't trade in the middle - wait for extremes
        if (atMiddle) return null;
        
        // Price extreme detection (how far from recent range)
        const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
        const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
        const range = recentHigh - recentLow;
        const nearRangeHigh = bar.close > recentHigh - (range * 0.15);
        const nearRangeLow = bar.close < recentLow + (range * 0.15);
        
        // Candle patterns (stronger requirements)
        const bullishEngulfing = prev.close < prev.open && 
                                  bar.close > bar.open && 
                                  bar.close > prev.high && 
                                  bar.open < prev.low;
        
        const bearishEngulfing = prev.close > prev.open && 
                                   bar.close < bar.open && 
                                   bar.close < prev.low && 
                                   bar.open > prev.high;
        
        const hammer = (bar.low - Math.min(bar.open, bar.close)) > Math.abs(bar.close - bar.open) * 2 &&
                       (bar.high - Math.max(bar.open, bar.close)) < Math.abs(bar.close - bar.open) * 0.5;
        
        const shootingStar = (bar.high - Math.max(bar.open, bar.close)) > Math.abs(bar.close - bar.open) * 2 &&
                              (bar.low - Math.min(bar.open, bar.close)) < Math.abs(bar.close - bar.open) * 0.5;
        
        // Volume confirmation
        const avgVolume = candles.slice(-10, -1).reduce((s, c) => s + (c.volume || 500), 0) / 9;
        const volumeSpike = (bar.volume || 500) > avgVolume * 1.5;
        
        // Stochastic confirmation
        const stochOversold = stoch && stoch.k < 20;
        const stochOverbought = stoch && stoch.k > 80;
        
        // MACD confirmation
        const macdBullish = macd && macd.histogram > 0 && macd.histogram > macd.prevHistogram;
        const macdBearish = macd && macd.histogram < 0 && macd.histogram < macd.prevHistogram;
        
        let signal = null;
        let score = config.minScore;
        
        // LONG SIGNAL
        if (rsi <= config.rsiOversold && nearLower && nearRangeLow) {
            score = config.minScore;
            
            if (rsi <= config.rsiOversold - 10) score += 10;
            if (bullishEngulfing) score += 15;
            else if (hammer) score += 12;
            else if (bar.close > bar.open) score += 5;
            if (stochOversold) score += 10;
            if (macdBullish) score += 8;
            if (volumeSpike) score += 8;
            
            const downCandles = candles.slice(-3).every(c => c.close < c.open);
            if (downCandles) score += 5;
            
            if (score >= config.minScore) {
                signal = {
                    type: 'BUY',
                    entry: bar.close,
                    score: Math.min(score, 95),
                    tpMultiplier: config.tpMultiplier,
                    slMultiplier: config.slMultiplier,
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    factors: [
                        `RSI oversold (${rsi.toFixed(0)})`,
                        `Near lower BB`,
                        bullishEngulfing ? 'Bullish engulfing' : (hammer ? 'Hammer' : ''),
                        stochOversold ? 'Stoch oversold' : '',
                        volumeSpike ? 'Volume spike' : ''
                    ].filter(f => f)
                };
            }
        }
        
        // SHORT SIGNAL
        if (!signal && rsi >= config.rsiOverbought && nearUpper && nearRangeHigh) {
            score = config.minScore;
            
            if (rsi >= config.rsiOverbought + 10) score += 10;
            if (bearishEngulfing) score += 15;
            else if (shootingStar) score += 12;
            else if (bar.close < bar.open) score += 5;
            if (stochOverbought) score += 10;
            if (macdBearish) score += 8;
            if (volumeSpike) score += 8;
            
            const upCandles = candles.slice(-3).every(c => c.close > c.open);
            if (upCandles) score += 5;
            
            if (score >= config.minScore) {
                signal = {
                    type: 'SELL',
                    entry: bar.close,
                    score: Math.min(score, 95),
                    tpMultiplier: config.tpMultiplier,
                    slMultiplier: config.slMultiplier,
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    factors: [
                        `RSI overbought (${rsi.toFixed(0)})`,
                        `Near upper BB`,
                        bearishEngulfing ? 'Bearish engulfing' : (shootingStar ? 'Shooting star' : ''),
                        stochOverbought ? 'Stoch overbought' : '',
                        volumeSpike ? 'Volume spike' : ''
                    ].filter(f => f)
                };
            }
        }
        
        // 🆚 FIX 4: Price validation with retry
        if (signal) {
            const slDistance = atrValue * signal.slMultiplier;
            const tpDistance = atrValue * signal.tpMultiplier;
            
            let validatedPrice = null;
            let priceValid = false;
            
            for (let retry = 0; retry < 3; retry++) {
                try {
                    const freshCandle = candles[candles.length - 1];
                    
                    if (freshCandle && freshCandle.close && freshCandle.close > 0 && !isNaN(freshCandle.close)) {
                        validatedPrice = freshCandle.close;
                        priceValid = true;
                        break;
                    }
                    
                    if (retry === 0 && previousCandle && previousCandle.close > 0) {
                        validatedPrice = previousCandle.close;
                        priceValid = true;
                        console.log(`⚠️ [RangeBoundary] Using previous candle price: ${validatedPrice}`);
                        break;
                    }
                    
                    if (!priceValid) {
                        console.log(`⚠️ [RangeBoundary] Invalid price — retry ${retry + 1}/3`);
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (err) {
                    console.log(`⚠️ [RangeBoundary] Price check error: ${err.message}`);
                }
            }
            
            if (!priceValid || !validatedPrice || validatedPrice <= 0 || isNaN(validatedPrice)) {
                console.log(`❌ [RangeBoundary] CRITICAL: Cannot get valid price — ABORTING signal`);
                return null;
            }
            
            signal.entry = validatedPrice;
            
            if (signal.type === 'BUY') {
                signal.sl = validatedPrice - slDistance;
                signal.tp = validatedPrice + tpDistance;
            } else {
                signal.sl = validatedPrice + slDistance;
                signal.tp = validatedPrice - tpDistance;
            }
            
            // Ensure minimum stop distance
            const minStop = 10;
            if (signal.type === 'BUY' && (validatedPrice - signal.sl) < minStop) {
                signal.sl = validatedPrice - minStop;
            }
            if (signal.type === 'SELL' && (signal.sl - validatedPrice) < minStop) {
                signal.sl = validatedPrice + minStop;
            }
            
            this._lastTradeTime = now;
            this._tradesCount++;
            this._hasOpenPosition = true;
            
            console.log(`[RangeBoundary ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
            console.log(`   Entry: ${signal.entry.toFixed(2)} | TP: ${signal.tp.toFixed(2)} | SL: ${signal.sl.toFixed(2)} | Risk: ${(Math.abs(signal.entry - signal.sl) / atrValue).toFixed(1)}x ATR`);
            
            return signal;
        }
        
        return null;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        let closed = false;
        let outcome = null;
        
        if (trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.tp - trade.entry) * (trade.lotSize || 0.01);
                closed = true;
                outcome = 'TP';
                console.log(`✅ [RangeBoundary] TP hit! Profit: $${((trade.tp - trade.entry) * (trade.lotSize || 0.01)).toFixed(2)}`);
            } else if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.entry - trade.sl) * (trade.lotSize || 0.01);
                closed = true;
                outcome = 'SL';
                console.log(`❌ [RangeBoundary] SL hit. Loss: $${((trade.entry - trade.sl) * (trade.lotSize || 0.01)).toFixed(2)}`);
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.entry - trade.tp) * (trade.lotSize || 0.01);
                closed = true;
                outcome = 'TP';
                console.log(`✅ [RangeBoundary] TP hit! Profit: $${((trade.entry - trade.tp) * (trade.lotSize || 0.01)).toFixed(2)}`);
            } else if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.sl - trade.entry) * (trade.lotSize || 0.01);
                closed = true;
                outcome = 'SL';
                console.log(`❌ [RangeBoundary] SL hit. Loss: $${((trade.sl - trade.entry) * (trade.lotSize || 0.01)).toFixed(2)}`);
            }
        }
        
        if (closed) {
            this._hasOpenPosition = false;
            return { action: 'CLOSE', reason: outcome };
        }
        
        // Partial profit taking (move SL to breakeven after 50% profit)
        if (!closed && trade.type === 'BUY' && currentCandle.high >= trade.entry + (trade.tp - trade.entry) * 0.5) {
            const newSL = trade.entry;
            if (newSL > trade.sl) {
                trade.sl = newSL;
                console.log(`📈 [RangeBoundary] Moved SL to breakeven at ${newSL.toFixed(2)}`);
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        }
        
        if (!closed && trade.type === 'SELL' && currentCandle.low <= trade.entry - (trade.entry - trade.tp) * 0.5) {
            const newSL = trade.entry;
            if (newSL < trade.sl) {
                trade.sl = newSL;
                console.log(`📈 [RangeBoundary] Moved SL to breakeven at ${newSL.toFixed(2)}`);
                return { action: 'UPDATE_SL', newSL: newSL };
            }
        }
        
        return null;
    },
    
    _calculateRSI(candles, state, period = 14) {
        if (candles.length < period + 1) return null;
        
        let gains = 0, losses = 0;
        const slice = candles.slice(-period - 1);
        
        for (let i = 1; i < slice.length; i++) {
            const change = slice[i].close - slice[i - 1].close;
            if (change >= 0) gains += change;
            else losses -= change;
        }
        
        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    },
    
    _calculateBB(candles, period = 20, stdDev = 2) {
        if (candles.length < period) return null;
        
        const slice = candles.slice(-period);
        const closes = slice.map(c => c.close);
        const mean = closes.reduce((a, b) => a + b, 0) / period;
        const variance = closes.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
        const std = Math.sqrt(variance);
        
        return {
            upper: mean + (std * stdDev),
            lower: mean - (std * stdDev),
            middle: mean
        };
    },
    
    _calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return null;
        
        let atr = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
            atr += tr;
        }
        return atr / period;
    },
    
    _calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
        if (candles.length < kPeriod) return null;
        
        const slice = candles.slice(-kPeriod);
        const high = Math.max(...slice.map(c => c.high));
        const low = Math.min(...slice.map(c => c.low));
        const close = slice[slice.length - 1].close;
        
        if (high === low) return { k: 50, d: 50 };
        
        const k = ((close - low) / (high - low)) * 100;
        
        return { k: k, d: k };
    },
    
    _calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (candles.length < slowPeriod + signalPeriod) return null;
        
        const closes = candles.map(c => c.close);
        
        const emaFast = this._calculateEMAFromArray(closes, fastPeriod);
        const emaSlow = this._calculateEMAFromArray(closes, slowPeriod);
        
        if (emaFast === null || emaSlow === null) return null;
        
        const macdLine = emaFast - emaSlow;
        
        const macdValues = [];
        for (let i = slowPeriod; i < closes.length; i++) {
            const f = this._calculateEMAFromArray(closes.slice(0, i + 1), fastPeriod);
            const s = this._calculateEMAFromArray(closes.slice(0, i + 1), slowPeriod);
            macdValues.push(f - s);
        }
        
        const signalLine = this._calculateEMAFromArray(macdValues, signalPeriod);
        const histogram = macdValues[macdValues.length - 1] - (signalLine || 0);
        const prevHistogram = macdValues.length > 1 ? macdValues[macdValues.length - 2] - (signalLine || 0) : 0;
        
        return {
            macd: macdValues[macdValues.length - 1],
            signal: signalLine,
            histogram: histogram,
            prevHistogram: prevHistogram
        };
    },
    
    _calculateEMAFromArray(values, period) {
        if (values.length < period) return null;
        const k = 2 / (period + 1);
        let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    },
    
    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            dailyProfit: this._dailyProfit,
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0,
            symbol: this._symbol
        };
    },
    
    setMode(modeNumber) {
        if (![0, 1, 2].includes(modeNumber)) return false;
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[RangeBoundary] Mode set to ${config.name}`);
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
        this._hasOpenPosition = false;
        feedMonitor.resetSession();
    },
    
    resetSession() {
        feedMonitor.resetSession();
    }
};

export default RangeBoundaryStrategy;