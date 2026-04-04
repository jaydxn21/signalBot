// Ultra Scalper v3.0 — With Detailed Loss Debugging
//
// This version logs EVERY decision point so you can see:
//   1. Why a trade was taken
//   2. Why a trade lost (was SL too tight? Wrong direction? Bad entry?)
//   3. What the market conditions were at entry

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _consecutiveLosses: 0,
    _cooldownEndTime: null,
    _lastResetDate: null,
    _symbolState: new Map(),
    
    // Trade logging
    _lastTradeLog: null,
    
    CONFIG: {
        MIN_GAP_MS: 5000,
        MIN_ATR: 0.5,
        MIN_BODY_RATIO: 0.25,
        MAX_CONCURRENT_TRADES: 3,
        MAX_TRADES_PER_HOUR: 10,
        MAX_CONSECUTIVE_LOSSES: 3,
        LOSS_COOLDOWN_MS: 120000,  // 2 minutes
        TRAILING_START: 0.5,
        TRAILING_DISTANCE: 0.3,
        MIN_CANDLE_RANGE: 0.1,
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
            console.log(`[UltraScalper] Daily reset — fresh state`);
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
            return upperWick > body * 1.2;
        } else {
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            return lowerWick > body * 1.2;
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
            console.log(`[UltraScalper] ${symbol} loss cooldown: ${this.CONFIG.LOSS_COOLDOWN_MS / 1000}s`);
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
        
        // Log detailed trade outcome
        const tradeLog = {
            time: new Date().toISOString(),
            symbol,
            outcome,
            pnl: pnl.toFixed(4),
            entry: entry.toFixed(4),
            sl: sl.toFixed(4),
            tp: tp.toFixed(4),
            exitPrice: exitPrice.toFixed(4),
            lossStreak: state.consecutiveLosses + (outcome === 'SL' ? 1 : 0)
        };
        
        state.tradeHistory.push(tradeLog);
        if (state.tradeHistory.length > 20) state.tradeHistory.shift();
        
        // Log to console
        console.log(`[UltraScalper] 📊 ${outcome} on ${symbol} | PnL: ${outcome === 'TP' ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} | Entry: ${entry.toFixed(4)} | Exit: ${exitPrice.toFixed(4)} | Loss streak: ${tradeLog.lossStreak}`);
        
        if (outcome === 'TP') {
            state.consecutiveLosses = 0;
            state.cooldownEnd = null;
            this._consecutiveLosses = 0;
        } else {
            state.consecutiveLosses++;
            this._consecutiveLosses++;
            
            // Log why the trade might have lost
            console.log(`[UltraScalper] 🔍 Loss analysis for ${symbol}:`);
            console.log(`   - Stop loss: ${sl.toFixed(4)} (${Math.abs(entry - sl).toFixed(4)} points away)`);
            console.log(`   - Take profit: ${tp.toFixed(4)} (${Math.abs(tp - entry).toFixed(4)} points away)`);
            console.log(`   - R:R: ${(Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)}:1`);
        }
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        this._checkDailyReset();
        
        // ── LOG 1: Basic conditions ─────────────────────────────
        if (!atr || candles.length < 5) {
            console.log(`[UltraScalper] ❌ ${symbol} | No ATR or insufficient candles`);
            return null;
        }
        
        if (atr < this.CONFIG.MIN_ATR) {
            console.log(`[UltraScalper] ❌ ${symbol} | ATR too low: ${atr.toFixed(2)} < ${this.CONFIG.MIN_ATR}`);
            return null;
        }
        
        if (this._isSymbolInLossCooldown(symbol)) {
            console.log(`[UltraScalper] ❌ ${symbol} | In loss cooldown`);
            return null;
        }
        
        const now = Date.now();
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) {
            // Don't log every time, only every 10 seconds
            if (Math.floor(now / 10000) !== Math.floor(this._lastDebugLog / 10000)) {
                console.log(`[UltraScalper] ❌ ${symbol} | Rate limit (${(now - this._lastSignalMs) / 1000}s since last signal)`);
                this._lastDebugLog = now;
            }
            return null;
        }
        
        if (!this._canTradeHourly()) {
            console.log(`[UltraScalper] ❌ ${symbol} | Hourly limit reached (${this._hourlyTradeCount}/${this.CONFIG.MAX_TRADES_PER_HOUR})`);
            return null;
        }
        
        if (!this._canAddTrade(symbol)) {
            console.log(`[UltraScalper] ❌ ${symbol} | Max concurrent trades (${this._activeTrades.get(symbol) || 0}/${this.CONFIG.MAX_CONCURRENT_TRADES})`);
            return null;
        }
        
        // ── LOG 2: Candles ─────────────────────────────────────
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        if (!c2 || !c3 || !live) {
            console.log(`[UltraScalper] ❌ ${symbol} | Missing candle data`);
            return null;
        }
        
        // Log candle details for debugging
        const dir2 = this._getBodyDirection(c2);
        const dir3 = this._getBodyDirection(c3);
        const liveDir = this._getLiveDirection(live, c3.close);
        
        console.log(`[UltraScalper] 🔍 ${symbol} | Candle2: ${dir2} (O:${c2.open.toFixed(4)} C:${c2.close.toFixed(4)}) | Candle3: ${dir3} | Live: ${liveDir}`);
        
        // ── LOG 3: Direction check ─────────────────────────────
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
            console.log(`[UltraScalper] ❌ ${symbol} | No direction alignment | d2:${dir2} d3:${dir3} live:${liveDir}`);
            return null;
        }
        
        // ── LOG 4: Body quality ────────────────────────────────
        if (!this._hasMeaningfulBody(c3)) {
            const range = c3.high - c3.low;
            const body = Math.abs(c3.close - c3.open);
            console.log(`[UltraScalper] ❌ ${symbol} | Candle3 body too small: ${(body/range*100).toFixed(0)}% < ${this.CONFIG.MIN_BODY_RATIO*100}%`);
            return null;
        }
        
        // ── LOG 5: Opposing wick ───────────────────────────────
        if (this._hasOpposingWick(c3, direction)) {
            console.log(`[UltraScalper] ❌ ${symbol} | Opposing wick on candle3`);
            return null;
        }
        
        // ── LOG 6: Momentum strength ───────────────────────────
        const bodySize = Math.abs(c3.close - c3.open);
        const bodyRatio = bodySize / atr;
        let momentumStrength = 50;
        if (bodyRatio > 0.5) momentumStrength = 70;
        else if (bodyRatio > 0.3) momentumStrength = 60;
        
        console.log(`[UltraScalper] ✅ ${symbol} | All checks passed! Momentum: ${momentumStrength} | Body: ${(bodySize/atr).toFixed(1)}x ATR`);
        
        // ── LOG 7: Final decision ──────────────────────────────
        let tpMult, slMult;
        if (momentumStrength >= 60) {
            tpMult = 1.5;
            slMult = 1.0;
        } else {
            tpMult = 1.0;
            slMult = 1.0;
        }
        
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        console.log(`[UltraScalper] 🚀 TAKING ${direction} on ${symbol} | TP: ${tpMult}:1 | SL: ${slMult}:1 | ATR: ${atr.toFixed(2)}`);
        
        return {
            type: direction,
            label: `ULTRA ${direction === 'BUY' ? '▲' : '▼'}`,
            score: momentumStrength,
            factors: [`${direction}`, `${tpMult}:1 R:R`, `Body ${(bodySize/atr).toFixed(1)}x ATR`],
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isUltraScalper: true,
            momentumStrength: momentumStrength,
        };
    },
    
    applyTrailingStop(openSignal, currentPrice, atr, currentProfit) {
        return null; // Disabled for debugging
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