// js/strategies/range_boundary.js - WITH POSITION MANAGEMENT

export const RangeBoundaryStrategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _tradesCount: 0,
    
    // ← ADD THIS: Track if we have an open position
    _hasOpenPosition: false,
    _currentTicket: null,
    
    // Quality mode (0=QUANTITY, 1=BALANCED, 2=QUALITY)
    QUALITY_MODE: 1,
    
    _getModeConfig() {
        const modes = {
            0: {
                name: 'QUANTITY',
                minScore: 50,
                cooldownMs: 60000,
                rsiOverbought: 60,
                rsiOversold: 40,
                riskPercent: 0.5,
                lotMultiplier: 0.8
            },
            1: {
                name: 'BALANCED',
                minScore: 60,
                cooldownMs: 120000,
                rsiOverbought: 65,
                rsiOversold: 35,
                riskPercent: 0.75,
                lotMultiplier: 1.0
            },
            2: {
                name: 'QUALITY',
                minScore: 70,
                cooldownMs: 180000,
                rsiOverbought: 70,
                rsiOversold: 30,
                riskPercent: 0.6,
                lotMultiplier: 0.7
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    async checkEntry(candles, rsiState, h4Candles, atr) {
        const config = this._getModeConfig();
        
        if (!candles || candles.length < 30) return null;
        
        // ← ADD THIS: Don't enter if we already have an open position
        if (this._hasOpenPosition) {
            console.log(`[RangeBoundary] Skipping entry - already have open position`);
            return null;
        }
        
        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 2 && now - this._lastTradeTime < config.cooldownMs * 2) return null;
        
        const bar = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        if (!bar || !prev) return null;
        
        const rsi = this._calculateRSI(candles, rsiState, 14);
        const bb = this._calculateBB(candles, 20, 2);
        const atrValue = atr || this._calculateATR(candles, 14);
        if (!bb || !atrValue) return null;
        
        const nearUpper = bar.close > bb.upper - (atrValue * 0.3);
        const nearLower = bar.close < bb.lower + (atrValue * 0.3);
        
        const bullishReversal = prev.close < prev.open && bar.close > bar.open;
        const bearishReversal = prev.close > prev.open && bar.close < bar.open;
        const longLowerWick = (bar.low - Math.min(bar.open, bar.close)) > Math.abs(bar.close - bar.open) * 1.5;
        const longUpperWick = (bar.high - Math.max(bar.open, bar.close)) > Math.abs(bar.close - bar.open) * 1.5;
        
        const avgVolume = candles.slice(-10, -1).reduce((s, c) => s + (c.volume || 500), 0) / 9;
        const volumeSpike = (bar.volume || 500) > avgVolume * 1.3;
        
        let signal = null;
        let score = config.minScore;
        
        // LONG SIGNAL
        if (rsi !== null && rsi <= config.rsiOversold && nearLower) {
            score = config.minScore;
            if (rsi <= config.rsiOversold - 10) score += 10;
            if (bullishReversal) score += 10;
            if (longLowerWick) score += 8;
            if (volumeSpike) score += 5;
            
            if (score >= config.minScore) {
                signal = {
                    type: 'BUY',
                    entry: bar.close,
                    score: Math.min(score, 95),
                    tpMultiplier: 1.5,  // ← REDUCED from 1.8 to 1.5
                    slMultiplier: 0.8,   // ← REDUCED from 1.2 to 0.8
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    factors: [
                        `RSI oversold (${rsi.toFixed(0)})`,
                        `Near lower BB`,
                        bullishReversal ? 'Bullish reversal' : '',
                        longLowerWick ? 'Long lower wick' : ''
                    ].filter(f => f)
                };
            }
        }
        
        // SHORT SIGNAL
        if (!signal && rsi !== null && rsi >= config.rsiOverbought && nearUpper) {
            score = config.minScore;
            if (rsi >= config.rsiOverbought + 10) score += 10;
            if (bearishReversal) score += 10;
            if (longUpperWick) score += 8;
            if (volumeSpike) score += 5;
            
            if (score >= config.minScore) {
                signal = {
                    type: 'SELL',
                    entry: bar.close,
                    score: Math.min(score, 95),
                    tpMultiplier: 1.5,  // ← REDUCED
                    slMultiplier: 0.8,   // ← REDUCED
                    riskPercent: config.riskPercent,
                    lotMultiplier: config.lotMultiplier,
                    factors: [
                        `RSI overbought (${rsi.toFixed(0)})`,
                        `Near upper BB`,
                        bearishReversal ? 'Bearish reversal' : '',
                        longUpperWick ? 'Long upper wick' : ''
                    ].filter(f => f)
                };
            }
        }
        
        if (signal) {
            const slDistance = atrValue * signal.slMultiplier;
            const tpDistance = atrValue * signal.tpMultiplier;
            signal.sl = signal.type === 'BUY' ? bar.close - slDistance : bar.close + slDistance;
            signal.tp = signal.type === 'BUY' ? bar.close + tpDistance : bar.close - tpDistance;
            
            this._lastTradeTime = now;
            this._tradesCount++;
            this._hasOpenPosition = true;  // ← MARK THAT WE HAVE A POSITION
            
            console.log(`[RangeBoundary ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')}`);
            console.log(`   Entry: ${signal.entry.toFixed(2)} | TP: ${signal.tp.toFixed(2)} | SL: ${signal.sl.toFixed(2)}`);
            
            return signal;
        }
        
        return null;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        let closed = false;
        
        if (trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.tp - trade.entry) * (trade.lotSize || 0.01);
                closed = true;
                console.log(`[RangeBoundary] TP hit on BUY at ${currentCandle.high.toFixed(2)}`);
            } else if (currentCandle.low <= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.entry - trade.sl) * (trade.lotSize || 0.01);
                closed = true;
                console.log(`[RangeBoundary] SL hit on BUY at ${currentCandle.low.toFixed(2)}`);
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                this._consecutiveLosses = 0;
                this._dailyProfit += (trade.entry - trade.tp) * (trade.lotSize || 0.01);
                closed = true;
                console.log(`[RangeBoundary] TP hit on SELL at ${currentCandle.low.toFixed(2)}`);
            } else if (currentCandle.high >= trade.sl) {
                this._consecutiveLosses++;
                this._dailyProfit -= (trade.sl - trade.entry) * (trade.lotSize || 0.01);
                closed = true;
                console.log(`[RangeBoundary] SL hit on SELL at ${currentCandle.high.toFixed(2)}`);
            }
        }
        
        if (closed) {
            this._hasOpenPosition = false;  // ← RESET FOR NEXT TRADE
            return { action: 'CLOSE', reason: closed ? (trade.type === 'BUY' ? (currentCandle.high >= trade.tp ? 'TP' : 'SL') : (currentCandle.low <= trade.tp ? 'TP' : 'SL')) : null };
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────
    // INDICATOR CALCULATIONS (keep as is)
    // ─────────────────────────────────────────────────────────
    
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
    
    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            dailyProfit: this._dailyProfit,
            winRate: this._tradesCount > 0 ? Math.round((this._tradesCount - this._consecutiveLosses) / this._tradesCount * 100) : 0
        };
    },
    
    setMode(modeNumber) {
        if (![0, 1, 2].includes(modeNumber)) return false;
        this.QUALITY_MODE = modeNumber;
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
        this._hasOpenPosition = false;
        this._currentTicket = null;
    }
};

export default RangeBoundaryStrategy;