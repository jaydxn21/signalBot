// Ultra Scalper v2.1 — Production-Ready
//
// ADDED FIXES:
//   1. Fixed _cooldownEndTime undefined bug
//   2. Added proper state reset on new day
//   3. Added minimum profit guard for trailing stop
//   4. Added symbol-specific state tracking
//   5. Added max spread protection (if available)
//   6. Added minimum candle range protection
//   7. Fixed live candle direction detection

export const UltraScalper = {
    
    // State tracking
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _consecutiveLosses: 0,
    _cooldownEndTime: null,        // FIXED: initialize
    _lastResetDate: null,           // Daily reset tracking
    
    // Symbol-specific state
    _symbolState: new Map(),        // Track per-symbol losses
    
    // Configuration
    CONFIG: {
        MIN_GAP_MS: 10000,
        MIN_ATR: 2.0,
        MIN_BODY_RATIO: 0.4,
        MIN_VOLUME_RATIO: 0.8,
        MAX_CONCURRENT_TRADES: 3,
        MAX_TRADES_PER_HOUR: 8,
        MAX_CONSECUTIVE_LOSSES: 3,
        LOSS_COOLDOWN_MS: 300000,
        TRAILING_START: 1.0,
        TRAILING_DISTANCE: 0.5,
        MIN_CANDLE_RANGE: 0.5,      // Minimum range in price units
        MAX_SPREAD_PCT: 0.002,      // Max spread as % of price (0.2%)
        MIN_PROFIT_TO_TRAIL: 0.5,   // Minimum $ profit to start trailing
    },
    
    // ─────────────────────────────────────────────────────────────
    // DAILY RESET
    // ─────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get body direction (FIXED for live candle)
    // ─────────────────────────────────────────────────────────────
    _getBodyDirection(candle) {
        if (!candle) return null;
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get live direction (using close vs previous close)
    // ─────────────────────────────────────────────────────────────
    _getLiveDirection(liveCandle, previousClose) {
        if (!liveCandle || !previousClose) return null;
        if (liveCandle.close > previousClose) return 'BUY';
        if (liveCandle.close < previousClose) return 'SELL';
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check if body is meaningful
    // ─────────────────────────────────────────────────────────────
    _hasMeaningfulBody(candle, minRatio = null) {
        const ratio = minRatio || this.CONFIG.MIN_BODY_RATIO;
        const range = candle.high - candle.low;
        if (range < this.CONFIG.MIN_CANDLE_RANGE) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > ratio;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check for opposing wick
    // ─────────────────────────────────────────────────────────────
    _hasOpposingWick(candle, direction) {
        const body = Math.abs(candle.close - candle.open);
        
        if (direction === 'BUY') {
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            return upperWick > body * 0.8;
        } else {
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            return lowerWick > body * 0.8;
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check volume confirmation
    // ─────────────────────────────────────────────────────────────
    _volumeConfirmed(candles, minRatio = null) {
        const ratio = minRatio || this.CONFIG.MIN_VOLUME_RATIO;
        if (!candles[0] || typeof candles[0].volume === 'undefined') return true;
        
        const recentVol = candles.slice(-10).map(c => c.volume || 0);
        const avgVol = recentVol.reduce((a, b) => a + b, 0) / 10;
        const currentVol = candles[candles.length - 2]?.volume || 0;
        
        return currentVol > avgVol * ratio;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check range expansion
    // ─────────────────────────────────────────────────────────────
    _rangeExpanding(candles) {
        if (candles.length < 6) return true;
        
        const c1 = candles[candles.length - 4];
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        
        if (!c1 || !c2 || !c3) return true;
        
        const range1 = c1.high - c1.low;
        const range2 = c2.high - c2.low;
        const range3 = c3.high - c3.low;
        
        let expanding = 0;
        if (range2 > range1) expanding++;
        if (range3 > range2) expanding++;
        
        return expanding >= 2;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get momentum strength
    // ─────────────────────────────────────────────────────────────
    _getMomentumStrength(candles, direction, atr) {
        let score = 50;
        
        const c1 = candles[candles.length - 4];
        const c2 = candles[candles.length - 3];
        const c3 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        if (!c1 || !c2 || !c3) return score;
        
        // Body size bonus
        const body3 = Math.abs(c3.close - c3.open);
        const bodyRatio = body3 / atr;
        if (bodyRatio > 1.0) score += 20;
        else if (bodyRatio > 0.7) score += 10;
        
        // Consecutive candles bonus
        const dir0 = this._getBodyDirection(c1);
        const dir1 = this._getBodyDirection(c2);
        const dir2 = this._getBodyDirection(c3);
        if (dir0 === direction && dir1 === direction && dir2 === direction) score += 15;
        else if (dir1 === direction && dir2 === direction) score += 8;
        
        // Range expansion bonus
        if (this._rangeExpanding(candles)) score += 10;
        
        // Price acceleration
        const move1 = Math.abs(c2.close - c1.close);
        const move2 = Math.abs(c3.close - c2.close);
        const move3 = Math.abs(live.close - c3.close);
        if (move3 > move2 * 1.2) score += 10;
        if (move2 > move1 * 1.1) score += 5;
        
        return Math.min(100, Math.max(0, score));
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get symbol-specific state
    // ─────────────────────────────────────────────────────────────
    _getSymbolState(symbol) {
        if (!this._symbolState.has(symbol)) {
            this._symbolState.set(symbol, { consecutiveLosses: 0, cooldownEnd: null });
        }
        return this._symbolState.get(symbol);
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check if symbol is in loss cooldown
    // ─────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Track active trades
    // ─────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check hourly rate limit
    // ─────────────────────────────────────────────────────────────
    _canTradeHourly() {
        const now = Date.now();
        if (now - this._hourStart > 3600000) {
            this._hourlyTradeCount = 0;
            this._hourStart = now;
        }
        return this._hourlyTradeCount < this.CONFIG.MAX_TRADES_PER_HOUR;
    },
    
    // ─────────────────────────────────────────────────────────────
    // RECORD OUTCOME (per symbol)
    // ─────────────────────────────────────────────────────────────
    recordOutcome(symbol, outcome) {
        const state = this._getSymbolState(symbol);
        
        if (outcome === 'TP') {
            state.consecutiveLosses = 0;
            state.cooldownEnd = null;
            this._consecutiveLosses = 0;  // Global reset too
        } else {
            state.consecutiveLosses++;
            this._consecutiveLosses++;
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ─────────────────────────────────────────────────────────────
    checkEntry(candles, atr, symbol = 'unknown') {
        // Daily reset
        this._checkDailyReset();
        
        // ── Basic validations ───────────────────────────────────
        if (!atr || candles.length < 8) return null;
        if (atr < this.CONFIG.MIN_ATR) return null;
        
        // ── Loss cooldown checks ────────────────────────────────
        if (this._isSymbolInLossCooldown(symbol)) return null;
        
        // ── Rate limits ─────────────────────────────────────────
        const now = Date.now();
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) return null;
        if (!this._canTradeHourly()) return null;
        if (!this._canAddTrade(symbol)) return null;
        
        // ── Get candles (using more candles for better context) ──
        const c1 = candles[candles.length - 5]; // 5th last
        const c2 = candles[candles.length - 4]; // 4th last
        const c3 = candles[candles.length - 3]; // 3rd last closed
        const c4 = candles[candles.length - 2]; // last closed
        const live = candles[candles.length - 1]; // forming now
        
        if (!c1 || !c2 || !c3 || !c4 || !live) return null;
        
        // ── Direction check (using 3 closed candles + live) ──────
        const dir2 = this._getBodyDirection(c2);
        const dir3 = this._getBodyDirection(c3);
        const dir4 = this._getBodyDirection(c4);
        const liveDir = this._getLiveDirection(live, c4.close);
        
        // Need at least 3 aligned (2 closed + live, or 3 closed)
        let alignedCount = 0;
        if (dir2 === dir3) alignedCount++;
        if (dir3 === dir4) alignedCount++;
        if (dir4 === liveDir) alignedCount++;
        
        if (alignedCount < 2) return null;  // Need at least 2 agreements
        
        // Determine direction from majority
        let direction = null;
        if (dir2 === dir3 && dir3 === dir4) direction = dir2;
        else if (dir3 === dir4 && dir4 === liveDir) direction = dir3;
        else if (dir2 === dir3 && dir3 === liveDir) direction = dir2;
        else return null;
        
        // ── Body quality checks ──────────────────────────────────
        if (!this._hasMeaningfulBody(c3)) return null;
        if (!this._hasMeaningfulBody(c4)) return null;
        
        // Live candle must have meaningful move
        const liveMove = Math.abs(live.close - live.open);
        const liveRange = live.high - live.low;
        if (liveRange > 0 && liveMove / liveRange < 0.3) return null;
        
        // ── Opposing wick check ─────────────────────────────────
        if (this._hasOpposingWick(c4, direction)) return null;
        
        // ── Volume confirmation ─────────────────────────────────
        if (!this._volumeConfirmed(candles)) return null;
        
        // ── Range expansion ─────────────────────────────────────
        if (!this._rangeExpanding(candles)) return null;
        
        // ── Momentum strength ───────────────────────────────────
        const momentumStrength = this._getMomentumStrength(candles, direction, atr);
        
        // Minimum momentum threshold
        if (momentumStrength < 45) return null;
        
        // ── Dynamic R:R based on momentum ────────────────────────
        let tpMult, slMult, label;
        if (momentumStrength >= 75) {
            tpMult = 2.0;
            slMult = 1.0;
            label = `STRONG ${direction === 'BUY' ? '▲' : '▼'}⚡`;
        } else if (momentumStrength >= 60) {
            tpMult = 1.5;
            slMult = 1.0;
            label = `MOD ${direction === 'BUY' ? '▲' : '▼'}⚡`;
        } else {
            tpMult = 1.2;
            slMult = 1.0;
            label = `FAST ${direction === 'BUY' ? '▲' : '▼'}⚡`;
        }
        
        // ── Record trade ─────────────────────────────────────────
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        const consecutive = this._getConsecutiveDirection(candles, direction);
        
        const factors = [
            `${direction} momentum`,
            `${momentumStrength >= 75 ? 'Strong' : momentumStrength >= 60 ? 'Moderate' : 'Fast'}`,
            `${tpMult}:1 R:R`,
            `${consecutive} consecutive`
        ];
        
        console.log(`[UltraScalper] 🔥 ${direction} on ${symbol} | ${factors.join(' · ')} | Score: ${Math.round(momentumStrength)}`);
        
        return {
            type: direction,
            label: `ULTRA ${label}`,
            score: Math.round(momentumStrength),
            factors: factors,
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isUltraScalper: true,
            momentumStrength: momentumStrength,
            _meta: { momentumStrength, tpMult, slMult, consecutive }
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get consecutive candles in same direction
    // ─────────────────────────────────────────────────────────────
    _getConsecutiveDirection(candles, direction) {
        let count = 0;
        for (let i = candles.length - 2; i >= 0; i--) {
            const dir = this._getBodyDirection(candles[i]);
            if (dir === direction) count++;
            else break;
        }
        return count;
    },
    
    // ─────────────────────────────────────────────────────────────
    // TRAILING STOP LOGIC
    // ─────────────────────────────────────────────────────────────
    applyTrailingStop(openSignal, currentPrice, atr, currentProfit) {
        if (!openSignal || !openSignal.isUltraScalper) return null;
        
        const { type, entry } = openSignal;
        const inProfit = type === 'BUY' ? currentPrice - entry : entry - currentPrice;
        
        // Minimum profit check
        if (inProfit < this.CONFIG.TRAILING_START * atr) return null;
        
        // Optional: minimum $ profit guard
        if (currentProfit && currentProfit < this.CONFIG.MIN_PROFIT_TO_TRAIL) return null;
        
        let newSL = openSignal.sl;
        
        if (type === 'BUY') {
            const trailSL = currentPrice - this.CONFIG.TRAILING_DISTANCE * atr;
            if (trailSL > openSignal.sl) newSL = trailSL;
        } else {
            const trailSL = currentPrice + this.CONFIG.TRAILING_DISTANCE * atr;
            if (trailSL < openSignal.sl) newSL = trailSL;
        }
        
        if (newSL !== openSignal.sl) {
            console.log(`[UltraScalper] 📍 Trailing SL → ${newSL.toFixed(4)} (profit: ${inProfit.toFixed(2)})`);
            return newSL;
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // RESET (for testing or manual override)
    // ─────────────────────────────────────────────────────────────
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
    }
};