// pulse.js — PULSE Compounder Strategy
//
// PURPOSE: Grow a small account ($10 → $50+) through high-frequency,
// low-stake, compounding trades. Designed for Boom 1000 and Step Index.
//
// DESIGN PRINCIPLES:
//   - Tight 1:1 R:R (TP = SL). Win rate is the only edge lever.
//   - Compound: after each win, increase stake by a fixed step.
//     After each loss, reset to base stake (no martingale).
//   - High frequency: fires on M1 bars, not M5.
//   - Simple signals: fewer conditions = fires more often.
//   - Hard daily loss limit as % of current balance (not fixed $).
//
// SUPPORTED SYMBOLS:
//   Boom 1000  — SELL bias, drift fade between spikes
//   Boom 500   — SELL bias, faster cycle
//   Step Index — mean-reversion on tick direction runs

// ─────────────────────────────────────────────────────────────
// SYMBOL CONFIG
// ─────────────────────────────────────────────────────────────
const PULSE_SYMBOLS = {
    'BOOM1000':    { bias: 'SELL', type: 'crash_boom', name: 'Boom 1000'  },
    'BOOM_1000':   { bias: 'SELL', type: 'crash_boom', name: 'Boom 1000'  },
    'BOOM500':     { bias: 'SELL', type: 'crash_boom', name: 'Boom 500'   },
    'BOOM_500':    { bias: 'SELL', type: 'crash_boom', name: 'Boom 500'   },
    'CRASH1000':   { bias: 'BUY',  type: 'crash_boom', name: 'Crash 1000' },
    'CRASH_1000':  { bias: 'BUY',  type: 'crash_boom', name: 'Crash 1000' },
    'stpRNG':      { bias: 'BOTH', type: 'step',       name: 'Step Index' },
    'STEP':        { bias: 'BOTH', type: 'step',       name: 'Step Index' },
};

export function pulseSymbolConfig(symbol) {
    return PULSE_SYMBOLS[symbol] || null;
}

// ─────────────────────────────────────────────────────────────
// INDICATORS  (minimal — pulse is intentionally simple)
// ─────────────────────────────────────────────────────────────
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let v = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) v = candles[i].close * k + v * (1 - k);
    return v;
}

