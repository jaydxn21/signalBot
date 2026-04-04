// Ultra Scalper v6.0 — With Trend Filter

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _lastDebugLog: 0,
    
    CONFIG: {
        MIN_GAP_MS: 60000,              // 1 minute between signals
        MIN_ATR: 0.01,
        MIN_BODY_RATIO: 0.15,
        MAX_CONCURRENT_TRADES: 1,       // Only 1 trade at a time
        MAX_TRADES_PER_HOUR: 3,
        MIN_CANDLE_RANGE: 0.001,
    },
    
    // Simple EMA calculation for trend
    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    _getTrendDirection(candles) {
        if (candles.length < 20) return null;
        const ema20 = this._ema(candles, 20);
        const ema50 = this._ema(candles, 50);
        const price = candles[candles.length - 1].close;
        
        if (!ema20 || !ema50) return null;
        
        // Strong uptrend: price > EMA20 > EMA50
        if (price > ema20 && ema20 > ema50) return 'BUY';
        // Strong downtrend: price < EMA20 < EMA50
        if (price < ema20 && ema20 < ema50) return 'SELL';
        // Weak/neutral
        return null;
    },
    
    _getBodyDirection(candle) {
        if (!candle) return null;
        if (candle.close > candle.open) return 'BUY';
        if (candle.close < candle.open) return 'SELL';
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
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        const now = Date.now();
        
        // Log every 30 seconds
        if (now - this._lastDebugLog > 30000) {
            console.log(`[UltraScalper] 🔍 ACTIVE on ${symbol} | Candles: ${candles?.length} | ATR: ${atr?.toFixed(4)}`);
            this._lastDebugLog = now;
        }
        
        // ── BASIC VALIDATIONS ─────────────────────────────────
        if (!atr || !candles || candles.length < 50) return null;
        if (atr < this.CONFIG.MIN_ATR) return null;
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) return null;
        if (!this._canTradeHourly()) return null;
        if (!this._canAddTrade(symbol)) return null;
        
        // ── TREND FILTER (CRITICAL) ────────────────────────────
        const trendDirection = this._getTrendDirection(candles);
        if (!trendDirection) {
            console.log(`[UltraScalper] ❌ ${symbol} | No clear trend direction`);
            return null;
        }
        
        // ── CANDLE DIRECTION ───────────────────────────────────
        const c3 = candles[candles.length - 2];
        const live = candles[candles.length - 1];
        
        if (!c3 || !live) return null;
        
        const candleDirection = this._getBodyDirection(c3);
        if (!candleDirection) return null;
        
        // ── CRITICAL: Only trade WITH the trend ─────────────────
        if (candleDirection !== trendDirection) {
            console.log(`[UltraScalper] ❌ ${symbol} | Candle ${candleDirection} against trend ${trendDirection} — skipping`);
            return null;
        }
        
        // ── CRASH/BOOM DIRECTION FILTER ─────────────────────────
        const isCrash = symbol.includes('CRASH');
        const isBoom = symbol.includes('BOOM');
        
        if (isCrash && candleDirection === 'BUY') {
            console.log(`[UltraScalper] ❌ ${symbol} | CRASH trends DOWN, skipping BUY`);
            return null;
        }
        if (isBoom && candleDirection === 'SELL') {
            console.log(`[UltraScalper] ❌ ${symbol} | BOOM trends UP, skipping SELL`);
            return null;
        }
        
        // ── BODY QUALITY CHECK ─────────────────────────────────
        if (!this._hasMeaningfulBody(c3)) return null;
        
        // ── ALL CHECKS PASSED - FIRE TRADE! ─────────────────────
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        const bodySize = Math.abs(c3.close - c3.open);
        const bodyAtrRatio = bodySize / atr;
        
        // Use tighter SL for trend following
        const slMult = 0.8;   // Tighter stop
        const tpMult = 1.2;   // Smaller target (quick profits)
        
        console.log(`[UltraScalper] 🚀✅ FIRING ${candleDirection} on ${symbol} | Trend: ${trendDirection} | Entry: ${c3.close.toFixed(2)} | Body: ${bodyAtrRatio.toFixed(1)}x ATR`);
        
        return {
            type: candleDirection,
            label: `ULTRA ${candleDirection === 'BUY' ? '▲' : '▼'} [Trend]`,
            score: 70,
            factors: [`${candleDirection} with trend`, `1.5:1 R:R`],
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
    }
};