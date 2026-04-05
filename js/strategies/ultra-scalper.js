// Ultra Scalper v8.0 — TRUE SCALPER
// 
// DESIGN: Take many small profits, cut losses quickly
// - Entry: Simple momentum on M1 timeframe
// - TP: Very small (0.15% on BTC, 0.3% on Crash/Boom)
// - SL: Very tight (0.1% on BTC, 0.2% on Crash/Boom)
// - Hold time: Seconds to minutes, not hours
// - Win rate target: 60-70% with small winners

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _minuteTradeCount: 0,
    _minuteStart: Date.now(),
    _lastDebugLog: 0,
    _consecutiveLosses: 0,
    
    CONFIG: {
        MIN_GAP_MS: 30000,              // 30 seconds between signals
        MAX_TRADES_PER_MINUTE: 2,       // Max 2 trades per minute
        MAX_CONCURRENT_TRADES: 1,       // Only 1 trade at a time
        MIN_BODY_RATIO: 0.3,            // 30% body minimum
        STOP_ATR_MULT: 0.5,             // Very tight stop (0.5x ATR)
        TARGET_ATR_MULT: 0.8,           // Small target (0.8x ATR)
        MAX_CONSECUTIVE_LOSSES: 5,       // Stop after 5 losses
    },
    
    _getBodyDirection(candle) {
        if (!candle) return null;
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
        return null;
    },
    
    _hasMeaningfulBody(candle) {
        const range = candle.high - candle.low;
        if (range === 0) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > this.CONFIG.MIN_BODY_RATIO;
    },
    
    _canTradeMinute() {
        const now = Date.now();
        if (now - this._minuteStart > 60000) {
            this._minuteTradeCount = 0;
            this._minuteStart = now;
        }
        return this._minuteTradeCount < this.CONFIG.MAX_TRADES_PER_MINUTE;
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
    
    recordOutcome(symbol, outcome, pnl, entry, sl, tp, exitPrice) {
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
            console.log(`[UltraScalper] ✅ WIN on ${symbol} | +$${Math.abs(pnl).toFixed(2)} | Entry: ${entry} | Exit: ${exitPrice}`);
        } else {
            this._consecutiveLosses++;
            console.log(`[UltraScalper] ❌ LOSS on ${symbol} | -$${Math.abs(pnl).toFixed(2)} | Entry: ${entry} | Exit: ${exitPrice} | Streak: ${this._consecutiveLosses}`);
        }
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        const now = Date.now();
        
        // Log every 10 seconds to show we're alive
        if (now - this._lastDebugLog > 10000) {
            console.log(`[UltraScalper] 🔍 SCANNING ${symbol} | Candles: ${candles?.length} | ATR: ${atr?.toFixed(4)} | Last signal: ${this._lastSignalMs ? Math.round((now - this._lastSignalMs)/1000) + 's ago' : 'never'}`);
            this._lastDebugLog = now;
        }
        
        // ── BASIC CHECKS ─────────────────────────────────────────
        if (!atr || !candles || candles.length < 10) {
            return null;
        }
        
        // Rate limiting
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) {
            return null;
        }
        
        if (!this._canTradeMinute()) {
            return null;
        }
        
        if (!this._canAddTrade(symbol)) {
            return null;
        }
        
        if (this._consecutiveLosses >= this.CONFIG.MAX_CONSECUTIVE_LOSSES) {
            console.log(`[UltraScalper] ⏸️ ${symbol} | ${this._consecutiveLosses} consecutive losses - cooling down`);
            return null;
        }
        
        // ── SIMPLE MOMENTUM ENTRY (M1 timeframe) ─────────────────
        // Use the last 2 closed candles and current forming candle
        const c1 = candles[candles.length - 3];  // 3rd last
        const c2 = candles[candles.length - 2];  // last closed
        const live = candles[candles.length - 1]; // current forming
        
        if (!c1 || !c2 || !live) return null;
        
        const dir1 = this._getBodyDirection(c1);
        const dir2 = this._getBodyDirection(c2);
        
        // Need both closed candles in same direction
        if (!dir1 || !dir2 || dir1 !== dir2) return null;
        
        // Need meaningful bodies (not dojis)
        if (!this._hasMeaningfulBody(c1) || !this._hasMeaningfulBody(c2)) return null;
        
        // Live candle moving in same direction
        const liveDirection = live.close > c2.close ? 'BUY' : live.close < c2.close ? 'SELL' : null;
        if (liveDirection !== dir1) return null;
        
        // ── CRASH/BOOM DIRECTION FILTER ──────────────────────────
        const isCrash = symbol.includes('CRASH');
        const isBoom = symbol.includes('BOOM');
        
        if (isCrash && dir1 === 'BUY') {
            console.log(`[UltraScalper] 🚫 ${symbol} | Filtered: CRASH only SELL (trends DOWN)`);
            return null;
        }
        if (isBoom && dir1 === 'SELL') {
            console.log(`[UltraScalper] 🚫 ${symbol} | Filtered: BOOM only BUY (trends UP)`);
            return null;
        }
        
        // ── CALCULATE TP/SL (VERY TIGHT FOR SCALPING) ────────────
        const price = c2.close;
        let slDist, tpDist;
        
        if (symbol.includes('BTC') || symbol.includes('cryBTCUSD')) {
            // BTC: 0.08% stop, 0.12% target (1.5:1 R:R)
            slDist = price * 0.0008;   // 8 pips on BTC
            tpDist = price * 0.0012;   // 12 pips target
        } else if (symbol.includes('CRASH') || symbol.includes('BOOM')) {
            // Crash/Boom: 0.15% stop, 0.25% target
            slDist = price * 0.0015;
            tpDist = price * 0.0025;
        } else {
            // Default: use ATR with very tight multipliers
            slDist = atr * 0.3;
            tpDist = atr * 0.5;
        }
        
        // Ensure minimum distances (prevent 0-distance trades)
        slDist = Math.max(slDist, 0.1);
        tpDist = Math.max(tpDist, 0.15);
        
        // ── FIRE THE SIGNAL ──────────────────────────────────────
        this._lastSignalMs = now;
        this._minuteTradeCount++;
        this.addTrade(symbol);
        
        console.log(`[UltraScalper] 🚀 SCALP ${dir1} on ${symbol} | Price: ${price.toFixed(2)} | SL: ${slDist.toFixed(4)} away | TP: ${tpDist.toFixed(4)} away`);
        
        return {
            type: dir1,
            label: `SCALP ${dir1 === 'BUY' ? '▲' : '▼'}`,
            score: 70,
            factors: [`${dir1} momentum`, `Tight TP/SL`],
            tpMultiplier: tpDist / atr,
            slMultiplier: slDist / atr,
            _slDist: slDist,
            _tpDist: tpDist,
            isUltraScalper: true,
        };
    },
    
    applyTrailingStop(openSignal, currentPrice, atr, currentProfit) {
        // No trailing stop for scalper - just take the quick TP
        return null;
    },
    
    reset() {
        this._lastSignalMs = 0;
        this._activeTrades.clear();
        this._minuteTradeCount = 0;
        this._minuteStart = Date.now();
        this._consecutiveLosses = 0;
        console.log(`[UltraScalper] 🔄 Reset complete`);
    }
};