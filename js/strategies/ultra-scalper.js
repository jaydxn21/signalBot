// Ultra Scalper v4.0 — DEBUG VERSION
// This version logs EVERY check to show why no trades are firing

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _consecutiveLosses: 0,
    _cooldownEndTime: null,
    _lastResetDate: null,
    _symbolState: new Map(),
    _lastDebugLog: 0,
    
    CONFIG: {
        MIN_GAP_MS: 5000,
        MIN_ATR: 0.1,              // MUCH LOWER - was 0.5
        MIN_BODY_RATIO: 0.15,      // MUCH LOWER - was 0.25
        MAX_CONCURRENT_TRADES: 5,
        MAX_TRADES_PER_HOUR: 20,
        MAX_CONSECUTIVE_LOSSES: 10,
        LOSS_COOLDOWN_MS: 60000,
        TRAILING_START: 0.5,
        TRAILING_DISTANCE: 0.3,
        MIN_CANDLE_RANGE: 0.01,    // MUCH LOWER - was 0.1
    },
    
    _checkDailyReset() {
        const today = new Date().toDateString();
        if (this._lastResetDate !== today) {
            console.log(`[UltraScalper] Daily reset`);
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
        if (body === 0) return false;
        
        if (direction === 'BUY') {
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            return upperWick > body * 2.0;  // Very long wick only
        } else {
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            return lowerWick > body * 2.0;
        }
    },
    
    _getSymbolState(symbol) {
        if (!this._symbolState.has(symbol)) {
            this._symbolState.set(symbol, { consecutiveLosses: 0, cooldownEnd: null, tradeHistory: [] });
        }
        return this._symbolState.get(symbol);
    },
    
    _isSymbolInLossCooldown(symbol) {
        const state = this._getSymbolState(symbol);
        if (state.consecutiveLosses < this.CONFIG.MAX_CONSECUTIVE_LOSSES) return false;
        if (!state.cooldownEnd) {
            state.cooldownEnd = Date.now() + this.CONFIG.LOSS_COOLDOWN_MS;
            console.log(`[UltraScalper] ${symbol} loss cooldown`);
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
    
    recordOutcome(symbol, outcome, pnl, entry, sl, tp, exitPrice) {
        const state = this._getSymbolState(symbol);
        
        const tradeLog = {
            time: new Date().toISOString(),
            symbol,
            outcome,
            pnl: pnl.toFixed(4),
            entry: entry.toFixed(4),
            sl: sl.toFixed(4),
            tp: tp.toFixed(4),
            exitPrice: exitPrice.toFixed(4),
        };
        
        state.tradeHistory.push(tradeLog);
        if (state.tradeHistory.length > 20) state.tradeHistory.shift();
        
        console.log(`[UltraScalper] ${outcome} on ${symbol} | PnL: ${outcome === 'TP' ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
        
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
        
        // Log every 50 candles to show we're alive
        const now = Date.now();
        if (now - this._lastDebugLog > 30000) {  // Every 30 seconds
            console.log(`[UltraScalper] 🔍 Checking ${symbol} | Candles: ${candles?.length} | ATR: ${atr?.toFixed(4)}`);
            this._lastDebugLog = now;
        }
        
        // ── BASIC VALIDATIONS ─────────────────────────────────
        if (!atr) {
            console.log(`[UltraScalper] ❌ ${symbol} | No ATR`);
            return null;
        }
        
        if (!candles || candles.length < 5) {
            console.log(`[UltraScalper] ❌ ${symbol} | Insufficient candles: ${candles?.length}`);
            return null;
        }
        
        if (atr < this.CONFIG.MIN_ATR) {
            console.log(`[UltraScalper] ❌ ${symbol} | ATR too low: ${atr.toFixed(4)} < ${this.CONFIG.MIN_ATR}`);
            return null;
        }
        
        if (this._isSymbolInLossCooldown(symbol)) {
            // Don't log this too often
            return null;
        }
        
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) {
            return null;
        }
        
        if (!this._canTradeHourly()) {
            console.log(`[UltraScalper] ❌ ${symbol} | Hourly limit reached`);
            return null;
        }
        
        if (!this._canAddTrade(symbol)) {
            console.log(`[UltraScalper] ❌ ${symbol} | Max concurrent trades`);
            return null;
        }
        
        // ── GET CANDLES ────────────────────────────────────────
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        if (!c2 || !c3 || !live) {
            console.log(`[UltraScalper] ❌ ${symbol} | Missing candle data`);
            return null;
        }
        
        // Log candle details every 30 seconds
        if (now - this._lastDebugLog < 5000) {
            const dir2 = this._getBodyDirection(c2);
            const dir3 = this._getBodyDirection(c3);
            const range3 = (c3.high - c3.low).toFixed(4);
            const body3 = Math.abs(c3.close - c3.open).toFixed(4);
            const bodyRatio = range3 > 0 ? (body3 / (c3.high - c3.low) * 100).toFixed(0) : 0;
            
            console.log(`[UltraScalper] 📊 ${symbol} | C3: ${dir3} | Range: ${range3} | Body: ${body3} (${bodyRatio}%) | Live: ${live.close > c3.close ? 'UP' : live.close < c3.close ? 'DOWN' : 'FLAT'}`);
        }
        
        // ── DIRECTION CHECK ────────────────────────────────────
        const dir2 = this._getBodyDirection(c2);
        const dir3 = this._getBodyDirection(c3);
        const liveDir = this._getLiveDirection(live, c3.close);
        
        let direction = null;
        if (dir2 === dir3 && dir3 === liveDir) {
            direction = dir2;
            console.log(`[UltraScalper] ✅ ${symbol} | Triple alignment: ${direction}`);
        } else if (dir2 === dir3) {
            direction = dir2;
            console.log(`[UltraScalper] ✅ ${symbol} | Double alignment (c2/c3): ${direction}`);
        } else if (dir3 === liveDir) {
            direction = dir3;
            console.log(`[UltraScalper] ✅ ${symbol} | Double alignment (c3/live): ${direction}`);
        } else {
            // Only log occasionally to avoid spam
            if (Math.random() < 0.05) {
                console.log(`[UltraScalper] ❌ ${symbol} | No alignment | d2:${dir2} d3:${dir3} live:${liveDir}`);
            }
            return null;
        }
        
        // ── BODY QUALITY CHECK ─────────────────────────────────
        if (!this._hasMeaningfulBody(c3)) {
            const range = c3.high - c3.low;
            const body = Math.abs(c3.close - c3.open);
            const ratio = range > 0 ? (body / range * 100).toFixed(0) : 0;
            console.log(`[UltraScalper] ❌ ${symbol} | Body too small: ${ratio}% < ${this.CONFIG.MIN_BODY_RATIO * 100}%`);
            return null;
        }
        
        // ── OPPOSING WICK CHECK ────────────────────────────────
        if (this._hasOpposingWick(c3, direction)) {
            console.log(`[UltraScalper] ❌ ${symbol} | Opposing wick on candle3`);
            return null;
        }
        
        // ── ALL CHECKS PASSED ──────────────────────────────────
        const bodySize = Math.abs(c3.close - c3.open);
        const bodyRatio = bodySize / atr;
        
        let tpMult = 1.0;
        let label = `FAST ${direction === 'BUY' ? '▲' : '▼'}`;
        if (bodyRatio > 0.5) {
            tpMult = 1.5;
            label = `STRONG ${direction === 'BUY' ? '▲' : '▼'}`;
        }
        
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        console.log(`[UltraScalper] 🚀✅ FIRING ${direction} on ${symbol} | Body: ${bodyRatio.toFixed(1)}x ATR | TP: ${tpMult}:1`);
        
        return {
            type: direction,
            label: `ULTRA ${label}`,
            score: Math.min(100, 50 + bodyRatio * 20),
            factors: [`${direction} momentum`, `${tpMult}:1 R:R`, `Body ${bodyRatio.toFixed(1)}x ATR`],
            tpMultiplier: tpMult,
            slMultiplier: 1.0,
            isUltraScalper: true,
        };
    },
    
    applyTrailingStop(openSignal, currentPrice, atr, currentProfit) {
        return null;
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
        console.log(`[UltraScalper] Manual reset complete`);
    },
    
    getTradeHistory(symbol) {
        const state = this._getSymbolState(symbol);
        return state.tradeHistory;
    }
};