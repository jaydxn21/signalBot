// adaptive-volatility.js — Self-selecting multi-indicator strategy for Volatility Indices
// Picks the best indicator combo per market condition, 40+ setups/day on M1

export const AdaptiveVolatility = {

    // ── INDICATOR LIBRARY ─────────────────────────────────────
    _ema(candles, period) {
        if (candles.length < period) return null;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++)
            ema = candles[i].close * k + ema * (1 - k);
        return ema;
    },

    _rsi(candles, period = 14) {
        if (candles.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const diff = candles[i].close - candles[i-1].close;
            if (diff > 0) gains += diff; else losses -= diff;
        }
        const rs = losses === 0 ? 100 : (gains/period) / (losses/period);
        return 100 - (100 / (1 + rs));
    },

    _bb(candles, period = 20, mult = 2) {
        if (candles.length < period) return null;
        const slice = candles.slice(-period);
        const mean = slice.reduce((a, b) => a + b.close, 0) / period;
        const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b.close - mean, 2), 0) / period);
        return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
    },

    _macd(candles) {
        if (candles.length < 35) return null;
        const ema12 = this._ema(candles, 12);
        const ema26 = this._ema(candles, 26);
        if (!ema12 || !ema26) return null;
        const macdLine = ema12 - ema26;
        // Signal: 9-period EMA of MACD (simplified)
        const macdValues = [];
        for (let i = candles.length - 9; i < candles.length; i++) {
            const e12 = this._ema(candles.slice(0, i+1), 12);
            const e26 = this._ema(candles.slice(0, i+1), 26);
            if (e12 && e26) macdValues.push({ close: e12 - e26, time: i });
        }
        const signal = macdValues.length >= 9 
            ? this._ema(macdValues, 9) : null;
        return { macd: macdLine, signal, hist: signal ? macdLine - signal : null };
    },

    _stoch(candles, k = 14, d = 3) {
        if (candles.length < k) return null;
        const slice = candles.slice(-k);
        const high = Math.max(...slice.map(c => c.high));
        const low  = Math.min(...slice.map(c => c.low));
        const close = candles[candles.length - 1].close;
        const kVal = low === high ? 50 : ((close - low) / (high - low)) * 100;
        // Simple D: average of last 3 K values
        const kVals = [];
        for (let i = candles.length - d; i < candles.length; i++) {
            const sl = candles.slice(i - k + 1, i + 1);
            const h = Math.max(...sl.map(c => c.high));
            const l = Math.min(...sl.map(c => c.low));
            kVals.push(l === h ? 50 : ((candles[i].close - l) / (h - l)) * 100);
        }
        const dVal = kVals.reduce((a, b) => a + b, 0) / kVals.length;
        return { k: kVal, d: dVal };
    },

    _vwap(candles) {
        if (candles.length < 2) return null;
        let cumTP = 0, cumVol = 0;
        for (const c of candles) {
            const tp = (c.high + c.low + c.close) / 3;
            const vol = c.high - c.low; // proxy volume for synthetics
            cumTP  += tp * vol;
            cumVol += vol;
        }
        return cumVol === 0 ? null : cumTP / cumVol;
    },

    _atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i], p = candles[i-1];
            sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        }
        return sum / period;
    },

    _momentum(candles, period = 10) {
        if (candles.length < period + 1) return null;
        return candles[candles.length-1].close - candles[candles.length-1-period].close;
    },

    // ── MARKET REGIME DETECTOR ────────────────────────────────
    // Decides: TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE
    _detectRegime(candles, atr) {
        if (candles.length < 50) return 'UNKNOWN';
        
        const ema20 = this._ema(candles, 20);
        const ema50 = this._ema(candles, 50);
        const close = candles[candles.length-1].close;
        
        // Measure trend strength via consecutive closes above/below EMA
        const last10 = candles.slice(-10);
        const aboveEma = last10.filter(c => c.close > ema20).length;
        const belowEma = last10.filter(c => c.close < ema20).length;
        
        // Range detection: price oscillating within 1.5x ATR of EMA
        const rangeWidth = Math.abs(close - ema20);
        const isRanging = rangeWidth < atr * 1.5 && aboveEma >= 3 && belowEma >= 3;
        
        // Volatility spike: current candle body > 2x ATR
        const lastCandle = candles[candles.length-1];
        const body = Math.abs(lastCandle.close - lastCandle.open);
        const isVolSpike = body > atr * 2;
        
        if (isVolSpike) return 'VOLATILE';
        if (isRanging)  return 'RANGING';
        if (aboveEma >= 7 && ema20 > ema50) return 'TRENDING_UP';
        if (belowEma >= 7 && ema20 < ema50) return 'TRENDING_DOWN';
        return 'RANGING'; // default safe
    },

    // ── INDICATOR SELECTOR ────────────────────────────────────
    // Returns which indicator combos to use based on regime
    _selectIndicators(regime) {
        const map = {
            'TRENDING_UP':   ['ema_cross', 'macd', 'momentum'],
            'TRENDING_DOWN': ['ema_cross', 'macd', 'momentum'],
            'RANGING':       ['bb_bounce', 'rsi_fade', 'stoch'],
            'VOLATILE':      ['bb_squeeze', 'rsi_extreme', 'vwap'],
            'UNKNOWN':       ['ema_cross', 'rsi_fade'],
        };
        return map[regime] || map['UNKNOWN'];
    },

    // ── SETUP DETECTORS (one per indicator combo) ─────────────

    _checkEmaCross(candles) {
        const ema8  = this._ema(candles, 8);
        const ema21 = this._ema(candles, 21);
        const ema50 = this._ema(candles, 50);
        if (!ema8 || !ema21 || !ema50) return null;

        const prev = candles[candles.length-2];
        const prevEma8  = this._ema(candles.slice(0,-1), 8);
        const prevEma21 = this._ema(candles.slice(0,-1), 21);

        const crossUp   = prevEma8 <= prevEma21 && ema8 > ema21;
        const crossDown = prevEma8 >= prevEma21 && ema8 < ema21;

        const close = candles[candles.length-1].close;
        if (crossUp   && close > ema50) return { type:'BUY',  score: 72, label:'EMA Cross ↑' };
        if (crossDown && close < ema50) return { type:'SELL', score: 72, label:'EMA Cross ↓' };
        return null;
    },

    _checkMacd(candles) {
        const m = this._macd(candles);
        if (!m || m.hist === null) return null;

        const prev = candles.slice(0,-1);
        const pm = this._macd(prev);
        if (!pm || pm.hist === null) return null;

        const crossUp   = pm.hist < 0 && m.hist > 0;
        const crossDown = pm.hist > 0 && m.hist < 0;
        const rsi = this._rsi(candles);

        if (crossUp   && rsi && rsi < 65) return { type:'BUY',  score: 70, label:'MACD Cross ↑' };
        if (crossDown && rsi && rsi > 35) return { type:'SELL', score: 70, label:'MACD Cross ↓' };
        return null;
    },

    _checkMomentum(candles, atr) {
        const mom = this._momentum(candles, 10);
        const rsi = this._rsi(candles);
        const ema20 = this._ema(candles, 20);
        if (!mom || !rsi || !ema20 || !atr) return null;

        const close = candles[candles.length-1].close;
        const strongUp   = mom > atr * 1.2 && rsi > 55 && rsi < 75 && close > ema20;
        const strongDown = mom < -atr * 1.2 && rsi < 45 && rsi > 25 && close < ema20;

        if (strongUp)   return { type:'BUY',  score: 68, label:'Momentum ↑' };
        if (strongDown) return { type:'SELL', score: 68, label:'Momentum ↓' };
        return null;
    },

    _checkBbBounce(candles, atr) {
        const bb = this._bb(candles, 20, 2);
        const rsi = this._rsi(candles);
        if (!bb || !rsi) return null;

        const close = candles[candles.length-1].close;
        const prev  = candles[candles.length-2].close;

        const bounceLow  = prev < bb.lower && close > bb.lower && rsi < 40;
        const bounceHigh = prev > bb.upper && close < bb.upper && rsi > 60;

        if (bounceLow)  return { type:'BUY',  score: 75, label:'BB Bounce ↑', isMeanReversion: true };
        if (bounceHigh) return { type:'SELL', score: 75, label:'BB Bounce ↓', isMeanReversion: true };
        return null;
    },

    _checkRsiFade(candles) {
        const rsi = this._rsi(candles);
        const bb  = this._bb(candles, 20, 1.5);
        if (!rsi || !bb) return null;

        const close = candles[candles.length-1].close;
        const oversold  = rsi < 28 && close < bb.lower;
        const overbought = rsi > 72 && close > bb.upper;

        if (oversold)   return { type:'BUY',  score: 78, label:'RSI Oversold',  isMeanReversion: true };
        if (overbought) return { type:'SELL', score: 78, label:'RSI Overbought', isMeanReversion: true };
        return null;
    },

    _checkStoch(candles) {
        const stoch = this._stoch(candles);
        const rsi   = this._rsi(candles);
        if (!stoch || !rsi) return null;

        const bullCross = stoch.k > stoch.d && stoch.k < 30 && rsi < 45;
        const bearCross = stoch.k < stoch.d && stoch.k > 70 && rsi > 55;

        if (bullCross) return { type:'BUY',  score: 73, label:'Stoch Cross ↑' };
        if (bearCross) return { type:'SELL', score: 73, label:'Stoch Cross ↓' };
        return null;
    },

    _checkBbSqueeze(candles, atr) {
        const bb = this._bb(candles, 20, 2);
        const rsi = this._rsi(candles);
        if (!bb || !rsi || !atr) return null;

        const bandwidth = (bb.upper - bb.lower) / bb.mid;
        const isSqueeze = bandwidth < 0.015; // tight BB = coiling energy
        if (!isSqueeze) return null;

        const close = candles[candles.length-1].close;
        const breakUp   = close > bb.upper && rsi > 55;
        const breakDown = close < bb.lower && rsi < 45;

        if (breakUp)   return { type:'BUY',  score: 80, label:'BB Squeeze Break ↑' };
        if (breakDown) return { type:'SELL', score: 80, label:'BB Squeeze Break ↓' };
        return null;
    },

    _checkRsiExtreme(candles) {
        const rsi = this._rsi(candles);
        if (!rsi) return null;

        // During volatile regime, fade the extremes hard
        if (rsi < 20) return { type:'BUY',  score: 82, label:'RSI Extreme Low',  isMeanReversion: true };
        if (rsi > 80) return { type:'SELL', score: 82, label:'RSI Extreme High', isMeanReversion: true };
        return null;
    },

    _checkVwap(candles, atr) {
        const vwap = this._vwap(candles);
        const rsi  = this._rsi(candles);
        if (!vwap || !rsi || !atr) return null;

        const close = candles[candles.length-1].close;
        const dist  = Math.abs(close - vwap);

        // Only trade when price is far from VWAP (mean reversion)
        if (dist < atr * 0.5) return null;

        const buySetup  = close < vwap - atr * 0.5 && rsi < 45;
        const sellSetup = close > vwap + atr * 0.5 && rsi > 55;

        if (buySetup)  return { type:'BUY',  score: 71, label:'VWAP Reversion ↑', isMeanReversion: true };
        if (sellSetup) return { type:'SELL', score: 71, label:'VWAP Reversion ↓', isMeanReversion: true };
        return null;
    },

    // ── CONFLUENCE SCORER ─────────────────────────────────────
    // Runs ALL detectors, picks highest scoring signal with agreement
    _scoreSignals(candles, atr, regime) {
        const all = [
            this._checkEmaCross(candles),
            this._checkMacd(candles),
            this._checkMomentum(candles, atr),
            this._checkBbBounce(candles, atr),
            this._checkRsiFade(candles),
            this._checkStoch(candles),
            this._checkBbSqueeze(candles, atr),
            this._checkRsiExtreme(candles),
            this._checkVwap(candles, atr),
        ].filter(Boolean);

        if (!all.length) return null;

        const buys  = all.filter(s => s.type === 'BUY');
        const sells = all.filter(s => s.type === 'SELL');

        // Need at least 2 indicators agreeing
        const dominant = buys.length >= sells.length ? buys : sells;
        if (dominant.length < 2) return null;

        // Weight by regime preference
        const preferred = this._selectIndicators(regime);
        let bonus = 0;
        dominant.forEach(s => {
            if (preferred.some(p => s.label.toLowerCase().includes(p.split('_')[0]))) bonus += 5;
        });

        const avgScore = dominant.reduce((a, b) => a + b.score, 0) / dominant.length;
        const finalScore = Math.min(99, Math.round(avgScore + bonus));
        const labels = dominant.map(s => s.label).join(' + ');

        return {
            type:   dominant[0].type,
            score:  finalScore,
            label:  labels,
            regime,
            indicators: dominant.map(s => s.label),
            count:  dominant.length,
            isMeanReversion: dominant.some(s => s.isMeanReversion),
        };
    },

    // ── LOSS STREAK PROTECTION ────────────────────────────────
    _state: {},

    _getState(botId) {
        if (!this._state[botId]) {
            this._state[botId] = {
                consecutiveLosses: 0,
                pausedUntil: 0,
                totalTrades: 0,
                wins: 0,
            };
        }
        return this._state[botId];
    },

    recordOutcome(botId, outcome) {
        const s = this._getState(botId);
        s.totalTrades++;
        if (outcome === 'TP') {
            s.wins++;
            s.consecutiveLosses = 0;
        } else {
            s.consecutiveLosses++;
            // After 3 losses: 2 candle pause
            // After 5 losses: 10 candle pause  
            if (s.consecutiveLosses >= 5) {
                s.pausedUntil = Date.now() + 10 * 60 * 1000; // 10 min
                console.log(`[AdaptiveVol] 5 consecutive losses — pausing 10min`);
            } else if (s.consecutiveLosses >= 3) {
                s.pausedUntil = Date.now() + 2 * 60 * 1000;  // 2 min
                console.log(`[AdaptiveVol] 3 consecutive losses — pausing 2min`);
            }
        }
    },

    isHalted(botId) {
        const s = this._getState(botId);
        return Date.now() < s.pausedUntil;
    },

    // ── DYNAMIC SL/TP based on regime + indicator type ────────
    _getSLTP(signal, regime, atr) {
        let slMult, tpMult;

        if (signal.isMeanReversion) {
            // Tighter SL, TP to midline
            slMult = 0.8;
            tpMult = 1.6;
        } else if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
            // Wider TP to ride the trend
            slMult = 1.0;
            tpMult = 2.5;
        } else if (regime === 'VOLATILE') {
            // Tight everything — volatile moves fast
            slMult = 0.7;
            tpMult = 1.4;
        } else {
            // Ranging default
            slMult = 0.9;
            tpMult = 1.8;
        }

        return { slMultiplier: slMult, tpMultiplier: tpMult };
    },

    // ── MAIN ENTRY ────────────────────────────────────────────
    checkEntry(candles, atr, botId = 'default') {
        if (candles.length < 55) return null;
        if (!atr) return null;

        // Halt check
        if (this.isHalted(botId)) return null;

        const closed = candles.slice(0, -1);

        // Detect regime
        const regime = this._detectRegime(closed, atr);

        // Score all signals
        const signal = this._scoreSignals(closed, atr, regime);
        if (!signal) return null;

        // Minimum score gate — adaptive per regime
        const minScore = regime === 'VOLATILE' ? 75 : 65;
        if (signal.score < minScore) return null;

        // Get SL/TP multipliers
        const { slMultiplier, tpMultiplier } = this._getSLTP(signal, regime, atr);

        return {
            type:           signal.type,
            score:          signal.score,
            label:          `AV [${regime.slice(0,3)}] ${signal.label}`,
            factors:        signal.indicators,
            regime,
            slMultiplier,
            tpMultiplier,
            isAdaptiveVol:  true,
            indicatorCount: signal.count,
        };
    },
};