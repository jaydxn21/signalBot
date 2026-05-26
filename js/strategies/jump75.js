// js/strategies/jump75.js - v30: Stronger Hybrid + Loss Protection
const feedMonitor = {
    _lastPriceTime: {},
    _sessionStartTime: null,
    
    init(symbol) {
        if (!symbol) return;
        if (!this._sessionStartTime) this._sessionStartTime = Date.now();
        if (!this._lastPriceTime[symbol]) this._lastPriceTime[symbol] = Date.now();
    },
    
    isSymbolActive(symbol, currentCandleTime) {
        const now = Date.now();
        const lastTime = this._lastPriceTime[symbol];
        let candleTimeMs = currentCandleTime;
        if (candleTimeMs && candleTimeMs < 10000000000) candleTimeMs *= 1000;
        
        const candleAge = candleTimeMs ? (now - candleTimeMs) : (now - (lastTime || now));
        
        if (candleAge > 18000) {
            console.log(`⚠️ ${symbol} feed stale: ${(candleAge/1000).toFixed(1)}s`);
            return false;
        }
        if (candleTimeMs) this._lastPriceTime[symbol] = candleTimeMs;
        return true;
    },
    
    isSessionStartBufferPassed(bufferMs = 8000) {
        if (!this._sessionStartTime) return true;
        return Date.now() - this._sessionStartTime >= bufferMs;
    },
    
    resetSession() {
        this._sessionStartTime = Date.now();
        this._lastPriceTime = {};
    }
};

