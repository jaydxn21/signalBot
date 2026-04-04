// Ultra Scalper v5.0 — SIMPLIFIED GUARANTEED-TO-FIRE VERSION
// This version WILL fire trades on any symbol with minimal conditions

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _lastDebugLog: 0,
    
    CONFIG: {
        MIN_GAP_MS: 30000,           // 30 seconds between signals (relaxed)
        MIN_ATR: 0.01,               // Very low - almost any market qualifies
        MIN_BODY_RATIO: 0.1,         // Only 10% body needed
        MAX_CONCURRENT_TRADES: 3,
        MAX_TRADES_PER_HOUR: 10,
        MIN_CANDLE_RANGE: 0.001,     // Very small
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
    
    _hasMeaningfulBody(candle) {
        const range = candle.high - candle.low;
        if (range < this.CONFIG.MIN_CANDLE_RANGE) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > this.CONFIG.MIN_BODY_RATIO;
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
    
    _canAddTrade(symbol) {
        const currentCount = this._activeTrades.get(symbol) || 0;
        return currentCount < this.CONFIG.MAX_CONCURRENT_TRADES;
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
        console.log(`[UltraScalper] ${outcome} on ${symbol} | PnL: ${outcome === 'TP' ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
        
        if (outcome === 'TP') {
            // Reset on win
        } else {
            // Loss tracking
        }
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        const now = Date.now();
        
        // Log every 10 seconds to show we're alive
        if (now - this._lastDebugLog > 10000) {
            console.log(`[UltraScalper] 🔍 ACTIVE on ${symbol} | Candles: ${candles?.length} | ATR: ${atr?.toFixed(4)} | Last signal: ${this._lastSignalMs ? Math.round((now - this._lastSignalMs)/1000) + 's ago' : 'never'}`);
            this._lastDebugLog = now;
        }
        
        // ── MINIMAL VALIDATIONS ─────────────────────────────────
        if (!atr) {
            console.log(`[UltraScalper] ❌ No ATR for ${symbol}`);
            return null;
        }
        
        if (!candles || candles.length < 5) {
            console.log(`[UltraScalper] ❌ Insufficient candles for ${symbol}: ${candles?.length}`);
            return null;
        }
        
        if (atr < this.CONFIG.MIN_ATR) {
            console.log(`[UltraScalper] ❌ ATR too low for ${symbol}: ${atr.toFixed(4)}`);
            return null;
        }
        
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) {
            // Don't log rate limit too often
            return null;
        }
        
        if (!this._canTradeHourly()) {
            console.log(`[UltraScalper] ❌ Hourly limit reached for ${symbol}`);
            return null;
        }
        
        if (!this._canAddTrade(symbol)) {
            console.log(`[UltraScalper] ❌ Max concurrent trades for ${symbol}`);
            return null;
        }
        
        // ── SIMPLE CANDLE CHECK ─────────────────────────────────
        const c3 = candles[candles.length - 2];  // Last closed candle
        const live = candles[candles.length - 1]; // Current forming candle
        
        if (!c3 || !live) {
            console.log(`[UltraScalper] ❌ Missing candle data for ${symbol}`);
            return null;
        }
        
        const dir3 = this._getBodyDirection(c3);
        const liveDir = this._getLiveDirection(live, c3.close);
        
        // Log candle details every time
        const range3 = (c3.high - c3.low).toFixed(4);
        const body3 = Math.abs(c3.close - c3.open).toFixed(4);
        const bodyRatio = range3 > 0 ? (body3 / (c3.high - c3.low) * 100).toFixed(0) : 0;
        
        console.log(`[UltraScalper] 📊 ${symbol} | Candle3: ${dir3 || 'none'} | Body: ${bodyRatio}% | Live: ${liveDir || 'none'} | Price: ${c3.close.toFixed(2)}`);
        
        // ── SIMPLE DIRECTION CHECK ──────────────────────────────
        let direction = null;
        
        // Just need last closed candle direction (simplest)
        if (dir3 === 'BUY') {
            direction = 'BUY';
        } else if (dir3 === 'SELL') {
            direction = 'SELL';
        } else {
            console.log(`[UltraScalper] ❌ No clear direction for ${symbol}`);
            return null;
        }
        
        // ── CRASH/BOOM DIRECTION FILTER ─────────────────────────
        const isCrash = symbol.includes('CRASH');
        const isBoom = symbol.includes('BOOM');
        
        if (isCrash && direction === 'BUY') {
            console.log(`[UltraScalper] ❌ ${symbol} | FILTERED: CRASH only takes SELL (trends DOWN), skipping BUY`);
            return null;
        }
        if (isBoom && direction === 'SELL') {
            console.log(`[UltraScalper] ❌ ${symbol} | FILTERED: BOOM only takes BUY (trends UP), skipping SELL`);
            return null;
        }
        
        // ── BODY QUALITY CHECK (relaxed) ────────────────────────
        if (!this._hasMeaningfulBody(c3)) {
            console.log(`[UltraScalper] ❌ Body too small for ${symbol} (${bodyRatio}% < ${this.CONFIG.MIN_BODY_RATIO*100}%)`);
            return null;
        }
        
        // ── ALL CHECKS PASSED - FIRE TRADE! ─────────────────────
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        const bodySize = Math.abs(c3.close - c3.open);
        const bodyAtrRatio = bodySize / atr;
        
        // Use 1:1 R:R for testing (simple)
        const tpMult = 1.0;
        const slMult = 1.0;
        
        console.log(`[UltraScalper] 🚀✅🔥 FIRING ${direction} on ${symbol} | Entry: ${c3.close.toFixed(2)} | ATR: ${atr.toFixed(4)} | Body: ${bodyAtrRatio.toFixed(1)}x ATR`);
        
        return {
            type: direction,
            label: `ULTRA ${direction === 'BUY' ? '▲' : '▼'}`,
            score: 70,
            factors: [`${direction} momentum`, `1:1 R:R`],
            tpMultiplier: tpMult,
            slMultiplier: slMult,
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
        console.log(`[UltraScalper] Reset complete`);
    },
    
    getTradeHistory(symbol) {
        return [];
    }
};