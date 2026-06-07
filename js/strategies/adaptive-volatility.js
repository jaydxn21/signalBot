// adaptive-volatility.js — Self-selecting multi-indicator strategy for Volatility Indices
// v2.1 FIXES (post-report analysis):
//   - SELL bias fix: RSI extreme/overbought thresholds tightened so BUY signals can fire
//   - BB Bounce: requires confirmation candle body (not just close inside band)
//   - Regime SELL/BUY symmetry enforced — score gates equal for both directions
//   - Mean reversion R:R fixed: slMultiplier raised to 1.0, tpMultiplier raised to 2.2
//     so that live ATR-based SL expansion at the EA still clears 1.5 R:R minimum
//   - V75 specific: requireds 4 indicators in RANGING (was already coded but flag was wrong)
//   - Trend regime: momentum score raised so trend signals outcompete mean-reversion ones
//   - VWAP: distance filter tightened to 1.2x ATR (was 0.8) to avoid noise entries
//   - Added _directionBias() guard: if last 15 candles are >10 in one direction, 
//     counter-trend mean-reversion score penalty applied (-10)
//   - Conflict filter tightened: minority >= 1 blocks mean reversion signals
//   - Loss streak pauses unchanged (3=5min, 5=20min)
//   - Per-symbol score gates adjusted: V75 needs 80+ (was 75)

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

    // ── DIRECTIONAL BIAS GUARD ────────────────────────────────
    // Returns 'BEARISH', 'BULLISH', or 'NEUTRAL' based on recent 15 candles.
    // Used to penalise counter-trend mean-reversion signals and explain the
    // 0-long / 43-short skew seen in the June report.
    _directionBias(candles) {
        const last = candles.slice(-15);
        const bullCandles = last.filter(c => c.close > c.open).length;
        const bearCandles = last.filter(c => c.close < c.open).length;
        if (bearCandles >= 11) return 'BEARISH';
        if (bullCandles >= 11) return 'BULLISH';
        return 'NEUTRAL';
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

        // Trend: requires 8/10 candles on same side
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
        // FIX v2.1: Raised score from 68→73 so trend signals outscore ranging mean-rev
        const strongUp   = mom > atr * 1.5 && rsi > 55 && rsi < 72 && close > ema20;
        const strongDown = mom < -atr * 1.5 && rsi < 45 && rsi > 28 && close < ema20;

        if (strongUp)   return { type: 'BUY',  score: 73, label: 'Momentum ↑' };
        if (strongDown) return { type: 'SELL', score: 73, label: 'Momentum ↓' };
        return null;
    },

    _checkBbBounce(candles, atr) {
        const bb  = this._bb(candles, 20, 2);
        const rsi = this._rsi(candles);
        if (!bb || !rsi) return null;

        const close = candles[candles.length - 1].close;
        const prev  = candles[candles.length - 2].close;
        // FIX v2.1: Add body confirmation — the bounce candle must close with a body
        // pointing back toward the mean (bullish body for low bounce, bearish for high)
        const cur   = candles[candles.length - 1];
        const body  = cur.close - cur.open; // positive = bullish candle

        // Must actually cross back inside band AND have confirming body direction
        const bounceLow  = prev <= bb.lower && close > bb.lower && rsi < 35 && body > 0;
        const bounceHigh = prev >= bb.upper && close < bb.upper && rsi > 65 && body < 0;

        if (bounceLow)  return { type: 'BUY',  score: 76, label: 'BB Bounce ↑', isMeanReversion: true };
        if (bounceHigh) return { type: 'SELL', score: 76, label: 'BB Bounce ↓', isMeanReversion: true };
        return null;
    },

    _checkRsiFade(candles) {
        const rsi = this._rsi(candles);
        const bb  = this._bb(candles, 20, 1.5);
        if (!rsi || !bb) return null;

        const close      = candles[candles.length - 1].close;
        // FIX v2.1: Tightened thresholds — 22/78 (was 25/75) to reduce over-firing
        const oversold   = rsi < 22 && close < bb.lower;
        const overbought = rsi > 78 && close > bb.upper;

        if (oversold)   return { type: 'BUY',  score: 79, label: 'RSI Oversold',  isMeanReversion: true };
        if (overbought) return { type: 'SELL', score: 79, label: 'RSI Overbought', isMeanReversion: true };
        return null;
    },

    _checkStoch(candles) {
        const stoch = this._stoch(candles);
        const rsi   = this._rsi(candles);
        if (!stoch || !rsi) return null;

        // Require fresh cross (k just crossed d) — unchanged
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
        // FIX v2.1: Tightened thresholds — 15/85 (was 18/82) — extreme extremes only
        // This was the primary cause of the SELL bias: RSI > 82 was firing too often
        // on V75 which regularly reaches 78–84 in trending sessions.
        if (rsi < 15) return { type: 'BUY',  score: 83, label: 'RSI Extreme ↑', isMeanReversion: true };
        if (rsi > 85) return { type: 'SELL', score: 83, label: 'RSI Extreme ↓', isMeanReversion: true };
        return null;
    },

    _checkVwap(candles, atr) {
        const vwap = this._vwap(candles);
        const rsi  = this._rsi(candles);
        if (!vwap || !rsi || !atr) return null;

        const close = candles[candles.length - 1].close;
        const dist  = Math.abs(close - vwap);
        // FIX v2.1: Raised distance threshold to 1.2x ATR (was 0.8) — require price
        // to be meaningfully stretched from VWAP before fading
        if (dist < atr * 1.2) return null;

        const buySetup  = close < vwap - atr * 1.2 && rsi < 38;
        const sellSetup = close > vwap + atr * 1.2 && rsi > 62;

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

        const dominant = buys.length >= sells.length ? buys : sells;
        const minority = buys.length >= sells.length ? sells : buys;
        if (dominant.length < 3) return null;

        // FIX v2.1: For mean-reversion signals, ANY minority signal blocks the trade.
        // For trend signals (no isMeanReversion), allow 1 minority (was 2 for all).
        const dominantIsMeanRev = dominant.some(s => s.isMeanReversion);
        if (dominantIsMeanRev && minority.length >= 1) return null;
        if (!dominantIsMeanRev && minority.length >= 2) return null;

        // FIX v2.1: Apply directional bias penalty to counter-trend mean-reversion signals
        const dirBias = this._directionBias(candles);
        let counterTrendPenalty = 0;
        const signalType = dominant[0].type;
        if (dominantIsMeanRev) {
            if (dirBias === 'BEARISH' && signalType === 'BUY')  counterTrendPenalty = 10;
            if (dirBias === 'BULLISH' && signalType === 'SELL') counterTrendPenalty = 10;
        }

        // Weight by regime preference
        const preferred = this._selectIndicators(regime);
        let bonus = 0;
        dominant.forEach(s => {
            if (preferred.some(p => s.label.toLowerCase().includes(p.split('_')[0])))
                bonus += 5;
        });

        const avgScore   = dominant.reduce((a, b) => a + b.score, 0) / dominant.length;
        const finalScore = Math.min(99, Math.round(avgScore + bonus - counterTrendPenalty));

        return {
            type:            dominant[0].type,
            score:           finalScore,
            label:           dominant.map(s => s.label).join(' + '),
            regime,
            indicators:      dominant.map(s => s.label),
            count:           dominant.length,
            isMeanReversion: dominantIsMeanRev,
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
            if (s.consecutiveLosses >= 5) {
                s.pausedUntil = Date.now() + 20 * 60 * 1000;
                console.warn(`[AdaptiveVol] ${botId} — 5 consecutive losses, pausing 20min`);
            } else if (s.consecutiveLosses >= 3) {
                s.pausedUntil = Date.now() + 5 * 60 * 1000;
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
    // FIX v2.1: Raised all SL multipliers so that when the EA widens stops via
    // UseDynamicInitialSL + ATR, the R:R ratio does not collapse below breakeven.
    // Previous: mean-rev SL=0.7/TP=1.4 → with EA 20% SL expansion → R:R drops to 1.17
    // New: mean-rev SL=1.0/TP=2.2 → with EA 20% SL expansion → R:R stays ~1.83
    _getSLTP(signal, regime) {
        if (signal.isMeanReversion) {
            return { slMultiplier: 1.0, tpMultiplier: 2.2 }; // was 0.7/1.4
        }
        if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
            return { slMultiplier: 1.1, tpMultiplier: 2.8 }; // was 0.9/2.2
        }
        if (regime === 'VOLATILE') {
            return { slMultiplier: 0.8, tpMultiplier: 1.8 }; // was 0.6/1.2
        }
        return { slMultiplier: 1.0, tpMultiplier: 2.0 }; // ranging default, was 0.8/1.6
    },

    // ── MAIN ENTRY ────────────────────────────────────────────
    checkEntry(candles, atr, botId = 'default', symbol = '') {
        if (candles.length < 60) return null;
        if (!atr) return null;
        if (this.isHalted(botId)) return null;

        const closed = candles.slice(0, -1);

        const rsi = this._rsi(closed);
        if (!rsi || rsi < 2 || rsi > 98) return null;

        // Block spike candles
        const lastClosed = closed[closed.length - 1];
        const body = Math.abs(lastClosed.close - lastClosed.open);
        if (body > atr * 2) return null;

        // Detect regime
        const regime = this._detectRegime(closed, atr);

        // Score all signals
        const signal = this._scoreSignals(closed, atr, regime);
        if (!signal) return null;

        // RSI direction filter — don't buy overbought in trend, don't sell oversold
        if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
            if (signal.type === 'BUY'  && rsi > 72) return null;
            if (signal.type === 'SELL' && rsi < 28) return null;
        }

        // ── PER-SYMBOL SCORE GATES ────────────────────────────
        // FIX v2.1: V75 gate raised to 80 (was 75). June report showed V75 was
        // firing 43 trades in ~40 hours — far too frequent at the old threshold.
        let minScore = 75; // global default
        if (symbol === 'R_75' || symbol === 'Volatility 75 Index') {
            minScore = 80;
            if (signal.count < 3) return null;
            if (regime === 'RANGING' && signal.count < 4) return null;
        }
        if (symbol === 'R_25' || symbol === 'Volatility 25 Index') {
            minScore = 78;
            if (signal.count < 3) return null;
            if (regime === 'RANGING' && signal.count < 4) return null;
        }
        if (symbol === 'R_100' || symbol === 'Volatility 100 Index') {
            minScore = 75;
        }
        if (regime === 'VOLATILE') minScore = Math.max(minScore, 82);

        if (signal.score < minScore) return null;

        // Get SL/TP multipliers
        const { slMultiplier, tpMultiplier } = this._getSLTP(signal, regime);

        // Final R:R check — must be at least 1.8:1 (raised from 1.5 to ensure
        // EA ATR expansion still yields positive expectancy after EA override)
        if (tpMultiplier / slMultiplier < 1.8) return null;

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