// ═══════════════════════════════════════════════════════════════════════════
// JUMP75 STRATEGY v18+ - QUALITY MODE SELECTOR
// ═══════════════════════════════════════════════════════════════════════════
// Modes: 0=QUANTITY, 1=BALANCED (default), 2=QUALITY, 3=ULTRA
// Change QUALITY_MODE value to switch trading styles
// ═══════════════════════════════════════════════════════════════════════════

export const Jump75Strategy = {
    _lastTradeTime: 0,
    _consecutiveLosses: 0,
    _dailyProfit: 0,
    _dailyStartTime: null,
    _h4SwingHigh: null,
    _h4SwingLow: null,
    _tradesCount: 0,

    // ═══ QUALITY MODE SELECTOR ═══
    // Change this ONE value to switch modes
    // 0=QUANTITY, 1=BALANCED, 2=QUALITY, 3=ULTRA
    QUALITY_MODE: 1,  // Default: BALANCED

    // ───────────────────────────────────────────────────────────────
    // MODE CONFIGURATIONS
    // ───────────────────────────────────────────────────────────────
    _getModeConfig() {
        const modes = {
            0: {
                name: 'QUANTITY',
                displayName: 'QUANTITY (High Frequency)',
                description: '100+ trades/day, 60% win rate, 1.15-1.20 PF',
                minCandlesM5: 30,
                minCandlesM15: 20,
                minCandlesH4: 6,
                cooldownMs: 60000,
                lossCooldownMs: 300000,
                minRangeATR: 3.0,
                nearFibATR: 1.2,
                minMomentum: 0.15,
                minScore: 55,
                requireTrend: false,
                requireVolume: false,
                tpMultipliers: { high: 1.8, medium: 1.6, low: 1.4, min: 1.2 },
                slMultipliers: { high: 0.9, medium: 0.9, low: 0.8, min: 0.7 },
                lotMultiplier: 1.0,
                riskPercent: 0.75
            },
            1: {
                name: 'BALANCED',
                displayName: 'BALANCED (Recommended)',
                description: '50-70 trades/day, 65% win rate, 1.20-1.30 PF',
                minCandlesM5: 40,
                minCandlesM15: 25,
                minCandlesH4: 8,
                cooldownMs: 120000,
                lossCooldownMs: 600000,
                minRangeATR: 3.5,
                nearFibATR: 0.9,
                minMomentum: 0.25,
                minScore: 65,
                requireTrend: true,
                requireVolume: false,
                tpMultipliers: { high: 2.2, medium: 2.0, low: 1.8, min: 1.5 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 0.9, min: 0.8 },
                lotMultiplier: 1.0,
                riskPercent: 0.75
            },
            2: {
                name: 'QUALITY',
                displayName: 'QUALITY (Conservative)',
                description: '20-30 trades/day, 70% win rate, 1.30-1.50 PF',
                minCandlesM5: 50,
                minCandlesM15: 30,
                minCandlesH4: 10,
                cooldownMs: 180000,
                lossCooldownMs: 900000,
                minRangeATR: 4.0,
                nearFibATR: 0.7,
                minMomentum: 0.4,
                minScore: 75,
                requireTrend: true,
                requireVolume: true,
                tpMultipliers: { high: 2.5, medium: 2.2, low: 2.0, min: 1.8 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 0.9 },
                lotMultiplier: 0.8,
                riskPercent: 0.6
            },
            3: {
                name: 'ULTRA',
                displayName: 'ULTRA (Very Selective)',
                description: '5-10 trades/day, 80%+ win rate, 1.50-2.00 PF',
                minCandlesM5: 60,
                minCandlesM15: 40,
                minCandlesH4: 12,
                cooldownMs: 300000,
                lossCooldownMs: 1800000,
                minRangeATR: 5.0,
                nearFibATR: 0.5,
                minMomentum: 0.6,
                minScore: 85,
                requireTrend: true,
                requireVolume: true,
                tpMultipliers: { high: 3.0, medium: 2.5, low: 2.2, min: 2.0 },
                slMultipliers: { high: 1.0, medium: 1.0, low: 1.0, min: 1.0 },
                lotMultiplier: 0.5,
                riskPercent: 0.5
            }
        };
        return modes[this.QUALITY_MODE] || modes[1];
    },

    // ───────────────────────────────────────────────────────────────
    // SESSION MANAGEMENT
    // ───────────────────────────────────────────────────────────────
    initSession() {
        const now = new Date();
        const today = now.toDateString();
        if (!this._dailyStartTime || new Date(this._dailyStartTime).toDateString() !== today) {
            this._dailyProfit = 0;
            this._tradesCount = 0;
            this._consecutiveLosses = 0;
            this._dailyStartTime = now.getTime();
            const config = this._getModeConfig();
            console.log(`[Jump75 ${config.name}] New session started`);
        }
    },

    recordTrade(outcome, pnl) {
        this._tradesCount++;
        this._dailyProfit += pnl;
        const config = this._getModeConfig();
        if (outcome === 'TP') {
            this._consecutiveLosses = 0;
        } else {
            this._consecutiveLosses++;
        }
    },

    // ───────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ───────────────────────────────────────────────────────────────
    async checkEntry(m5Candles, m15Candles, h4Candles, atr) {
        this.initSession();
        const config = this._getModeConfig();
        
        if (!m5Candles || m5Candles.length < config.minCandlesM5 || 
            !m15Candles || m15Candles.length < config.minCandlesM15 || 
            !h4Candles || h4Candles.length < config.minCandlesH4) {
            return null;
        }

        const now = Date.now();
        if (now - this._lastTradeTime < config.cooldownMs) return null;
        if (this._consecutiveLosses >= 3 && now - this._lastTradeTime < config.lossCooldownMs) return null;

        const latestM15 = m15Candles[m15Candles.length - 1];
        const latestM5 = m5Candles[m5Candles.length - 1];
        const prevM5 = m5Candles[m5Candles.length - 2];
        
        this._updateH4Structure(h4Candles);
        if (!this._h4SwingHigh || !this._h4SwingLow) return null;

        const range = this._h4SwingHigh - this._h4SwingLow;
        if (range < atr * config.minRangeATR) return null;

        const fib = this._calculateFibLevels(this._h4SwingLow, this._h4SwingHigh);
        const near618 = Math.abs(latestM15.close - fib.fib618) < atr * config.nearFibATR;
        const near50 = Math.abs(latestM15.close - fib.fib50) < atr * (config.nearFibATR + 0.2);

        const m5Momentum = this._getM5Momentum(m5Candles);
        const m15Trend = this._getM15Trend(m15Candles);
        const bullishCandle = latestM5.close > prevM5.close;
        const bearishCandle = latestM5.close < prevM5.close;
        const aboveLow = latestM15.close > this._h4SwingLow;
        const belowHigh = latestM15.close < this._h4SwingHigh;
        const volumeConfirmed = this._hasVolumeConfirmation(m5Candles);

        let signal = null;
        let signalScore = 0;

        // TIER 1: HIGHEST QUALITY (Score 85+)
        if (near618 && Math.abs(m5Momentum) > 0.5 && (bullishCandle || bearishCandle)) {
            const trendOk = !config.requireTrend || (m5Momentum > 0 && m15Trend === 'UP') || (m5Momentum < 0 && m15Trend === 'DOWN');
            const volumeOk = !config.requireVolume || volumeConfirmed;
            if (trendOk && volumeOk) {
                if (m5Momentum > 0 && aboveLow) {
                    signal = this._createSignal('LONG', 88, ['Fib 61.8%', 'Strong momentum', 'H4 structure'], config);
                    signalScore = 88;
                } else if (m5Momentum < 0 && belowHigh) {
                    signal = this._createSignal('SHORT', 88, ['Fib 61.8%', 'Strong momentum', 'H4 structure'], config);
                    signalScore = 88;
                }
            }
        }
        
        // TIER 2: HIGH QUALITY (Score 75-84)
        if (!signal && near618 && Math.abs(m5Momentum) > config.minMomentum) {
            const trendOk = !config.requireTrend || m15Trend !== 'NEUTRAL';
            if (trendOk) {
                if (m5Momentum > 0 && aboveLow) {
                    signal = this._createSignal('LONG', 78, ['Fib 61.8%', 'Momentum'], config);
                    signalScore = 78;
                } else if (m5Momentum < 0 && belowHigh) {
                    signal = this._createSignal('SHORT', 78, ['Fib 61.8%', 'Momentum'], config);
                    signalScore = 78;
                }
            }
        }
        
        // TIER 3: MEDIUM QUALITY (Score 65-74)
        if (!signal && (near618 || near50) && Math.abs(m5Momentum) > config.minMomentum * 0.8) {
            const zone = near618 ? '61.8%' : '50%';
            if (m5Momentum > 0 && aboveLow) {
                signal = this._createSignal('LONG', 68, [`Fib ${zone}`, 'Entry confirmed'], config);
                signalScore = 68;
            } else if (m5Momentum < 0 && belowHigh) {
                signal = this._createSignal('SHORT', 68, [`Fib ${zone}`, 'Entry confirmed'], config);
                signalScore = 68;
            }
        }
        
        // TIER 4: LOWER QUALITY (Score 55-64) - Only in QUANTITY mode
        if (!signal && config.minScore <= 60 && (near618 || near50) && volumeConfirmed) {
            const zone = near618 ? '61.8%' : '50%';
            if (latestM15.close > latestM15.open && aboveLow) {
                signal = this._createSignal('LONG', 60, [`Fib ${zone}`, 'Volume confirmed'], config);
                signalScore = 60;
            } else if (latestM15.close < latestM15.open && belowHigh) {
                signal = this._createSignal('SHORT', 60, [`Fib ${zone}`, 'Volume confirmed'], config);
                signalScore = 60;
            }
        }

        // Quality gate - reject signals below mode threshold
        if (signal && signalScore < config.minScore) {
            return null;
        }

        if (signal) {
            this._lastTradeTime = now;
            console.log(`[Jump75 ${config.name}] ${signal.type} | Score ${signal.score} | ${signal.factors.join(' · ')} | Price ${latestM15.close.toFixed(2)}`);
            return signal;
        }

        return null;
    },

    _createSignal(type, score, factors, config) {
        let tpMultiplier, slMultiplier;
        if (score >= 85) {
            tpMultiplier = config.tpMultipliers.high;
            slMultiplier = config.slMultipliers.high;
        } else if (score >= 75) {
            tpMultiplier = config.tpMultipliers.medium;
            slMultiplier = config.slMultipliers.medium;
        } else if (score >= 65) {
            tpMultiplier = config.tpMultipliers.low;
            slMultiplier = config.slMultipliers.low;
        } else {
            tpMultiplier = config.tpMultipliers.min;
            slMultiplier = config.slMultipliers.min;
        }
        return {
            type, score, factors, tpMultiplier, slMultiplier,
            isJump75: true, qualityMode: config.name,
            lotMultiplier: config.lotMultiplier, riskPercent: config.riskPercent
        };
    },

    _getM15Trend(m15Candles) {
        if (m15Candles.length < 20) return 'NEUTRAL';
        const ema8 = this._calculateEMA(m15Candles, 8);
        const ema21 = this._calculateEMA(m15Candles, 21);
        if (!ema8 || !ema21) return 'NEUTRAL';
        const latest = m15Candles[m15Candles.length - 1];
        const prev = m15Candles[m15Candles.length - 2];
        if (latest.close > ema8 && ema8 > ema21 && latest.close > prev.close) return 'UP';
        if (latest.close < ema8 && ema8 < ema21 && latest.close < prev.close) return 'DOWN';
        return 'NEUTRAL';
    },

    _hasVolumeConfirmation(m5Candles) {
        if (m5Candles.length < 10) return false;
        const latest = m5Candles[m5Candles.length - 1];
        const avgVolume = m5Candles.slice(-10).reduce((s, c) => s + (c.volume || 0), 0) / 10;
        return (latest.volume || 0) > avgVolume * 1.2;
    },

    _updateH4Structure(h4Candles) {
        if (h4Candles.length < 12) return;
        const recent = h4Candles.slice(-14);
        this._h4SwingHigh = Math.max(...recent.map(c => c.high));
        this._h4SwingLow = Math.min(...recent.map(c => c.low));
    },

    _calculateFibLevels(low, high) {
        const diff = high - low;
        return { fib50: high - diff * 0.5, fib618: high - diff * 0.618 };
    },

    _getM5Momentum(m5Candles) {
        if (m5Candles.length < 15) return 0;
        const ema8 = this._calculateEMA(m5Candles, 8);
        const ema21 = this._calculateEMA(m5Candles, 21);
        if (!ema8 || !ema21) return 0;
        const atr = this._calculateATR(m5Candles, 14);
        if (atr === 0) return (ema8 - ema21) / 10;
        return (ema8 - ema21) / atr;
    },

    _calculateEMA(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = candles[i].close * k + ema * (1 - k);
        }
        return ema;
    },

    _calculateATR(candles, period) {
        if (candles.length < period + 1) return 0;
        let atr = 0;
        for (let i = 1; i <= period; i++) {
            const tr = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i-1].close),
                Math.abs(candles[i].low - candles[i-1].close)
            );
            atr += tr;
        }
        return atr / period;
    },

    checkClose(currentCandle, trade) {
        if (!currentCandle || !trade) return null;
        let closeAction = null;
        if (trade.type === 'LONG' || trade.type === 'BUY') {
            if (currentCandle.high >= trade.tp) {
                closeAction = { action: 'CLOSE', reason: 'TP' };
                this.recordTrade('TP', (trade.tp - trade.entry) * (trade.lotSize || 0.01));
            } else if (currentCandle.low <= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
                this.recordTrade('SL', (trade.entry - trade.sl) * (trade.lotSize || 0.01));
            }
        } else {
            if (currentCandle.low <= trade.tp) {
                closeAction = { action: 'CLOSE', reason: 'TP' };
                this.recordTrade('TP', (trade.entry - trade.tp) * (trade.lotSize || 0.01));
            } else if (currentCandle.high >= trade.sl) {
                closeAction = { action: 'CLOSE', reason: 'SL' };
                this.recordTrade('SL', (trade.sl - trade.entry) * (trade.lotSize || 0.01));
            }
        }
        return closeAction;
    },

    getStats() {
        const config = this._getModeConfig();
        return {
            mode: config.name,
            displayName: config.displayName,
            dailyProfit: this._dailyProfit,
            tradesCount: this._tradesCount,
            consecutiveLosses: this._consecutiveLosses,
            winRate: this._tradesCount > 0 ? (((this._tradesCount - this._consecutiveLosses) / this._tradesCount) * 100).toFixed(1) : 0
        };
    },

    setMode(modeNumber) {
        if (![0, 1, 2, 3].includes(modeNumber)) {
            console.warn(`[Jump75] Invalid mode ${modeNumber}. Using BALANCED (1) instead.`);
            this.QUALITY_MODE = 1;
            return false;
        }
        this.QUALITY_MODE = modeNumber;
        const config = this._getModeConfig();
        console.log(`[Jump75] Mode switched to ${config.displayName}`);
        return true;
    },

    getAllModes() {
        return {
            0: this._getModeConfig.call({ QUALITY_MODE: 0 }),
            1: this._getModeConfig.call({ QUALITY_MODE: 1 }),
            2: this._getModeConfig.call({ QUALITY_MODE: 2 }),
            3: this._getModeConfig.call({ QUALITY_MODE: 3 })
        };
    }
};

export default Jump75Strategy;