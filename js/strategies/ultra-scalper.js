// Ultra Scalper v2 — Enhanced Safe-Aggressive Strategy
//
// DESIGN PHILOSOPHY:
//   - Fires on CLEAR momentum only (not noise)
//   - Multiple confirmation layers prevent false signals
//   - Position limits prevent overtrading
//   - Dynamic R:R based on momentum strength
//   - Cooldown periods prevent revenge trading
//
// ENTRY CONDITIONS (ALL must be true):
//   1. 3 consecutive candles in same direction (micro trend)
//   2. Current candle body > 40% of range (not a doji)
//   3. Volume expansion (if available) or range expansion
//   4. No opposing wick on trigger candle
//   5. ATR minimum threshold (avoid dead market)
//
// RISK MANAGEMENT:
//   - Max 3 concurrent trades per symbol
//   - 10-second minimum between signals
//   - Dynamic R:R: 1:1 for weak momentum, 2:1 for strong
//   - Trailing stop after 1x ATR profit
//   - Max 8 trades per hour

export const UltraScalper = {
    
    // State tracking
    _lastSignalMs: 0,
    _activeTrades: new Map(), // symbol -> count
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _consecutiveLosses: 0,
    
    // Configuration
    CONFIG: {
        MIN_GAP_MS: 10000,              // 10 seconds between signals
        MIN_ATR: 2.0,                   // Minimum ATR in price units
        MIN_BODY_RATIO: 0.4,            // Body must be 40%+ of range
        MIN_VOLUME_RATIO: 0.8,          // Volume > 80% of average (if available)
        MAX_CONCURRENT_TRADES: 3,       // Max 3 trades per symbol
        MAX_TRADES_PER_HOUR: 8,         // Max 8 trades per hour
        MAX_CONSECUTIVE_LOSSES: 3,      // Cooldown after 3 losses
        LOSS_COOLDOWN_MS: 300000,       // 5 minute cooldown after losses
        TRAILING_START: 1.0,            // Start trailing after 1x ATR profit
        TRAILING_DISTANCE: 0.5,         // Trail by 0.5x ATR
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get body direction
    // ─────────────────────────────────────────────────────────────
    _getBodyDirection(candle) {
        if (!candle) return null;
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check if body is meaningful (not a doji)
    // ─────────────────────────────────────────────────────────────
    _hasMeaningfulBody(candle, minRatio = null) {
        const ratio = minRatio || this.CONFIG.MIN_BODY_RATIO;
        const range = candle.high - candle.low;
        if (range === 0) return false;
        const body = Math.abs(candle.close - candle.open);
        return body / range > ratio;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check for opposing wick (rejection)
    // Returns true if wick opposes the direction (bad for continuation)
    // ─────────────────────────────────────────────────────────────
    _hasOpposingWick(candle, direction) {
        if (direction === 'BUY') {
            // For BUY, a long upper wick means rejection
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            const body = Math.abs(candle.close - candle.open);
            return upperWick > body * 0.8;
        } else {
            // For SELL, a long lower wick means rejection
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            const body = Math.abs(candle.close - candle.open);
            return lowerWick > body * 0.8;
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check volume confirmation
    // ─────────────────────────────────────────────────────────────
    _volumeConfirmed(candles, minRatio = null) {
        const ratio = minRatio || this.CONFIG.MIN_VOLUME_RATIO;
        
        // If no volume data, skip check (return true)
        if (!candles[0] || typeof candles[0].volume === 'undefined') return true;
        
        const recentVol = candles.slice(-10).map(c => c.volume || 0);
        const avgVol = recentVol.reduce((a, b) => a + b, 0) / 10;
        const currentVol = candles[candles.length - 2]?.volume || 0;
        
        return currentVol > avgVol * ratio;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Check range expansion (volatility increasing)
    // ─────────────────────────────────────────────────────────────
    _rangeExpanding(candles) {
        if (candles.length < 6) return true;
        
        const c1 = candles[candles.length - 3];
        const c2 = candles[candles.length - 2];
        const c3 = candles[candles.length - 1];
        
        const range1 = c1.high - c1.low;
        const range2 = c2.high - c2.low;
        const range3 = c3.high - c3.low;
        
        // At least 2 of last 3 candles show expanding range
        let expanding = 0;
        if (range2 > range1) expanding++;
        if (range3 > range2) expanding++;
        
        return expanding >= 2;
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Get momentum strength (0-100)
    // ─────────────────────────────────────────────────────────────
    _getMomentumStrength(candles, direction, atr) {
        let score = 50;
        
        const c1 = candles[candles.length - 3];
        const c2 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        // Body size bonus
        const body2 = Math.abs(c2.close - c2.open);
        const bodyRatio = body2 / atr;
        if (bodyRatio > 1.0) score += 20;
        else if (bodyRatio > 0.7) score += 10;
        
        // Consecutive candles bonus
        const c0 = candles[candles.length - 4];
        if (c0 && this._getBodyDirection(c0) === direction) score += 10;
        
        // Range expansion bonus
        if (this._rangeExpanding(candles)) score += 10;
        
        // Price acceleration
        const move1 = Math.abs(c2.close - c1.close);
        const move2 = Math.abs(live.close - c2.close);
        if (move2 > move1 * 1.2) score += 10;
        
        return Math.min(100, score);
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Track active trades per symbol
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
    // HELPER: Check loss cooldown
    // ─────────────────────────────────────────────────────────────
    _isInLossCooldown() {
        if (this._consecutiveLosses < this.CONFIG.MAX_CONSECUTIVE_LOSSES) return false;
        
        // First loss after hitting limit — start cooldown
        if (!this._cooldownEndTime) {
            this._cooldownEndTime = Date.now() + this.CONFIG.LOSS_COOLDOWN_MS;
            console.log(`[UltraScalper] Loss cooldown: ${this.CONFIG.LOSS_COOLDOWN_MS / 1000}s after ${this._consecutiveLosses} losses`);
            return true;
        }
        
        // Check if cooldown is over
        if (Date.now() > this._cooldownEndTime) {
            this._consecutiveLosses = 0;
            this._cooldownEndTime = null;
            return false;
        }
        
        return true;
    },
    
    recordOutcome(outcome) {
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
            this._cooldownEndTime = null;
        } else {
            this._consecutiveLosses++;
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ─────────────────────────────────────────────────────────────
    checkEntry(candles, atr, symbol = 'unknown') {
        // ── Basic validations ───────────────────────────────────
        if (!atr || candles.length < 6) return null;
        if (atr < this.CONFIG.MIN_ATR) return null;
        
        // ── Loss cooldown check ─────────────────────────────────
        if (this._isInLossCooldown()) return null;
        
        // ── Rate limits ─────────────────────────────────────────
        const now = Date.now();
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) return null;
        if (!this._canTradeHourly()) return null;
        if (!this._canAddTrade(symbol)) return null;
        
        // ── Get candles ─────────────────────────────────────────
        const c1 = candles[candles.length - 4]; // 4th last (older closed)
        const c2 = candles[candles.length - 3]; // 3rd last closed
        const c3 = candles[candles.length - 2]; // last closed
        const live = candles[candles.length - 1]; // forming now
        
        if (!c1 || !c2 || !c3 || !live) return null;
        
        // ── Direction check (3 consecutive candles same direction) ──
        const dir1 = this._getBodyDirection(c2);
        const dir2 = this._getBodyDirection(c3);
        const liveDir = live.close > c3.close ? 'BUY' : live.close < c3.close ? 'SELL' : null;
        
        // Need all three aligned
        if (!dir1 || !dir2 || !liveDir) return null;
        if (dir1 !== dir2 || dir2 !== liveDir) return null;
        
        // ── Body quality checks ──────────────────────────────────
        if (!this._hasMeaningfulBody(c2)) return null;
        if (!this._hasMeaningfulBody(c3)) return null;
        
        // Live candle must have meaningful move already (not just tick)
        const liveMove = Math.abs(live.close - live.open);
        const liveRange = live.high - live.low;
        if (liveRange > 0 && liveMove / liveRange < 0.3) return null;
        
        // ── Opposing wick check (prevents false breakouts) ───────
        if (this._hasOpposingWick(c3, dir1)) return null;
        
        // ── Volume confirmation (if available) ───────────────────
        if (!this._volumeConfirmed(candles)) return null;
        
        // ── Range expansion (momentum increasing) ────────────────
        if (!this._rangeExpanding(candles)) return null;
        
        // ── Get momentum strength for dynamic sizing ─────────────
        const momentumStrength = this._getMomentumStrength(candles, dir1, atr);
        
        // ── Dynamic R:R based on momentum ────────────────────────
        let tpMult, slMult, label;
        if (momentumStrength >= 75) {
            tpMult = 2.0;
            slMult = 1.0;
            label = `STRONG ${dir1 === 'BUY' ? '▲' : '▼'}⚡`;
        } else if (momentumStrength >= 60) {
            tpMult = 1.5;
            slMult = 1.0;
            label = `MOD ${dir1 === 'BUY' ? '▲' : '▼'}⚡`;
        } else {
            tpMult = 1.0;
            slMult = 1.0;
            label = `FAST ${dir1 === 'BUY' ? '▲' : '▼'}⚡`;
        }
        
        // ── Record trade ─────────────────────────────────────────
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        const factors = [
            `${dir1} momentum`,
            `${momentumStrength >= 75 ? 'Strong' : momentumStrength >= 60 ? 'Moderate' : 'Fast'}`,
            `${tpMult}:1 R:R`,
            `Consecutive: ${this._getConsecutiveDirection(candles, dir1)}`
        ];
        
        console.log(`[UltraScalper] 🔥 ${dir1} on ${symbol} | ${factors.join(' · ')} | Strength: ${Math.round(momentumStrength)}`);
        
        return {
            type: dir1,
            label: `ULTRA ${label}`,
            score: Math.round(momentumStrength),
            factors: factors,
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isUltraScalper: true,
            momentumStrength: momentumStrength,
            _meta: { momentumStrength, tpMult, slMult }
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
    // TRAILING STOP LOGIC (call this on each bar when in trade)
    // ─────────────────────────────────────────────────────────────
    applyTrailingStop(openSignal, currentPrice, atr) {
        if (!openSignal || !openSignal.isUltraScalper) return null;
        
        const { type, entry, tp, sl } = openSignal;
        const inProfit = type === 'BUY' ? currentPrice - entry : entry - currentPrice;
        
        // Only trail after reaching 1x ATR profit
        if (inProfit < this.CONFIG.TRAILING_START * atr) return null;
        
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
    }
};