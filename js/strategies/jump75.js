// js/strategies/jump75.js - v28: HYBRID MODE
// Takes ALL QUANTITY signals but filters them with intelligent quality scoring
// Best of both worlds: quantity entry + quality filtering

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
    _recentMomentum: [],  // Store recent momentum for quality scoring
    
    // HYBRID MODE: 0=QUANTITY, 1=HYBRID (default), 2=QUALITY, 3=ULTRA
    QUALITY_MODE: 1, // Start with HYBRID mode
    
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
            0: { // QUANTITY - Take almost everything
                name: 'QUANTITY',
                displayName: '🚀 QUANTITY (High Frequency)',
                minMomentum: 0.06,
                minRangeATR: 1.5,
                nearFibATR: 2.0,
                requireTrend: false,
                cooldownMs: 25000,
                qualityThreshold: 0,  // No quality filter
                scalePosition: false
            },
            1: { // HYBRID - Take all signals, scale size by quality
                name: 'HYBRID',
                displayName: '🔄 HYBRID (Smart Scaling)',
                minMomentum: 0.06,      // Same as QUANTITY
                minRangeATR: 1.5,       // Same as QUANTITY  
                nearFibATR: 2.0,        // Same as QUANTITY
                requireTrend: false,    // Same as QUANTITY
                cooldownMs: 25000,      // Same as QUANTITY
                qualityThreshold: 40,   // Minimum quality to trade
                scalePosition: true     // Scale lot size by quality
            },
            2: { // QUALITY - Traditional quality mode (few signals)
                name: 'QUALITY',
                displayName: '🎯 QUALITY (Selective)',
                minMomentum: 0.22,
                minRangeATR: 2.5,
                nearFibATR: 0.9,
                requireTrend: true,
                cooldownMs: 120000,
                qualityThreshold: 70,
                scalePosition: false
            },
            3: { // ULTRA - Very selective
                name: 'ULTRA',
                displayName: '👑 ULTRA (Very Selective)',
                minMomentum: 0.30,
                minRangeATR: 3.0,
                nearFibATR: 0.7,
                requireTrend: true,
                cooldownMs: 180000,
                qualityThreshold: 80,
                scalePosition: false
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },
    
    // Calculate signal quality score (0-100)
    _calculateQualityScore(signal, m5Candles, h4Candles, atr) {
        let score = 50; // Start at neutral
        let reasons = [];
        
        // 1. Fibonacci level quality
        if (signal.mode === '61.8%') {
            score += 20;
            reasons.push('Golden Fib');
        } else if (signal.mode === '50%') {
            score += 10;
            reasons.push('Mid Fib');
        } else if (signal.mode === '38.2%') {
            score += 5;
            reasons.push('Shallow Fib');
        }
        
        // 2. Momentum strength
        const momValue = parseFloat(signal.factors.find(f => f.includes('Mom'))?.split(' ')[1] || 0);
        if (momValue > 0.15) {
            score += 15;
            reasons.push('Strong Momentum');
        } else if (momValue > 0.10) {
            score += 8;
            reasons.push('Good Momentum');
        }
        
        // 3. Candle strength
        if (signal.factors.some(f => f.includes('Strong'))) {
            score += 10;
            reasons.push('Strong Candle');
        }
        
        // 4. Trend alignment
        if (m5Candles && m5Candles.length > 20) {
            const ema8 = this._calculateEMA(m5Candles, 8);
            const ema21 = this._calculateEMA(m5Candles, 21);
            if (ema8 && ema21) {
                const trendAligned = (signal.type === 'BUY' && ema8 > ema21) ||
                                    (signal.type === 'SELL' && ema8 < ema21);
                if (trendAligned) {
                    score += 10;
                    reasons.push('Trend Aligned');
                }
            }
        }
        
        // 5. Range quality (tighter range = better)
        if (h4Candles && h4Candles.length >= 12) {
            const h4High = Math.max(...h4Candles.slice(-12).map(c => c.high));
            const h4Low = Math.min(...h4Candles.slice(-12).map(c => c.low));
            const range = h4High - h4Low;
            const rangeATR = range / atr;
            if (rangeATR >= 3.0) {
                score += 8;
                reasons.push('Wide Range');
            } else if (rangeATR >= 2.0) {
                score += 4;
                reasons.push('Good Range');
            }
        }
        
        // 6. Recent win rate (adaptive)
        if (this._tradesCount > 10) {
            const recentWinRate = this._getRecentWinRate();
            if (recentWinRate > 55) {
                score += 5;
                reasons.push('Hot Streak');
            } else if (recentWinRate < 40) {
                score -= 10;
                reasons.push('Cold Streak');
            }
        }
        
        return { score: Math.min(100, Math.max(0, score)), reasons };
    },
    
    _getRecentWinRate() {
        // Track last 20 trades win/loss
        if (!this._recentResults) this._recentResults = [];
        const last20 = this._recentResults.slice(-20);
        if (last20.length === 0) return 50;
        const wins = last20.filter(r => r === 'win').length;
        return (wins / last20.length) * 100;
    },
    
    _calculateEMA(candles, period) {
        if (!candles || candles.length < period + 5) return null;
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
    
    // Track trade outcome for adaptive quality
    recordOutcome(outcome, pnl) {
        if (!this._recentResults) this._recentResults = [];
        this._recentResults.push(outcome === 'TP' ? 'win' : 'loss');
        if (this._recentResults.length > 100) this._recentResults.shift();
        
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
            this._dailyProfit += pnl;
        } else {
            this._consecutiveLosses++;
            this._dailyProfit -= Math.abs(pnl);
        }
    },
    
    // Calculate dynamic lot size based on quality
    _calculateDynamicLotSize(baseLot, qualityScore, config) {
        if (!config.scalePosition) return baseLot;
        
        let multiplier = 1.0;
        if (qualityScore >= 80) multiplier = 2.0;      // Double on A+ signals
        else if (qualityScore >= 70) multiplier = 1.5;  // 50% more on A signals
        else if (qualityScore >= 60) multiplier = 1.0;  // Full size on B signals
        else if (qualityScore >= 50) multiplier = 0.5;  // Half size on C signals
        else multiplier = 0.25;                         // Quarter size on D signals
        
        // Reduce size during cold streak
        const recentWinRate = this._getRecentWinRate();
        if (recentWinRate < 40) {
            multiplier *= 0.5;
        }
        
        return Math.max(0.01, baseLot * multiplier);
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        const symbol = this._symbol || 'UNKNOWN';
        const now = Date.now();
        const config = this._getModeConfig();
        
        // Diagnostic every 30 seconds
        if (!this._lastDebugLog || now - this._lastDebugLog > 30000) {
            console.log(`[J75] ${symbol} | M5:${m5Candles?.length || 0} | Mode:${config.name} | Quality:${config.qualityThreshold}`);
            this._lastDebugLog = now;
        }

        // Minimum candle requirements (reduced for faster signals)
        if (!m5Candles || m5Candles.length < 15) return null;
        if (!h4Candles || h4Candles.length < 8) return null;

        const latestCandle = m5Candles[m5Candles.length - 1];
        if (!latestCandle || !latestCandle.close || latestCandle.close <= 0) return null;

        if (!feedMonitor.isSymbolActive(symbol, latestCandle.time)) return null;
        if (!feedMonitor.isSessionStartBufferPassed(5000)) return null;
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
        
        // Store momentum for quality scoring
        this._recentMomentum.push(momentum);
        if (this._recentMomentum.length > 20) this._recentMomentum.shift();

        const bullishCandle = latestCandle.close > latestCandle.open;
        const bearishCandle = latestCandle.close < latestCandle.open;
        const strongCandle = Math.abs(latestCandle.close - latestCandle.open) > atr * 0.6;

        const m15Trend = this._getM15Trend(m15Candles);
        const trendOk = !config.requireTrend || 
                       (momentum > 0 && m15Trend === 'UP') || 
                       (momentum < 0 && m15Trend === 'DOWN');

        let signal = null;
        
        // Check for signals using QUANTITY thresholds
        const enoughMomentum = Math.abs(momentum) > config.minMomentum;
        
        if (enoughMomentum && ((momentum > 0 && bullishCandle) || (momentum < 0 && bearishCandle))) {
            const zone = near618 ? '61.8%' : (near50 ? '50%' : '38.2%');
            const type = momentum > 0 ? 'BUY' : 'SELL';
            
            // Calculate quality score for this signal
            const quality = this._calculateQualityScore(
                { type, mode: zone, factors: [strongCandle ? 'Strong' : ''] },
                m5Candles,
                h4Candles,
                atr
            );
            
            // HYBRID MODE: Apply quality filter
            if (quality.score >= config.qualityThreshold) {
                signal = {
                    type: type,
                    entry: price,
                    rawScore: Math.floor(50 + Math.abs(momentum) * 100),
                    qualityScore: quality.score,
                    qualityReasons: quality.reasons,
                    tpMultiplier: 2.0,
                    slMultiplier: 1.0,
                    isJump75: true,
                    mode: zone,
                    dynamicLotMultiplier: config.scalePosition ? 
                        (quality.score >= 80 ? 2.0 : quality.score >= 70 ? 1.5 : quality.score >= 60 ? 1.0 : quality.score >= 50 ? 0.5 : 0.25) : 1.0,
                    factors: [
                        `📈 ${zone}`,
                        `Mom ${momentum.toFixed(2)}`,
                        `Quality: ${quality.score}%`,
                        ...quality.reasons.slice(0, 2)
                    ].filter(Boolean)
                };
                
                console.log(`✅ [J75 HYBRID] ${signal.type} | Quality:${quality.score}% | ${quality.reasons.join(', ')} | Lot x${signal.dynamicLotMultiplier}`);
            } else {
                // Signal rejected by quality filter
                console.log(`⏭️ [J75 SKIP] ${type} | Quality:${quality.score}% < ${config.qualityThreshold}% | ${quality.reasons.join(', ')}`);
                return null;
            }
        }

        if (signal) {
            this._lastTradeTime = now;
            this._tradesCount++;
        }

        return signal;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        const pnl = trade.type === 'BUY' ? currentCandle.close - trade.entry : trade.entry - currentCandle.close;
        const tpDist = Math.abs(trade.tp - trade.entry);
        const slDist = Math.abs(trade.sl - trade.entry);
        
        if (pnl >= tpDist * 0.7) {
            this.recordOutcome('TP', pnl);
            return { action: 'CLOSE', reason: 'TP' };
        }
        if (pnl <= -slDist * 0.95) {
            this.recordOutcome('SL', Math.abs(pnl));
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
            symbol: this._symbol,
            recentWinRate: this._getRecentWinRate()
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
            0: { name: 'QUANTITY', desc: 'Take all signals, no filtering' },
            1: { name: 'HYBRID', desc: 'Take all signals, scale size by quality' },
            2: { name: 'QUALITY', desc: 'Only high quality signals (few trades)' },
            3: { name: 'ULTRA', desc: 'Only perfect signals (rare trades)' }
        };
    },
    
    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using HYBRID (1).`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] ✅ Mode switched to ${config.displayName}`);
        console.log(`   Quality threshold: ${config.qualityThreshold}% | Scale position: ${config.scalePosition}`);
        return true;
    },
    
    reset() {
        this._lastTradeTime = 0;
        this._consecutiveLosses = 0;
        this._dailyProfit = 0;
        this._tradesCount = 0;
        this._recentMomentum = [];
        this._recentResults = [];
        feedMonitor.resetSession();
    },
    
    resetSession() {
        feedMonitor.resetSession();
    }
};

export { Jump75Strategy };
export default Jump75Strategy;