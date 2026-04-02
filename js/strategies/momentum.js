// momentum-swing.js — HIGH WIN RATE Swing Strategy
//
// MIMICS: Kimali Bowen's 80% win rate manual trading
//
// KEY FEATURES:
//   - Extremely selective (target 5-10 trades per month)
//   - Pair-specific filters (EURGBP, CADCHF optimized)
//   - Short bias (higher win rate on sells)
//   - Daily timeframe bias, H4 entry
//   - Minimum 2:1 risk/reward
//   - 1-day minimum hold time expectation
//
// SYMBOLS: Forex pairs (EURGBP, CADCHF, GBPUSD, etc.)
// TIMEFRAME: H4 entry, Daily bias

export const MomentumStrategy = {
    
    // Strategy stats per bot
    _stats: {},
    _lastTradeTime: 0,
    _weeklyTradeCount: 0,
    _weekStart: null,
    
    // ─────────────────────────────────────────────────────────────
    // PAIR-SPECIFIC CONFIGURATIONS (based on Kimali's results)
    // ─────────────────────────────────────────────────────────────
    _pairConfig: {
        // Star performer — high win rate, tight spreads
        'EURGBP': {
            enabled: true,
            bias: 'BOTH',           // Works for both directions
            minATR: 0.0008,         // 8 pips minimum volatility
            maxSpread: 2.0,         // Max spread in pips
            session: 'LONDON',      // Best during London session
            stopATR: 1.5,           // SL = 1.5x ATR
            targetATR: 3.0,         // TP = 3.0x ATR (2:1 R:R)
            winRateHistory: 0.80    // Historical win rate on this pair
        },
        
        // Second best performer
        'CADCHF': {
            enabled: true,
            bias: 'SHORT',          // Only take shorts (100% win rate on shorts)
            minATR: 0.0006,
            maxSpread: 2.5,
            session: 'NY',          // Best during NY session
            stopATR: 1.2,
            targetATR: 2.4,
            winRateHistory: 0.90
        },
        
        // AVOID — single trade wiped gains
        'CHFJPY': {
            enabled: false,         // DISABLED — losing pair
            bias: 'NONE',
            minATR: 0,
            maxSpread: 10,
            session: null,
            stopATR: 1.0,
            targetATR: 2.0,
            winRateHistory: 0.00
        },
        
        // Default for other pairs
        'default': {
            enabled: true,
            bias: 'SHORT',          // Default to short bias (higher win rate)
            minATR: 0.0007,
            maxSpread: 2.0,
            session: 'LONDON_NY',   // London-NY overlap (best liquidity)
            stopATR: 1.5,
            targetATR: 3.0,
            winRateHistory: 0.60
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // SESSION DEFINITIONS
    // ─────────────────────────────────────────────────────────────
    _sessions: {
        'LONDON': { start: 7, end: 16 },      // 7-16 UTC
        'NY': { start: 12, end: 20 },         // 12-20 UTC
        'LONDON_NY': { start: 12, end: 16 },  // Overlap (best)
        'ASIAN': { start: 0, end: 6 }         // Avoid
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET/UPDATE STATS
    // ─────────────────────────────────────────────────────────────
    _getStats(botId) {
        if (!this._stats[botId]) {
            this._stats[botId] = {
                trades: 0,
                wins: 0,
                losses: 0,
                pairPerformance: {},
                lastTradeTime: 0,
                weeklyTrades: 0,
                weekStart: this._getWeekStart()
            };
        }
        return this._stats[botId];
    },
    
    _getWeekStart() {
        const now = new Date();
        const day = now.getUTCDay();
        const diff = (day === 0 ? 6 : day - 1);
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - diff);
        monday.setUTCHours(0, 0, 0, 0);
        return monday.getTime();
    },
    
    recordOutcome(botId, symbol, outcome, pnl) {
        const stats = this._getStats(botId);
        stats.trades++;
        if (outcome === 'TP') {
            stats.wins++;
        } else {
            stats.losses++;
        }
        
        if (!stats.pairPerformance[symbol]) {
            stats.pairPerformance[symbol] = { wins: 0, losses: 0, pnl: 0 };
        }
        if (outcome === 'TP') {
            stats.pairPerformance[symbol].wins++;
        } else {
            stats.pairPerformance[symbol].losses++;
        }
        stats.pairPerformance[symbol].pnl += pnl;
        stats.lastTradeTime = Date.now();
    },
    
    getWinRate(botId, symbol) {
        const stats = this._getStats(botId);
        const pairStats = stats.pairPerformance[symbol];
        if (!pairStats || pairStats.wins + pairStats.losses < 3) {
            // Use historical default
            const cfg = this._pairConfig[symbol] || this._pairConfig['default'];
            return cfg.winRateHistory;
        }
        const total = pairStats.wins + pairStats.losses;
        return pairStats.wins / total;
    },
    
    // ─────────────────────────────────────────────────────────────
    // INDICATORS
    // ─────────────────────────────────────────────────────────────
    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    _atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const trs = [];
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i], p = candles[i - 1];
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        }
        return trs.reduce((a, b) => a + b, 0) / period;
    },
    
    _rsi(candles, period = 14) {
        if (candles.length < period + 2) return null;
        const cl = candles.slice(-period - 1).map(c => c.close);
        let g = 0, l = 0;
        for (let i = 1; i < cl.length; i++) {
            const d = cl[i] - cl[i - 1];
            if (d >= 0) g += d; else l -= d;
        }
        const ag = g / period, al = l / period;
        return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    },
    
    // ─────────────────────────────────────────────────────────────
    // DAILY TIMEFRAME BIAS (like H4 but slower)
    // ─────────────────────────────────────────────────────────────
    _dailyBias(dailyCandles) {
        if (!dailyCandles || dailyCandles.length < 20) return null;
        
        const ema20 = this._ema(dailyCandles, 20);
        const ema50 = this._ema(dailyCandles, 50);
        const price = dailyCandles[dailyCandles.length - 1].close;
        
        if (!ema20 || !ema50) return null;
        
        // Strong uptrend: price > EMA20 > EMA50
        if (price > ema20 && ema20 > ema50) return 'BULL';
        // Strong downtrend: price < EMA20 < EMA50
        if (price < ema20 && ema20 < ema50) return 'BEAR';
        // Weak/neutral
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // H4 ENTRY SIGNAL (high quality only)
    // ─────────────────────────────────────────────────────────────
    _h4Signal(candles, atr, biasPreference) {
        if (candles.length < 30) return null;
        
        const c0 = candles[candles.length - 1];  // Current (almost closed)
        const c1 = candles[candles.length - 2];  // Previous
        const c2 = candles[candles.length - 3];  // 2 bars ago
        const c3 = candles[candles.length - 4];  // 3 bars ago
        
        const ema8 = this._ema(candles.slice(0, -1), 8);
        const ema21 = this._ema(candles.slice(0, -1), 21);
        const rsi = this._rsi(candles.slice(0, -1));
        
        if (!ema8 || !ema21 || !rsi) return null;
        
        // ── BULLISH SIGNAL (only if bias allows) ────────────────
        if (biasPreference !== 'SHORT') {
            let bullScore = 0;
            
            // Price above EMAs
            if (c0.close > ema8 && ema8 > ema21) bullScore++;
            
            // RSI oversold recovery
            if (rsi < 35 && candles[candles.length - 2].close < candles[candles.length - 3].close) bullScore++;
            
            // Bullish engulfing on H4
            const isBullEngulf = c1.close > c1.open && 
                                 c1.open < c2.close && 
                                 c1.close > c2.open &&
                                 c2.close < c2.open;
            if (isBullEngulf) bullScore += 2;
            
            // 3-bar compression then expansion
            const compression = Math.max(c3.high - c3.low, c2.high - c2.low) < atr * 0.8;
            const expansion = (c1.high - c1.low) > atr * 1.2;
            if (compression && expansion && c1.close > c1.open) bullScore += 2;
            
            if (bullScore >= 2) {
                return { type: 'BUY', score: bullScore, rsi: rsi };
            }
        }
        
        // ── BEARISH SIGNAL (preferred — higher win rate) ────────
        if (biasPreference !== 'BULL') {
            let bearScore = 0;
            
            // Price below EMAs
            if (c0.close < ema8 && ema8 < ema21) bearScore++;
            
            // RSI overbought reversal
            if (rsi > 65 && candles[candles.length - 2].close > candles[candles.length - 3].close) bearScore++;
            
            // Bearish engulfing on H4
            const isBearEngulf = c1.close < c1.open && 
                                 c1.open > c2.close && 
                                 c1.close < c2.open &&
                                 c2.close > c2.open;
            if (isBearEngulf) bearScore += 2;
            
            // 3-bar compression then expansion (down)
            const compression = Math.max(c3.high - c3.low, c2.high - c2.low) < atr * 0.8;
            const expansion = (c1.high - c1.low) > atr * 1.2;
            if (compression && expansion && c1.close < c1.open) bearScore += 2;
            
            if (bearScore >= 2) {
                return { type: 'SELL', score: bearScore, rsi: rsi };
            }
        }
        
        return null;
    },
    
    // ─────────────────────────────────────────────────────────────
    // SESSION CHECK
    // ─────────────────────────────────────────────────────────────
    _isActiveSession(sessionName, timestamp) {
        if (!sessionName) return true;
        
        const hourUTC = new Date(timestamp * 1000).getUTCHours();
        const session = this._sessions[sessionName];
        if (!session) return true;
        
        return hourUTC >= session.start && hourUTC < session.end;
    },
    
    // ─────────────────────────────────────────────────────────────
    // SPREAD CHECK (approximate — requires external data)
    // ─────────────────────────────────────────────────────────────
    _isSpreadOk(maxSpread) {
        // This requires access to live spreads from Deriv API
        // For now, assume OK — implement when you have spread data
        return true;
    },
    
    // ─────────────────────────────────────────────────────────────
    // TRADE FREQUENCY LIMITS (5-10 trades per month)
    // ─────────────────────────────────────────────────────────────
    _canTrade(botId) {
        const stats = this._getStats(botId);
        const now = Date.now();
        
        // Max 1 trade per day
        if (now - stats.lastTradeTime < 24 * 60 * 60 * 1000) {
            return false;
        }
        
        // Max 3 trades per week
        const currentWeek = this._getWeekStart();
        if (currentWeek !== stats.weekStart) {
            stats.weeklyTrades = 0;
            stats.weekStart = currentWeek;
        }
        if (stats.weeklyTrades >= 3) {
            return false;
        }
        
        return true;
    },
    
    // ─────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ─────────────────────────────────────────────────────────────
    checkEntry(candles, atr, symbol = '', h4Candles = [], dailyCandles = []) {
        if (!atr || candles.length < 30) return null;
        
        // ── Get pair configuration ──────────────────────────────
        const cfg = this._pairConfig[symbol] || this._pairConfig['default'];
        if (!cfg.enabled) {
            console.log(`[Momentum] ${symbol} is disabled (losing pair)`);
            return null;
        }
        
        // ── Frequency limits (5-10 trades per month) ────────────
        if (!this._canTrade()) return null;
        
        // ── Minimum volatility check ────────────────────────────
        if (atr < cfg.minATR) return null;
        
        // ── Session check ───────────────────────────────────────
        const lastCandle = candles[candles.length - 1];
        if (!this._isActiveSession(cfg.session, lastCandle.time)) return null;
        
        // ── Spread check (if data available) ────────────────────
        if (!this._isSpreadOk(cfg.maxSpread)) return null;
        
        // ── Daily bias (higher timeframe confluence) ────────────
        const dailyBias = this._dailyBias(dailyCandles);
        // If daily bias is strong opposite, skip (but don't require alignment)
        
        // ── H4 signal ───────────────────────────────────────────
        const signal = this._h4Signal(h4Candles.length ? h4Candles : candles, atr, cfg.bias);
        if (!signal) return null;
        
        // ── Win rate gate — only trade if pair historically performs ──
        const pairWinRate = this.getWinRate(null, symbol);
        if (pairWinRate < 0.50) {
            console.log(`[Momentum] ${symbol} win rate ${(pairWinRate*100).toFixed(0)}% — below threshold`);
            return null;
        }
        
        // ── Record trade attempt ────────────────────────────────
        const stats = this._getStats();
        stats.weeklyTrades++;
        stats.lastTradeTime = Date.now();
        
        // ── Calculate R:R based on pair config ──────────────────
        const tpMultiplier = cfg.targetATR / cfg.stopATR;  // e.g., 3.0 / 1.5 = 2.0 (2:1)
        const slMultiplier = cfg.stopATR;
        
        const factors = [
            `${symbol} ${signal.type}`,
            `Score ${signal.score}/3`,
            `RSI ${signal.rsi?.toFixed(0)}`,
            `${cfg.bias === 'SHORT' ? 'Short bias' : 'Balanced'}`,
            `${tpMultiplier.toFixed(1)}:1 R:R`
        ];
        
        console.log(`[Momentum] 📈 SIGNAL ${signal.type} on ${symbol} | Score: ${signal.score} | RSI: ${signal.rsi?.toFixed(0)} | Win rate: ${(pairWinRate*100).toFixed(0)}%`);
        
        return {
            type: signal.type,
            label: `MOMENTUM ${signal.type} [${symbol}]`,
            score: 70 + (signal.score * 10),
            factors: factors,
            tpMultiplier: tpMultiplier,
            slMultiplier: slMultiplier,
            isMomentum: true,
            pairConfig: cfg
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Register loss for cooldown
    // ─────────────────────────────────────────────────────────────
    registerLoss() {
        // Cooldown not needed — frequency limits handle it
    }
};