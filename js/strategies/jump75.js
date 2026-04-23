// js/strategies/jump75.js - CONSERVATIVE VERSION
// Only takes high-probability setups

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _minTradeInterval: 300000, // 5 minutes minimum between trades
    _consecutiveLosses: 0,
    _maxConsecutiveLosses: 2,   // Stop after 2 losses in a row
    
    _config: {
        MIN_MOMENTUM: 1.5,          // Stronger momentum required
        MIN_BODY_RATIO: 0.65,       // Strong candle body
        MIN_RR_RATIO: 2.0,          // Must risk 1 to make 2
        REQUIRE_H4_ALIGNMENT: true, // Must align with H4 trend
        COOLDOWN_AFTER_LOSS: 180000, // 3 min cooldown after loss
    },

    _diagnostics: {
        callCount: 0,
        entriesFired: 0,
    },
    
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this._diagnostics.callCount++;
        
        // Rate limiting
        const now = Date.now();
        if (now - this._lastTradeTime < this._minTradeInterval) {
            return null;
        }
        
        // Stop trading after consecutive losses
        if (this._consecutiveLosses >= this._maxConsecutiveLosses) {
            if (this._diagnostics.callCount % 50 === 0) {
                console.log(`[Jump75] Paused - ${this._consecutiveLosses} consecutive losses`);
            }
            return null;
        }
        
        // Validate data
        if (!m5Candles || m5Candles.length < 20) return null;
        if (!m15Candles || m15Candles.length < 10) return null;
        if (!h4Candles || h4Candles.length < 5) return null;
        if (!atr || atr <= 0) return null;
        
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        const prevM5_2 = m5Candles[m5Candles.length - 3];
        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestH4 = h4Candles[h4Candles.length - 1];
        const prevH4 = h4Candles[h4Candles.length - 2];
        
        // Calculate metrics
        const m5Body = Math.abs(latestM5.close - latestM5.open);
        const m5Range = latestM5.high - latestM5.low;
        const m5BodyRatio = m5Range > 0 ? m5Body / m5Range : 0;
        const m5Direction = latestM5.close > latestM5.open ? 'UP' : 'DOWN';
        const m5Momentum = Math.abs(latestM5.close - prevM5.close) / atr;
        
        // M15 trend
        const m15Direction = latestM15.close > latestM15.open ? 'UP' : 'DOWN';
        const m15Body = Math.abs(latestM15.close - latestM15.open);
        const m15Range = latestM15.high - latestM15.low;
        const m15Strength = m15Range > 0 ? m15Body / m15Range : 0;
        
        // H4 trend (higher timeframe filter)
        const h4Direction = latestH4.close > prevH4.close ? 'UP' : 'DOWN';
        const h4Trend = latestH4.close > latestH4.open ? 'UP' : 'DOWN';
        
        // Check for high-probability setup
        let signal = null;
        
        // Setup 1: All timeframes aligned with strong momentum
        if (m5Momentum > this._config.MIN_MOMENTUM && 
            m5BodyRatio > this._config.MIN_BODY_RATIO &&
            m5Direction === m15Direction && 
            m15Direction === h4Direction &&
            m15Strength > 0.55) {
            
            const direction = m5Direction === 'UP' ? 'LONG' : 'SHORT';
            
            // Calculate SL and TP with 2:1 reward ratio
            const slDist = atr * 0.8;    // Risk
            const tpDist = atr * 1.6;    // Reward (2:1)
            
            signal = {
                type: direction,
                direction: direction,
                score: 85,
                factors: [
                    `⭐ ALL TF ${direction === 'LONG' ? '↑' : '↓'}`,
                    `Momentum ${m5Momentum.toFixed(1)}x`,
                    `H4 ${h4Direction === 'UP' ? 'bullish' : 'bearish'}`,
                    `RR 2:1`
                ],
                tpMultiplier: 1.6,
                slMultiplier: 0.8,
                _slDist: slDist,
                _tpDist: tpDist,
                isJump75: true
            };
        }
        
        // Setup 2: H4 break with M5 pullback (only if H4 trend is strong)
        else if (this._config.REQUIRE_H4_ALIGNMENT) {
            const h4Range = latestH4.high - latestH4.low;
            const h4BodyRatio = Math.abs(latestH4.close - latestH4.open) / h4Range;
            
            // Strong H4 candle
            if (h4BodyRatio > 0.6 && h4Trend === m5Direction) {
                const direction = h4Trend === 'UP' ? 'LONG' : 'SHORT';
                
                // Wait for pullback to EMA
                const ema21 = this._calculateEMA(m5Candles, 21);
                if (ema21) {
                    const distanceToEMA = Math.abs(latestM5.close - ema21);
                    const isNearEMA = distanceToEMA < atr * 0.3;
                    
                    if (isNearEMA && m5Momentum > 0.8) {
                        const slDist = atr * 0.7;
                        const tpDist = atr * 1.5;
                        
                        signal = {
                            type: direction,
                            direction: direction,
                            score: 75,
                            factors: [
                                `📊 H4 ${direction === 'LONG' ? 'breakout ↑' : 'breakdown ↓'}`,
                                `Pullback to EMA21`,
                                `RR 2.1:1`
                            ],
                            tpMultiplier: 1.5,
                            slMultiplier: 0.7,
                            _slDist: slDist,
                            _tpDist: tpDist,
                            isJump75: true
                        };
                    }
                }
            }
        }
        
        // Only take trade if we have a signal and RR is good
        if (signal) {
            const risk = signal._slDist;
            const reward = signal._tpDist;
            const rr = reward / risk;
            
            if (rr < this._config.MIN_RR_RATIO) {
                console.log(`[Jump75] Skipping - poor RR: ${rr.toFixed(2)}:1`);
                return null;
            }
            
            this._diagnostics.entriesFired++;
            this._lastTradeTime = Date.now();
            console.log(`[Jump75] ✅ SIGNAL: ${signal.type} | Score: ${signal.score} | RR: ${rr.toFixed(2)}:1`);
            
            return signal;
        }
        
        return null;
    },
    
    // Record trade outcome for loss streak tracking
    recordOutcome(outcome) {
        if (outcome === 'SL') {
            this._consecutiveLosses++;
        } else if (outcome === 'TP') {
            this._consecutiveLosses = 0;
        }
    },
    
    _calculateEMA(candles, period) {
        if (!candles || candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },
    
    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        
        const price = currentCandle.close;
        const entry = trade.entry;
        const sl = trade.sl;
        const tp = trade.tp;
        const type = trade.type;
        
        if (type === 'LONG' || type === 'BUY') {
            if (currentCandle.high >= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.low <= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        } else {
            if (currentCandle.low <= tp) {
                return { action: 'CLOSE', reason: 'TP' };
            }
            if (currentCandle.high >= sl) {
                return { action: 'CLOSE', reason: 'SL' };
            }
        }
        return null;
    },
    
    reset() {
        this._consecutiveLosses = 0;
        this._lastTradeTime = 0;
    }
};

export default Jump75Strategy;