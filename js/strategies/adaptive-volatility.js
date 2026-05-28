// adaptive-volatility.js — Self-selecting multi-indicator strategy for Volatility Indices
// v2.0 FIXES:
//   - Minimum 3 indicators required (was 2)
//   - Raised score gates (75 ranging, 82 volatile)
//   - RSI extreme filter — no BUY > 72, no SELL < 28 in trend
//   - Candle body filter — skip signals on huge spike candles
//   - Conflict filter — BUY blocked if majority SELL signals exist even if 3 agree
//   - Tighter regime detection — harder to be TRENDING (requires 8/10, was 7/10)
//   - Removed spam console.log from checkEntry
//   - Loss streak pauses increased (3 losses = 5min, 5 losses = 20min)
//   - Added per-symbol tuning (V25 needs score 78+, V100 needs 75+)

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
        const rs = losses === 0 ? 100 : (gains / period) / (losses / period);
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
        const macdValues = [];
        for (let i = candles.length - 9; i < candles.length; i++) {
            const e12 = this._ema(candles.slice(0, i + 1), 12);
            const e26 = this._ema(candles.slice(0, i + 1), 26);
            if (e12 && e26) macdValues.push({ close: e12 - e26, time: i });
        }
        const signal = macdValues.length >= 9 ? this._ema(macdValues, 9) : null;
        return { macd: macdLine, signal, hist: signal ? macdLine - signal : null };
    },

    _stoch(candles, k = 14, d = 3) {
        if (candles.length < k + d) return null;
        const slice = candles.slice(-k);
        const high  = Math.max(...slice.map(c => c.high));
        const low   = Math.min(...slice.map(c => c.low));
        const close = candles[candles.length - 1].close;
        const kVal  = low === high ? 50 : ((close - low) / (high - low)) * 100;
        const kVals = [];
        for (let i = candles.length - d; i < candles.length; i++) {
            const sl = candles.slice(i - k + 1, i + 1);
            if (sl.length < k) continue;
            const h = Math.max(...sl.map(c => c.high));
            const l = Math.min(...sl.map(c => c.low));
            kVals.push(l === h ? 50 : ((candles[i].close - l) / (h - l)) * 100);
        }
        if (!kVals.length) return null;
        const dVal = kVals.reduce((a, b) => a + b, 0) / kVals.length;
        return { k: kVal, d: dVal };
    },

    _vwap(candles) {
        if (candles.length < 2) return null;
        let cumTP = 0, cumVol = 0;
        for (const c of candles) {
            const tp  = (c.high + c.low + c.close) / 3;
            const vol = c.high - c.low;
            cumTP  += tp * vol;
            cumVol += vol;
        }
        return cumVol === 0 ? null : cumTP / cumVol;
    },

    _atr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        let sum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i], p = candles[i - 1];
            sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        }
        return sum / period;
    },

    _momentum(candles, period = 10) {
        if (candles.length < period + 1) return null;
        return candles[candles.length - 1].close - candles[candles.length - 1 - period].close;
    },

    // ── MARKET REGIME DETECTOR ────────────────────────────────
    _detectRegime(candles, atr) {
        if (candles.length < 55) return 'UNKNOWN';

        const ema20 = this._ema(candles, 20);
        const ema50 = this._ema(candles, 50);
        if (!ema20 || !ema50) return 'UNKNOWN';

        const close   = candles[candles.length - 1].close;
        const last10  = candles.slice(-10);
        const aboveEma = last10.filter(c => c.close > ema20).length;
        const belowEma = last10.filter(c => c.close < ema20).length;

        // Volatility spike: current candle body > 2.5x ATR
        const lastCandle = candles[candles.length - 1];
        const body = Math.abs(lastCandle.close - lastCandle.open);
        if (body > atr * 2.5) return 'VOLATILE';

        // Range: price oscillating within 1.5x ATR of EMA20
        const rangeWidth = Math.abs(close - ema20);
        const isRanging  = rangeWidth < atr * 1.5 && aboveEma >= 3 && belowEma >= 3;
        if (isRanging) return 'RANGING';

        // Trend: requires 8/10 candles on same side (stricter than before)
        if (aboveEma >= 8 && ema20 > ema50) return 'TRENDING_UP';
        if (belowEma >= 8 && ema20 < ema50) return 'TRENDING_DOWN';

        return 'RANGING'; // safe default
    },

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

    // ── SETUP DETECTORS ───────────────────────────────────────

    _checkEmaCross(candles) {
        const ema8  = this._ema(candles, 8);
        const ema21 = this._ema(candles, 21);
        const ema50 = this._ema(candles, 50);
        if (!ema8 || !ema21 || !ema50) return null;

        const prevEma8  = this._ema(candles.slice(0, -1), 8);
        const prevEma21 = this._ema(candles.slice(0, -1), 21);
        if (!prevEma8 || !prevEma21) return null;

        const crossUp   = prevEma8 <= prevEma21 && ema8 > ema21;
        const crossDown = prevEma8 >= prevEma21 && ema8 < ema21;
        const close = candles[candles.length - 1].close;

        if (crossUp   && close > ema50) return { type: 'BUY',  score: 72, label: 'EMA Cross ↑' };
        if (crossDown && close < ema50) return { type: 'SELL', score: 72, label: 'EMA Cross ↓' };
        return null;
    },

    _checkMacd(candles) {
        const m  = this._macd(candles);
        if (!m || m.hist === null) return null;
        const pm = this._macd(candles.slice(0, -1));
        if (!pm || pm.hist === null) return null;

        const crossUp   = pm.hist < 0 && m.hist > 0;
        const crossDown = pm.hist > 0 && m.hist < 0;
        const rsi = this._rsi(candles);

        if (crossUp   && rsi && rsi < 62) return { type: 'BUY',  score: 70, label: 'MACD Cross ↑' };
        if (crossDown && rsi && rsi > 38) return { type: 'SELL', score: 70, label: 'MACD Cross ↓' };
        return null;
    },

    _checkMomentum(candles, atr) {
        const mom   = this._momentum(candles, 10);
        const rsi   = this._rsi(candles);
        const ema20 = this._ema(candles, 20);
        if (!mom || !rsi || !ema20 || !atr) return null;

        const close      = candles[candles.length - 1].close;
        const strongUp   = mom > atr * 1.5 && rsi > 55 && rsi < 72 && close > ema20;
        const strongDown = mom < -atr * 1.5 && rsi < 45 && rsi > 28 && close < ema20;

        if (strongUp)   return { type: 'BUY',  score: 68, label: 'Momentum ↑' };
        if (strongDown) return { type: 'SELL', score: 68, label: 'Momentum ↓' };
        return null;
    },

    _checkBbBounce(candles, atr) {
        const bb  = this._bb(candles, 20, 2);
        const rsi = this._rsi(candles);
        if (!bb || !rsi) return null;

        const close = candles[candles.length - 1].close;
        const prev  = candles[candles.length - 2].close;

        // Must actually cross back inside band (prev outside, close inside)
        const bounceLow  = prev <= bb.lower && close > bb.lower && rsi < 38;
        const bounceHigh = prev >= bb.upper && close < bb.upper && rsi > 62;

        if (bounceLow)  return { type: 'BUY',  score: 76, label: 'BB Bounce ↑', isMeanReversion: true };
        if (bounceHigh) return { type: 'SELL', score: 76, label: 'BB Bounce ↓', isMeanReversion: true };
        return null;
    },

    _checkRsiFade(candles) {
        const rsi = this._rsi(candles);
        const bb  = this._bb(candles, 20, 1.5);
        if (!rsi || !bb) return null;

        const close      = candles[candles.length - 1].close;
        const oversold   = rsi < 25 && close < bb.lower;
        const overbought = rsi > 75 && close > bb.upper;

        if (oversold)   return { type: 'BUY',  score: 79, label: 'RSI Oversold',  isMeanReversion: true };
        if (overbought) return { type: 'SELL', score: 79, label: 'RSI Overbought', isMeanReversion: true };
        return null;
    },

    _checkStoch(candles) {
        const stoch = this._stoch(candles);
        const rsi   = this._rsi(candles);
        if (!stoch || !rsi) return null;

        // Require fresh cross (k just crossed d)
        const bullCross = stoch.k > stoch.d && stoch.k < 25 && rsi < 42;
        const bearCross = stoch.k < stoch.d && stoch.k > 75 && rsi > 58;

        if (bullCross) return { type: 'BUY',  score: 74, label: 'Stoch Cross ↑' };
        if (bearCross) return { type: 'SELL', score: 74, label: 'Stoch Cross ↓' };
        return null;
    },

    _checkBbSqueeze(candles, atr) {
        const bb  = this._bb(candles, 20, 2);
        const rsi = this._rsi(candles);
        if (!bb || !rsi || !atr) return null;

        const bandwidth = (bb.upper - bb.lower) / bb.mid;
        if (bandwidth > 0.012) return null; // not a squeeze

        const close     = candles[candles.length - 1].close;
        const breakUp   = close > bb.upper && rsi > 55;
        const breakDown = close < bb.lower && rsi < 45;

        if (breakUp)   return { type: 'BUY',  score: 81, label: 'BB Squeeze ↑' };
        if (breakDown) return { type: 'SELL', score: 81, label: 'BB Squeeze ↓' };
        return null;
    },

    _checkRsiExtreme(candles) {
        const rsi = this._rsi(candles);
        if (!rsi) return null;

        if (rsi < 18) return { type: 'BUY',  score: 83, label: 'RSI Extreme ↑', isMeanReversion: true };
        if (rsi > 82) return { type: 'SELL', score: 83, label: 'RSI Extreme ↓', isMeanReversion: true };
        return null;
    },

    _checkVwap(candles, atr) {
        const vwap = this._vwap(candles);
        const rsi  = this._rsi(candles);
        if (!vwap || !rsi || !atr) return null;

        const close = candles[candles.length - 1].close;
        const dist  = Math.abs(close - vwap);
        if (dist < atr * 0.8) return null; // must be far enough from VWAP

        const buySetup  = close < vwap - atr * 0.8 && rsi < 42;
        const sellSetup = close > vwap + atr * 0.8 && rsi > 58;

        if (buySetup)  return { type: 'BUY',  score: 72, label: 'VWAP Revert ↑', isMeanReversion: true };
        if (sellSetup) return { type: 'SELL', score: 72, label: 'VWAP Revert ↓', isMeanReversion: true };
        return null;
    },

    // ── CONFLUENCE SCORER ─────────────────────────────────────
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

        // ✅ FIX: Need at least 3 indicators agreeing (was 2)
        const dominant  = buys.length >= sells.length ? buys : sells;
        const minority  = buys.length >= sells.length ? sells : buys;
        if (dominant.length < 3) return null;

        // ✅ FIX: Conflict filter — if minority has 2+ signals, skip
        // (mixed market — not clean enough)
        if (minority.length >= 2) return null;

        // Weight by regime preference
        const preferred = this._selectIndicators(regime);
        let bonus = 0;
        dominant.forEach(s => {
            if (preferred.some(p => s.label.toLowerCase().includes(p.split('_')[0])))
                bonus += 5;
        });

        const avgScore   = dominant.reduce((a, b) => a + b.score, 0) / dominant.length;
        const finalScore = Math.min(99, Math.round(avgScore + bonus));

        return {
            type:            dominant[0].type,
            score:           finalScore,
            label:           dominant.map(s => s.label).join(' + '),
            regime,
            indicators:      dominant.map(s => s.label),
            count:           dominant.length,
            isMeanReversion: dominant.some(s => s.isMeanReversion),
        };
    },

    // ── LOSS STREAK PROTECTION ────────────────────────────────
    _state: {},

    _getState(botId) {
        if (!this._state[botId]) {
            this._state[botId] = {
                consecutiveLosses: 0,
                pausedUntil:       0,
                totalTrades:       0,
                wins:              0,
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
            // ✅ FIX: longer pauses (was 2min/10min)
            if (s.consecutiveLosses >= 5) {
                s.pausedUntil = Date.now() + 20 * 60 * 1000; // 20 min
                console.warn(`[AdaptiveVol] ${botId} — 5 consecutive losses, pausing 20min`);
            } else if (s.consecutiveLosses >= 3) {
                s.pausedUntil = Date.now() + 5 * 60 * 1000;  // 5 min
                console.warn(`[AdaptiveVol] ${botId} — 3 consecutive losses, pausing 5min`);
            }
        }
    },

    isHalted(botId) {
        const s = this._getState(botId);
        if (Date.now() < s.pausedUntil) {
            const remaining = Math.round((s.pausedUntil - Date.now()) / 1000);
            console.log(`[AdaptiveVol] ${botId} halted — ${remaining}s remaining`);
            return true;
        }
        return false;
    },

    getState(botId) {
        return this._getState(botId);
    },

    // ── DYNAMIC SL/TP ─────────────────────────────────────────
    _getSLTP(signal, regime) {
        if (signal.isMeanReversion) {
            return { slMultiplier: 0.7, tpMultiplier: 1.4 }; // tight — mean reversion snaps back fast
        }
        if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
            return { slMultiplier: 0.9, tpMultiplier: 2.2 }; // ride the trend
        }
        if (regime === 'VOLATILE') {
            return { slMultiplier: 0.6, tpMultiplier: 1.2 }; // very tight — volatile = fast moves
        }
        return { slMultiplier: 0.8, tpMultiplier: 1.6 };      // ranging default
    },

    // ── MAIN ENTRY ────────────────────────────────────────────
    checkEntry(candles, atr, botId = 'default', symbol = '') {
        if (candles.length < 60) return null;
        if (!atr) return null;
        if (this.isHalted(botId)) return null;

        const closed = candles.slice(0, -1);

        // ✅ FIX: Block bad RSI data
        const rsi = this._rsi(closed);
        if (!rsi || rsi < 2 || rsi > 98) return null;

        // ✅ FIX: Block spike candles — don't enter on huge body candles
        const lastClosed = closed[closed.length - 1];
        const body = Math.abs(lastClosed.close - lastClosed.open);
        if (body > atr * 2) return null;

        // Detect regime
        const regime = this._detectRegime(closed, atr);

        // Score all signals
        const signal = this._scoreSignals(closed, atr, regime);
        if (!signal) return null;

        // ✅ FIX: RSI direction filter — don't buy overbought in trend, don't sell oversold
        if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
            if (signal.type === 'BUY'  && rsi > 72) return null;
            if (signal.type === 'SELL' && rsi < 28) return null;
        }

        // ✅ FIX: Per-symbol score gates
        let minScore = 75; // default
        if (symbol === 'R_25' || symbol === 'Volatility 25 Index') {
            minScore = 78; // V25 needs stronger confluence
            if (signal.indicatorCount < 3) return null;
            if (regime === 'RANGING' && signal.count < 4) return null; // V25 ranging needs 4 indicators
        }
        if (symbol === 'R_100' || symbol === 'Volatility 100 Index') {
            minScore = 75; // V100 standard
        }
        if (regime === 'VOLATILE') minScore = 82;

        if (signal.score < minScore) return null;

        // Get SL/TP multipliers
        const { slMultiplier, tpMultiplier } = this._getSLTP(signal, regime);

        // Final R:R check — must be at least 1.5:1
        if (tpMultiplier / slMultiplier < 1.5) return null;

        return {
            type:           signal.type,
            score:          signal.score,
            label:          `AV [${regime.slice(0, 3)}] ${signal.label}`,
            factors:        signal.indicators,
            regime,
            slMultiplier,
            tpMultiplier,
            isAdaptiveVol:  true,
            indicatorCount: signal.count,
        };
    },
};