const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyLossLimit: -35,
    _tradesCount: 0,
    _symbol: null,
    _recentResults: [],

    QUALITY_MODE: 1, // Default HYBRID

    setSymbol(symbol) {
        this._symbol = symbol;
        feedMonitor.init(symbol);
    },

    _getModeConfig() {
        const modes = {
            0: { name: 'QUANTITY', minMomentum: 0.05, minRangeATR: 1.4, nearFibATR: 2.2, qualityThreshold: 0,   scalePosition: false },
            1: { name: 'HYBRID',   minMomentum: 0.08, minRangeATR: 1.6, nearFibATR: 1.8, qualityThreshold: 62, scalePosition: true },
            2: { name: 'QUALITY',  minMomentum: 0.20, minRangeATR: 2.4, nearFibATR: 1.1, qualityThreshold: 74, scalePosition: false },
            3: { name: 'ULTRA',    minMomentum: 0.28, minRangeATR: 2.9, nearFibATR: 0.8, qualityThreshold: 84, scalePosition: false }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },

    _calculateQualityScore(signal, m5Candles, h4Candles, atr) {
        let score = 48;
        const latest = m5Candles[m5Candles.length - 1];

        // Fib Level Weight
        if (signal.mode === '61.8%') score += 24;
        else if (signal.mode === '50%') score += 14;
        else if (signal.mode === '38.2%') score += 7;

        // Momentum
        const mom = parseFloat((signal.factors || []).join(' ').match(/Mom ([\d.-]+)/)?.[1] || 0);
        if (mom > 0.22) score += 20;
        else if (mom > 0.14) score += 12;
        else if (mom > 0.08) score += 6;

        // Candle Strength
        if (latest && Math.abs(latest.close - latest.open) > atr * 0.65) score += 14;

        // EMA Alignment
        if (m5Candles.length > 18) {
            const ema8 = this._calculateEMA(m5Candles, 8);
            const ema21 = this._calculateEMA(m5Candles, 21);
            if (ema8 && ema21) {
                const aligned = (signal.type === 'BUY' && ema8 > ema21) || (signal.type === 'SELL' && ema8 < ema21);
                if (aligned) score += 12;
            }
        }

        // Adaptive boost during good streak
        if (this._consecutiveLosses === 0) score += 8;

        return Math.min(100, Math.max(0, score));
    },

    _calculateEMA(candles, period) {
        if (!candles || candles.length < period + 6) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        const symbol = this._symbol || 'UNKNOWN';
        const config = this._getModeConfig();
        const now = Date.now();

        if (!m5Candles || m5Candles.length < 18 || !h4Candles || h4Candles.length < 8) return null;
        if (!feedMonitor.isSymbolActive(symbol, m5Candles[m5Candles.length-1].time)) return null;
        if (now - this._lastTradeTime < 12000) return null; // Cooldown

        // Daily loss limit
        if (this._dailyProfit <= this._dailyLossLimit) {
            console.log(`🛑 [J75] Daily loss limit reached: ${this._dailyProfit.toFixed(2)}`);
            return null;
        }

        const latest = m5Candles[m5Candles.length - 1];
        const price = latest.close;

        const h4High = Math.max(...h4Candles.slice(-12).map(c => c.high));
        const h4Low = Math.min(...h4Candles.slice(-12).map(c => c.low));
        const range = h4High - h4Low;
        if (range < atr * config.minRangeATR) return null;

        const fib618 = h4High - (range * 0.618);
        const fib50 = h4High - (range * 0.5);
        const fib382 = h4High - (range * 0.382);

        const near618 = Math.abs(price - fib618) < atr * config.nearFibATR;
        const near50 = Math.abs(price - fib50) < atr * config.nearFibATR;
        const near382 = Math.abs(price - fib382) < atr * config.nearFibATR;

        if (!near618 && !near50 && !near382) return null;

        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return null;

        const momentum = (ema8 - ema21) / atr;
        const bullish = latest.close > latest.open;

        let signal = null;
        const type = momentum > 0 ? 'BUY' : 'SELL';

        if (Math.abs(momentum) > config.minMomentum && ((momentum > 0 && bullish) || (momentum < 0 && !bullish))) {
            const zone = near618 ? '61.8%' : (near50 ? '50%' : '38.2%');
            let quality = this._calculateQualityScore({type, mode: zone}, m5Candles, h4Candles, atr);

            // Adaptive threshold during cold streak
            if (this._consecutiveLosses >= 2) quality -= 8;

            if (quality >= config.qualityThreshold) {
                signal = {
                    type,
                    entry: price,
                    score: Math.floor(quality),
                    qualityScore: quality,
                    tpMultiplier: 2.1,
                    slMultiplier: 1.0,
                    isJump75: true,
                    mode: zone,
                    dynamicLotMultiplier: config.scalePosition ? 
                        (quality >= 82 ? 2.1 : quality >= 72 ? 1.6 : quality >= 62 ? 1.1 : 0.55) : 1.0,
                    factors: [`${zone}`, `Mom ${momentum.toFixed(2)}`, `Q:${quality}%`]
                };
            }
        }

        if (signal) {
            this._lastTradeTime = now;
            this._tradesCount++;
            console.log(`✅ [J75 ${config.name}] ${signal.type} | Q:${signal.qualityScore}% | Lot×${signal.dynamicLotMultiplier.toFixed(1)}`);
        }

        return signal;
    },

    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        const pnl = trade.type === 'BUY' ? currentCandle.close - trade.entry : trade.entry - currentCandle.close;
        const tpDist = Math.abs(trade.tp - trade.entry);

        if (pnl >= tpDist * 0.65) {
            this.recordOutcome('TP', pnl);
            return { action: 'CLOSE', reason: 'TP' };
        }
        if (pnl <= -Math.abs(trade.sl - trade.entry) * 0.92) {
            this.recordOutcome('SL', Math.abs(pnl));
            return { action: 'CLOSE', reason: 'SL' };
        }
        return null;
    },

    recordOutcome(outcome, pnl = 0) {
        if (!this._recentResults) this._recentResults = [];
        this._recentResults.push(outcome);
        if (this._recentResults.length > 60) this._recentResults.shift();

        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
            this._dailyProfit += pnl;
        } else {
            this._consecutiveLosses++;
            this._dailyProfit -= pnl;
        }
    },

    setMode(mode) {
        this.QUALITY_MODE = parseInt(mode);
        console.log(`[Jump75] → ${this._getModeConfig().name} MODE`);
    },

    getCurrentConfig() {
        return this._getModeConfig();
    },

    getCurrentMode() {
        return this.QUALITY_MODE;
    }
};

export { Jump75Strategy };
export default Jump75Strategy;