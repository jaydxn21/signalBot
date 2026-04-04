// Ultra Scalper v7.0 — Fixed Stop Loss Distance

export const UltraScalper = {
    
    _lastSignalMs: 0,
    _activeTrades: new Map(),
    _hourlyTradeCount: 0,
    _hourStart: Date.now(),
    _lastDebugLog: 0,
    
    CONFIG: {
        MIN_GAP_MS: 60000,
        MIN_ATR: 0.01,
        MIN_BODY_RATIO: 0.15,
        MAX_CONCURRENT_TRADES: 1,
        MAX_TRADES_PER_HOUR: 3,
        MIN_CANDLE_RANGE: 0.001,
        // FIXED: Much wider stops
        STOP_ATR_MULT: 2.0,      // 2x ATR stop (was 0.8)
        TARGET_ATR_MULT: 2.0,    // 2x ATR target (1:1 R:R for testing)
    },
    
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
        
        if (price > ema20 && ema20 > ema50) return 'BUY';
        if (price < ema20 && ema20 < ema50) return 'SELL';
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
        console.log(`[UltraScalper] ${outcome} on ${symbol} | PnL: ${outcome === 'TP' ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} | Entry: ${entry} | SL: ${sl} | TP: ${tp} | Exit: ${exitPrice}`);
    },
    
    checkEntry(candles, atr, symbol = 'unknown') {
        const now = Date.now();
        
        // DEBUG: Log ATR value
        console.log(`[UltraScalper] 🔍 ${symbol} | ATR value: ${atr?.toFixed(4)} | Candles: ${candles?.length}`);
        
        if (!atr || !candles || candles.length < 50) return null;
        if (atr < this.CONFIG.MIN_ATR) return null;
        if (now - this._lastSignalMs < this.CONFIG.MIN_GAP_MS) return null;
        if (!this._canTradeHourly()) return null;
        if (!this._canAddTrade(symbol)) return null;
        
        // Trend filter
        const trendDirection = this._getTrendDirection(candles);
        if (!trendDirection) return null;
        
        const c3 = candles[candles.length - 2];
        if (!c3) return null;
        
        const candleDirection = this._getBodyDirection(c3);
        if (!candleDirection) return null;
        
        // Must trade with trend
        if (candleDirection !== trendDirection) return null;
        
        // Crash/Boom filter
        const isCrash = symbol.includes('CRASH');
        const isBoom = symbol.includes('BOOM');
        
        if (isCrash && candleDirection === 'BUY') return null;
        if (isBoom && candleDirection === 'SELL') return null;
        
        if (!this._hasMeaningfulBody(c3)) return null;
        
        // ── ALL CHECKS PASSED ─────────────────────────────────
        this._lastSignalMs = now;
        this._hourlyTradeCount++;
        this.addTrade(symbol);
        
        // Use FIXED multipliers (not ATR-based if ATR is wrong)
        // For BTC, use price-based stops (0.5% instead of ATR)
        const price = c3.close;
        let slDist, tpDist;
        
        if (symbol.includes('BTC') || symbol.includes('cryBTCUSD')) {
            // BTC: 0.3% stop, 0.6% target (2:1 R:R)
            slDist = price * 0.003;
            tpDist = price * 0.006;
        } else if (symbol.includes('CRASH') || symbol.includes('BOOM')) {
            // Crash/Boom: 0.5% stop, 1.0% target (2:1 R:R)
            slDist = price * 0.005;
            tpDist = price * 0.010;
        } else {
            // Default: use ATR with wider multiplier
            slDist = atr * this.CONFIG.STOP_ATR_MULT;
            tpDist = atr * this.CONFIG.TARGET_ATR_MULT;
        }
        
        console.log(`[UltraScalper] 🚀 FIRING ${candleDirection} on ${symbol} | Price: ${price.toFixed(2)} | SL dist: ${slDist.toFixed(2)} | TP dist: ${tpDist.toFixed(2)}`);
        
        return {
            type: candleDirection,
            label: `ULTRA ${candleDirection === 'BUY' ? '▲' : '▼'} [Trend]`,
            score: 70,
            factors: [`${candleDirection} with trend`, `2:1 R:R`],
            tpMultiplier: tpDist / atr,  // This might be huge if ATR is wrong, but fireSignal will use tpDist directly
            slMultiplier: slDist / atr,
            // Pass the actual distances so fireSignal can use them
            _slDist: slDist,
            _tpDist: tpDist,
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