function _rsi(candles, period = 10) {
    if (candles.length < period + 2) return null;
    const cl = candles.slice(-period - 1).map(c => c.close);
    let g = 0, l = 0;
    for (let i = 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function _atr(candles, period = 8) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _engulf(prev, curr) {
    if (!prev || !curr) return { bull: false, bear: false };
    const pBull = prev.close > prev.open;
    const cBull = curr.close > curr.open;
    return {
        bull: !pBull && cBull && curr.close > prev.open && curr.open < prev.close,
        bear:  pBull && !cBull && curr.close < prev.open && curr.open > prev.close,
    };
}

// ─────────────────────────────────────────────────────────────
// STEP INDEX SIGNAL
// Detects runs of consecutive same-direction closes and fades them.
// Step Index moves ±0.1 per tick with no spread — pure mean reversion.
// ─────────────────────────────────────────────────────────────
function _stepSignal(candles) {
    if (candles.length < 8) return null;
    const cl = candles.slice(0, -1);

    // Count consecutive direction of last N closes
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    const c2 = cl[cl.length - 3];
    const c3 = cl[cl.length - 4];
    const c4 = cl[cl.length - 5];
    if (!c0 || !c1 || !c2 || !c3 || !c4) return null;

    // Detect 4+ consecutive down closes → BUY reversion
    const run4Down = c0.close < c1.close && c1.close < c2.close &&
                     c2.close < c3.close && c3.close < c4.close;

    // Detect 4+ consecutive up closes → SELL reversion
    const run4Up   = c0.close > c1.close && c1.close > c2.close &&
                     c2.close > c3.close && c3.close > c4.close;

    // Extra confirmation: RSI extreme
    const rsi = _rsi(cl, 8);
    const rsiOversold  = rsi !== null && rsi < 35;
    const rsiOverbought= rsi !== null && rsi > 65;

    if (run4Down) {
        const factors = ['Step run↓ 4+'];
        if (rsiOversold) factors.push(`RSI ${rsi?.toFixed(0)} oversold`);
        return {
            type: 'BUY', factors,
            score: 60 + (rsiOversold ? 15 : 0),
            tpMultiplier: 1.0, slMultiplier: 1.0,
        };
    }

    if (run4Up) {
        const factors = ['Step run↑ 4+'];
        if (rsiOverbought) factors.push(`RSI ${rsi?.toFixed(0)} overbought`);
        return {
            type: 'SELL', factors,
            score: 60 + (rsiOverbought ? 15 : 0),
            tpMultiplier: 1.0, slMultiplier: 1.0,
        };
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// CRASH/BOOM PULSE SIGNAL
// Faster, simpler than NOVA. Uses M1 only. Fires more often.
// Requires EMA alignment + RSI + 1 confirmation.
// ─────────────────────────────────────────────────────────────
function _crashBoomSignal(candles, bias, recentSpike) {
    if (candles.length < 20) return null;

    const cl = candles.slice(0, -1);
    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    const c2 = cl[cl.length - 3];
    if (!c0 || !c1 || !c2) return null;

    const ema8  = _ema(cl, 8);
    const ema21 = _ema(cl, 21);
    const rsi   = _rsi(cl, 10);
    const atr   = _atr(cl, 8);

    if (!ema8 || !ema21 || !rsi || !atr) return null;

    const { bull: engBull, bear: engBear } = _engulf(c1, c0);
    const factors = [];
    let score = 50;

    if (bias === 'SELL') {
        // Need: EMA bearish + RSI not overbought + 1 confirmation
        const emaOk  = ema8 < ema21 || c0.close < ema8;
        const rsiOk  = rsi < 60 && rsi > 30;
        if (!emaOk || !rsiOk) return null;

        factors.push('drift↓');
        if (ema8 < ema21)   { factors.push('EMA↓'); score += 10; }
        if (engBear)        { factors.push('engulf↓'); score += 15; }
        if (c0.close < c1.close && c1.close < c2.close) { factors.push('3-bar↓'); score += 10; }
        if (recentSpike?.direction === 'up') { factors.push('post-spike↓'); score += 20; }
        if (rsi < 45)       { factors.push(`RSI ${rsi.toFixed(0)}`); score += 5; }

        // Need at least 2 factors beyond the base drift
        if (factors.length < 2) return null;

        const tpMult = recentSpike?.direction === 'up' ? 1.5 : 1.0;
        return { type: 'SELL', factors, score, tpMultiplier: tpMult, slMultiplier: 1.0 };

    } else { // BUY
        const emaOk  = ema8 > ema21 || c0.close > ema8;
        const rsiOk  = rsi > 40 && rsi < 70;
        if (!emaOk || !rsiOk) return null;

        factors.push('drift↑');
        if (ema8 > ema21)   { factors.push('EMA↑'); score += 10; }
        if (engBull)        { factors.push('engulf↑'); score += 15; }
        if (c0.close > c1.close && c1.close > c2.close) { factors.push('3-bar↑'); score += 10; }
        if (recentSpike?.direction === 'down') { factors.push('post-spike↑'); score += 20; }
        if (rsi > 55)       { factors.push(`RSI ${rsi.toFixed(0)}`); score += 5; }

        if (factors.length < 2) return null;

        const tpMult = recentSpike?.direction === 'down' ? 1.5 : 1.0;
        return { type: 'BUY', factors, score, tpMultiplier: tpMult, slMultiplier: 1.0 };
    }
}

// ─────────────────────────────────────────────────────────────
// COMPOUNDING SESSION
// Tracks balance, stake, and compound progression.
// Resets stake to base after each loss (anti-martingale).
// ─────────────────────────────────────────────────────────────
const _sessionKey = 'pulse_session';

function _freshSession(baseStake = 0.35, target = 50) {
    return {
        date:          new Date(Date.now() - 5 * 3600000).toDateString(),
        baseStake,
        currentStake:  baseStake,
        target,
        startBalance:  0,
        currentBalance:0,
        trades:        0,
        wins:          0,
        losses:        0,
        realizedPnL:   0,
        winStreak:     0,
        lossStreak:    0,
        maxWinStreak:  0,
        compoundLevel: 0, // how many consecutive wins we've had
        mode:          'active',
    };
}

function _loadSession() {
    try {
        const raw = localStorage.getItem(_sessionKey);
        if (!raw) return _freshSession();
        const s = JSON.parse(raw);
        const todayEST = new Date(Date.now() - 5 * 3600000).toDateString();
        if (s.date !== todayEST) return _freshSession(s.baseStake, s.target);
        return s;
    } catch { return _freshSession(); }
}

function _saveSession(s) {
    try { localStorage.setItem(_sessionKey, JSON.stringify(s)); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// PULSE STRATEGY  (exported)
// ─────────────────────────────────────────────────────────────
export const PulseStrategy = {

    // Per-bot spike memory
    _spikeState: {},

    getSpikeState(botId) {
        if (!this._spikeState[botId]) this._spikeState[botId] = { spike: null, cooldownUntil: 0 };
        return this._spikeState[botId];
    },

    recordSpike(botId, spike, tfSecs) {
        this._spikeState[botId] = {
            spike,
            cooldownUntil: Date.now() + tfSecs * 2 * 1000, // 2-candle cooldown (shorter than NOVA)
        };
    },

    inCooldown(botId) {
        return Date.now() < (this._spikeState[botId]?.cooldownUntil || 0);
    },

    // ── SESSION MANAGEMENT ───────────────────────────────────
    getSession:   _loadSession,
    saveSession:  _saveSession,

    configureSession(baseStake, target, startBalance) {
        const s = _freshSession(
            parseFloat(baseStake)     || 0.35,
            parseFloat(target)        || 50,
        );
        s.startBalance   = parseFloat(startBalance) || 0;
        s.currentBalance = s.startBalance;
        _saveSession(s);
        return s;
    },

    resetSession(baseStake, target) {
        const s = _freshSession(parseFloat(baseStake) || 0.35, parseFloat(target) || 50);
        _saveSession(s);
        return s;
    },

    // ── COMPOUND STAKE CALCULATOR ────────────────────────────
    // After each win, compound up by 10% of base stake (not doubling — safe).
    // After each loss, reset to base.
    // Cap at 5× base stake max.
    _nextStake(session, outcome) {
        const base    = session.baseStake;
        const maxStake= base * 5;

        if (outcome === 'WIN') {
            const next = base + (session.compoundLevel + 1) * (base * 0.5);
            return Math.min(parseFloat(next.toFixed(2)), maxStake);
        }
        return base; // always reset on loss
    },

    recordTrade(botId, outcome, pnlAmt) {
        const s = _loadSession();
        s.trades++;
        s.realizedPnL += outcome === 'TP' ? pnlAmt : -pnlAmt;
        s.currentBalance = s.startBalance + s.realizedPnL;

        if (outcome === 'TP') {
            s.wins++;
            s.winStreak++;
            s.lossStreak    = 0;
            s.maxWinStreak  = Math.max(s.maxWinStreak, s.winStreak);
            s.compoundLevel++;
            s.currentStake  = this._nextStake(s, 'WIN');
        } else {
            s.losses++;
            s.lossStreak++;
            s.winStreak     = 0;
            s.compoundLevel = 0;
            s.currentStake  = s.baseStake; // reset
        }

        // Check target hit
        if (s.target > 0 && s.currentBalance >= s.target) {
            s.mode = 'target_hit';
        }

        // Daily loss limit: stop if down 30% of start balance
        const lossLimit = (s.startBalance || 10) * 0.30;
        if (Math.abs(Math.min(0, s.realizedPnL)) >= lossLimit) {
            s.mode = 'halted';
        }

        _saveSession(s);
        return s;
    },

    getCurrentStake(botId) {
        return _loadSession().currentStake || 0.35;
    },

    getMode() {
        return _loadSession().mode;
    },

    // ── ENTRY CHECK ─────────────────────────────────────────
    checkEntry(symbol, candles, recentSpike) {
        const session = _loadSession();
        if (session.mode !== 'active') return null;

        const cfg = pulseSymbolConfig(symbol);
        if (!cfg) return null;

        let signal = null;

        if (cfg.type === 'step') {
            signal = _stepSignal(candles);
        } else {
            signal = _crashBoomSignal(candles, cfg.bias, recentSpike);
        }

        if (!signal) return null;

        return {
            ...signal,
            label:     `PULSE ${signal.type} [${cfg.name} ${signal.score}]`,
            isPulse:   true,
            symbolConfig: cfg,
            stake:     session.currentStake,
            compoundLevel: session.compoundLevel,
        };
    },
};