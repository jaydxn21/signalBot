// Ultra Scalper v2.1 — Relaxed for More Signals

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _consecutiveLosses: 0,
    _cooldownEndTime: null,
    _lastResetDate: null,
    _symbolState: new Map(),
    
    CONFIG: {
        MIN_GAP_MS: 5000,              // 5 seconds
        MIN_ATR: 0.5,                  // Very low
        MIN_BODY_RATIO: 0.25,          // 25% body
        MIN_VOLUME_RATIO: 0.3,
        MAX_CONCURRENT_TRADES: 5,
        MAX_TRADES_PER_HOUR: 15,
        MAX_CONSECUTIVE_LOSSES: 5,
        LOSS_COOLDOWN_MS: 60000,       // 1 minute
        TRAILING_START: 0.5,
        TRAILING_DISTANCE: 0.3,
        MIN_CANDLE_RANGE: 0.1,
        MIN_PROFIT_TO_TRAIL: 0.1,
    },
    
    _checkDailyReset() {
        const today = new Date().toDateString();
        if (this._lastResetDate !== today) {
            this._consecutiveLosses = 0;
            this._cooldownEndTime = null;
            this._hourlyTradeCount = 0;
            this._hourStart = Date.now();
            this._symbolState.clear();
            this._lastResetDate = today;
        }
    },
    
    _getBodyDirection(candle) {
        if (!candle) return null;
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
        return null;
    },
    
    _getLiveDirection(liveCandle, previousClose) {
        if (!liveCandle || !previousClose) return null;
        if (liveCandle.close > previousClose) return 'BUY';
        if (liveCandle.close < previousClose) return 'SELL';
        return null;
    },
    
    _hasMeaningfulBody(candle, minRatio = null) {
        const ratio = minRatio || this.CONFIG.MIN_BODY_RATIO;
        const range = candle.high - candle.low;
        if (range < this.CONFIG.MIN_CANDLE_RANGE) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > ratio;
    },
    
    _hasOpposingWick(candle, direction) {
        const body = Math.abs(candle.close - candle.open);
        if (direction === 'BUY') {
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            return upperWick > body * 1.2;  // Very long wick needed to reject
        } else {
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            return lowerWick > body * 1.2;
        }
    },
    
    _volumeConfirmed(candles, minRatio = null) {
        return true; // Skip volume check
    },
    
    _rangeExpanding(candles) {
        return true; // Skip range check
    },
    
    _getMomentumStrength(candles, direction, atr) {
        let score = 50;
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        
        if (c2 && c3) {
            const body3 = Math.abs(c3.close - c3.open);
            const bodyRatio = body3 / atr;
            if (bodyRatio > 0.5) score += 20;
            else if (bodyRatio > 0.3) score += 10;
        }
        
        return Math.min(100, Math.max(0, score));
    },
    
    _getSymbolState(symbol) {
        if (!this._symbolState.has(symbol)) {
            this._symbolState.set(symbol, { consecutiveLosses: 0, cooldownEnd: null });
        }
        return this._symbolState.get(symbol);
    },
    
    _isSymbolInLossCooldown(symbol) {
        const state = this._getSymbolState(symbol);
        if (state.consecutiveLosses < this.CONFIG.MAX_CONSECUTIVE_LOSSES) return false;
        if (!state.cooldownEnd) {
            state.cooldownEnd = Date.now() + this.CONFIG.LOSS_COOLDOWN_MS;
            return true;
        }
        if (Date.now() > state.cooldownEnd) {
            state.consecutiveLosses = 0;
            state.cooldownEnd = null;
            return false;
        }
        return true;
    },
    
    _canAddTrade(symbol) {
        const currentCount = this._activeTrades.get(symbol) || 0;
        return currentCount < this.CONFIG.MAX_CONCURRENT_TRADES;
    },
    
    addTrade(symbol) {
        const currentCount = this._activeTrades.get(symbol) || 0;
        this._activeTrades.set(symbol, currentCount + 1);
    },
    
    removeTrade(symbol) {
        const currentCount = this._activeTrades.get(symbol) || 0;
        if (currentCount <= 1) {
            this._activeTrades.delete(symbol);
        } else {
            this._activeTrades.set(symbol, currentCount - 1);
        }
    },
    
    _canTradeHourly() {
        const now = Date.now();
        if (now - this._hourStart > 3600000) {
            this._hourlyTradeCount = 0;
            this._hourStart = now;
        }
        return this._hourlyTradeCount < this.CONFIG.MAX_TRADES_PER_HOUR;
    },
    
    recordOutcome(symbol, outcome) {
        const state = this._getSymbolState(symbol);
        if (outcome === 'TP') {
            state.consecutiveLosses = 0;
            state.cooldownEnd = null;
            this._consecutiveLosses = 0;
        } else {
            state.consecutiveLosses++;
            this._consecutiveLosses++;
        }
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        this._checkDailyReset();
        if (!atr || candles.length < 5) return null;
        if (atr < this.CONFIG.MIN_ATR) return null;
        if (this._isSymbolInLossCooldown(symbol)) return null;
        
        const now = Date.now();
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) return null;
        if (!this._canTradeHourly()) return null;
        if (!this._canAddTrade(symbol)) return null;
        
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        if (!c2 || !c3 || !live) return null;
        
        const dir2 = this._getBodyDirection(c2);
        const dir3 = this._getBodyDirection(c3);
        const liveDir = this._getLiveDirection(live, c3.close);
        
        // Need at least 2 aligned (relaxed from 3)
        let direction = null;
        if (dir2 === dir3 && dir3 === liveDir) direction = dir2;
        else if (dir2 === dir3) direction = dir2;
        else if (dir3 === liveDir) direction = dir3;
        else return null;
        
        if (!this._hasMeaningfulBody(c3)) return null;
        
        if (this._hasOpposingWick(c3, direction)) return null;
        
        const momentumStrength = this._getMomentumStrength(candles, direction, atr);
        if (momentumStrength < 30) return null;
        
        let tpMult, slMult, label;
        if (momentumStrength >= 60) {
            tpMult = 1.5;
            slMult = 1.0;
            label = `STRONG ${direction === 'BUY' ? '▲' : '▼'}⚡`;
        } else {
            tpMult = 1.0;
            slMult = 1.0;
            label = `FAST ${direction === 'BUY' ? '▲' : '▼'}⚡`;
        }
        
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        console.log(`[UltraScalper] 🔥 ${direction} on ${symbol} | Score: ${Math.round(momentumStrength)}`);
        
        return {
            type: direction,
            label: `ULTRA ${label}`,
            score: Math.round(momentumStrength),
            factors: [`${direction} momentum`, `${tpMult}:1 R:R`],
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isUltraScalper: true,
            momentumStrength: momentumStrength,
        };
    },
    
    applyTrailingStop(openSignal, currentPrice, atr, currentProfit) {
        if (!openSignal || !openSignal.isUltraScalper) return null;
        const { type, entry } = openSignal;
        const inProfit = type === 'BUY' ? currentPrice - entry : entry - currentPrice;
        if (inProfit < this.CONFIG.TRAILING_START * atr) return null;
        return null; // Disable trailing for now
    },
    
    reset() {
        this._lastSignalMs = 0;
        this._activeTrades.clear();
        this._hourlyTradeCount = 0;
        this._hourStart = Date.now();
        this._consecutiveLosses = 0;
        this._cooldownEndTime = null;
        this._symbolState.clear();
        this._lastResetDate = null;
    }
};