// kismet.js — KISMET Strategy
// "Structure-first" trading for Deriv synthetic indices.
//
// PHILOSOPHY:
//   Standard TA (EMA crossovers, RSI, MACD) is LAGGING on synthetics.
//   Synthetics have no order flow or institutional memory — indicators
//   fire after the move is already done.
//
//   KISMET trades STRUCTURAL EVENTS only:
//     1. POST-SPIKE FADE  (Boom/Crash 1000/500)
//        After a spike, price must mean-revert. This is how the index
//        works mechanically — not a statistical guess.
//        Enter the FIRST M1 bar after spike closes. Tight SL, wide TP.
//
//     2. RUN-LENGTH FADE  (Step Index / any symbol)
//        After 5+ consecutive closes in same direction, fade the reversal.
//        Zero spread on Step Index means no friction cost.
//
//     3. DRIFT RE-ENTRY  (Boom/Crash between spikes)
//        After any pullback against the structural bias, re-enter.
//        Bias is absolute: Boom = always SELL between spikes,
//        Crash = always BUY between spikes.
//        Only enter if the pullback has already started reversing.
//
//   NO ENTRY when:
//     - In spike cooldown (too close to a spike — next spike risk)
//     - Consolidating (ATR < 40% of 20-period ATR average)
//     - Already in a trade
//     - Daily loss limit hit
//
// R:R DESIGN:
//   SL = 0.5× ATR  (very tight — if structure is right, price moves fast)
//   TP = 2.0× ATR  (let the structural move play out)
//   Spike-fade TP = 3.0× ATR  (biggest moves happen post-spike)
//   → Breakeven WR = 33%. Target WR = 65%+
//   → Expectancy at 65% WR = 0.65×2 - 0.35×1 = +0.95R per trade
//
// PATCH v1.1:
//   FIX — ATR/SL noise guard: skip entries where the designed SL distance
//          is below a viable minimum (guaranteed wick stop-out on M5).
//   FIX — MAX ATR guard: skip entries during extreme volatility spikes
//          where post-spike ATR is unreliable for SL sizing.

// ─────────────────────────────────────────────────────────────
// SYMBOL CONFIG
// ─────────────────────────────────────────────────────────────
const KISMET_SYMBOLS = {
    'BOOM1000':   { bias: 'SELL', type: 'crash_boom', name: 'Boom 1000',   spikeDir: 'up'   },
    'BOOM_1000':  { bias: 'SELL', type: 'crash_boom', name: 'Boom 1000',   spikeDir: 'up'   },
    'BOOM500':    { bias: 'SELL', type: 'crash_boom', name: 'Boom 500',    spikeDir: 'up'   },
    'BOOM_500':   { bias: 'SELL', type: 'crash_boom', name: 'Boom 500',    spikeDir: 'up'   },
    'CRASH1000':  { bias: 'BUY',  type: 'crash_boom', name: 'Crash 1000',  spikeDir: 'down' },
    'CRASH_1000': { bias: 'BUY',  type: 'crash_boom', name: 'Crash 1000',  spikeDir: 'down' },
    'CRASH500':   { bias: 'BUY',  type: 'crash_boom', name: 'Crash 500',   spikeDir: 'down' },
    'CRASH_500':  { bias: 'BUY',  type: 'crash_boom', name: 'Crash 500',   spikeDir: 'down' },
    'stpRNG':     { bias: 'BOTH', type: 'step',       name: 'Step Index',  spikeDir: null   },
    'STEP':       { bias: 'BOTH', type: 'step',       name: 'Step Index',  spikeDir: null   },
};

export function kismetSymbolConfig(symbol) {
    return KISMET_SYMBOLS[symbol] || null;
}

// ─────────────────────────────────────────────────────────────
// INDICATORS  (minimal — only what's needed for structure)
// ─────────────────────────────────────────────────────────────
function _atr(candles, period = 10) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = candles.length - period - 1; i < candles.length; i++) {
        if (i === 0) continue;
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Average ATR over last N periods (to detect consolidation)
function _atrAvg(candles, period = 10, lookback = 20) {
    if (candles.length < period + lookback + 1) return null;
    const atrs = [];
    for (let i = lookback; i >= 1; i--) {
        const slice = candles.slice(0, candles.length - i);
        const a = _atr(slice, period);
        if (a) atrs.push(a);
    }
    return atrs.length ? atrs.reduce((a, b) => a + b, 0) / atrs.length : null;
}

// Detect spike: wick >= threshold × ATR
function _detectSpike(candles, atr, threshold = 3.5) {
    if (!candles || candles.length < 2 || !atr) return null;
    const c = candles[candles.length - 2]; // last CLOSED candle
    if (!c) return null;

    const wickUp   = c.high - Math.max(c.open, c.close);
    const wickDown = Math.min(c.open, c.close) - c.low;
    const body     = Math.abs(c.close - c.open);

    const isUp   = wickUp   >= atr * threshold && wickUp   > body * 1.5;
    const isDown = wickDown >= atr * threshold && wickDown > body * 1.5;

    if (!isUp && !isDown) return null;
    return {
        direction: isUp ? 'up' : 'down',
        magnitude: (isUp ? wickUp : wickDown) / atr,
        price:     c.close,
        time:      c.time,
    };
}

// Count consecutive closes in same direction
function _runLength(candles) {
    const cl = candles.slice(0, -1); // exclude open candle
    if (cl.length < 2) return { dir: null, length: 0 };

    const lastDir = cl[cl.length - 1].close > cl[cl.length - 2].close ? 'up' : 'down';
    let count = 1;
    for (let i = cl.length - 2; i >= 1; i--) {
        const dir = cl[i].close > cl[i - 1].close ? 'up' : 'down';
        if (dir !== lastDir) break;
        count++;
    }
    return { dir: lastDir, length: count };
}

// Detect pullback reversal: bias direction after counter-move
// Returns true if price pulled back against bias and is now resuming
function _pullbackReversal(candles, bias) {
    const cl = candles.slice(0, -1);
    if (cl.length < 4) return false;

    const c0 = cl[cl.length - 1];
    const c1 = cl[cl.length - 2];
    const c2 = cl[cl.length - 3];
    const c3 = cl[cl.length - 4];

    if (bias === 'SELL') {
        // Price went UP (pullback against SELL bias), now turning back down
        const pulledBack = c2.close > c3.close || c1.close > c2.close;
        const reverting  = c0.close < c1.close; // now heading back down
        return pulledBack && reverting;
    } else {
        // Price went DOWN (pullback against BUY bias), now turning back up
        const pulledBack = c2.close < c3.close || c1.close < c2.close;
        const reverting  = c0.close > c1.close;
        return pulledBack && reverting;
    }
}

// ─────────────────────────────────────────────────────────────
// ENTRY MODES
// ─────────────────────────────────────────────────────────────

// MODE 1: Post-spike fade
// Highest probability trade. Enter first bar after spike in bias direction.
function _spikeFadeSignal(cfg, recentSpike, candles, atr) {
    if (!recentSpike) return null;

    // Spike must align with symbol's spike direction
    if (recentSpike.direction !== cfg.spikeDir) return null;

    // Must be within 3 bars of the spike
    const cl    = candles.slice(0, -1);
    const c0    = cl[cl.length - 1];
    const barsSinceSpike = cl.filter(c => c.time > recentSpike.time).length;
    if (barsSinceSpike > 3 || barsSinceSpike < 1) return null;

    // Price must have started moving in bias direction already (don't catch a falling knife)
    const isConfirmed = cfg.bias === 'SELL'
        ? c0.close < candles[candles.length - 2]?.close  // moving down after up-spike
        : c0.close > candles[candles.length - 2]?.close; // moving up after down-spike

    const factors = [
        `Post-spike fade (${recentSpike.magnitude.toFixed(1)}× ATR)`,
        `Bar ${barsSinceSpike} after spike`,
    ];
    if (isConfirmed) factors.push('Direction confirmed');

    return {
        type:         cfg.bias,
        mode:         'spike_fade',
        score:        isConfirmed ? 90 : 75,
        factors,
        tpMultiplier: 3.0,  // biggest TP — structural move can go far
        slMultiplier: 0.5,  // tightest SL — if wrong, out fast
    };
}

// MODE 2: Run-length fade (Step Index primary, also Crash/Boom)
function _runFadeSignal(cfg, candles, atr) {
    const run = _runLength(candles);
    if (!run.dir) return null;

    // Step Index: fade after 5+ run
    // Crash/Boom: fade after 6+ run (they trend harder)
    const threshold = cfg.type === 'step' ? 5 : 6;
    if (run.length < threshold) return null;

    // For Crash/Boom, run fade must align with structural bias
    if (cfg.type === 'crash_boom') {
        const fadeDir = run.dir === 'up' ? 'SELL' : 'BUY';
        if (fadeDir !== cfg.bias) return null; // never fight the structural bias
    }

    const entryDir = run.dir === 'up' ? 'SELL' : 'BUY';

    return {
        type:         entryDir,
        mode:         'run_fade',
        score:        55 + Math.min(run.length - threshold, 5) * 5, // more bars = higher score
        factors:      [`${run.length}-bar run ${run.dir === 'up' ? '↑' : '↓'}`, 'Run fade'],
        tpMultiplier: cfg.type === 'step' ? 1.5 : 2.0,
        slMultiplier: cfg.type === 'step' ? 0.5 : 0.5,
    };
}

// MODE 3: Drift re-entry (Crash/Boom between spikes)
// After a counter-move pullback, re-enter in bias direction
function _driftReentrySignal(cfg, candles, atr, spikeState) {
    if (cfg.type !== 'crash_boom') return null;
    if (!_pullbackReversal(candles, cfg.bias)) return null;

    // Don't re-enter if we just had a spike in our favour
    // (that means we're near the top/bottom of the range, not mid-drift)
    if (spikeState?.spike && spikeState.spike.direction === cfg.spikeDir) {
        const barsSinceSpike = candles.slice(0, -1).filter(c => c.time > spikeState.spike.time).length;
        if (barsSinceSpike < 8) return null; // too soon after spike — wait for structure
    }

    // Volatility check: skip if market is too quiet (consolidating)
    const currentAtr = atr;
    const avgAtr     = _atrAvg(candles);
    if (avgAtr && currentAtr < avgAtr * 0.4) return null; // consolidation — no drift

    return {
        type:         cfg.bias,
        mode:         'drift_reentry',
        score:        62,
        factors:      [`Drift re-entry ${cfg.bias === 'SELL' ? '↓' : '↑'}`, 'Pullback reversal'],
        tpMultiplier: 2.0,
        slMultiplier: 0.5,
    };
}

// ─────────────────────────────────────────────────────────────
// KISMET STRATEGY  (exported)
// ─────────────────────────────────────────────────────────────
export const KismetStrategy = {

    _spikeState: {},   // { [botId]: { spike, cooldownUntil } }
    _tradeCount: {},   // { [botId]: { wins, losses, todayKey } }

    // ── SPIKE TRACKING ───────────────────────────────────────
    getSpikeState(botId) {
        if (!this._spikeState[botId]) this._spikeState[botId] = { spike: null, cooldownUntil: 0 };
        return this._spikeState[botId];
    },

    recordSpike(botId, spike, tfSecs) {
        // Cooldown = 4 candles after a spike. During this window:
        //   - spike_fade entries are ALLOWED (that's the trade)
        //   - drift_reentry entries are BLOCKED (too dangerous)
        this._spikeState[botId] = {
            spike,
            cooldownUntil: Date.now() + tfSecs * 4 * 1000,
        };
    },

    inDriftCooldown(botId) {
        // True = too close to a spike for drift re-entry
        return Date.now() < (this._spikeState[botId]?.cooldownUntil || 0);
    },

    detectSpike(candles, atr) {
        return _detectSpike(candles, atr);
    },

    // ── DAILY STATS ──────────────────────────────────────────
    _getStats(botId) {
        const today = new Date(Date.now() - 5 * 3600000).toDateString();
        if (!this._tradeCount[botId] || this._tradeCount[botId].todayKey !== today) {
            this._tradeCount[botId] = { wins: 0, losses: 0, todayKey: today, consLosses: 0 };
        }
        return this._tradeCount[botId];
    },

    recordOutcome(botId, outcome) {
        const s = this._getStats(botId);
        if (outcome === 'TP') { s.wins++; s.consLosses = 0; }
        else                  { s.losses++; s.consLosses++; }
    },

    // Stop after 6 consecutive losses in a day (chaos protection)
    isHalted(botId) {
        return this._getStats(botId).consLosses >= 6;
    },

    // ── MAIN ENTRY CHECK ─────────────────────────────────────
    checkEntry(symbol, candles, atr, botId) {
        const cfg = kismetSymbolConfig(symbol);
        if (!cfg) return null;
        if (!candles || candles.length < 15 || !atr) return null;
        if (this.isHalted(botId)) return null;

        // ── FIX: ATR/SL noise guard ───────────────────────────────────────────
        // KISMET SL = 0.5× ATR. On Crash 1000 M5, ATR is typically 1.5–4 pts.
        // If the resulting SL distance is below the viable minimum, a wick will
        // stop the trade out on the very next candle regardless of direction.
        // MIN_SL_POINTS: start at 1.5 pts. Raise to 2.0 if wick stops persist.
        const MIN_SL_POINTS = 1.0;
        if (atr * 0.5 < MIN_SL_POINTS) return null;

        // ── FIX: MAX ATR guard ────────────────────────────────────────────────
        // During and immediately after spike candles, ATR spikes far above normal.
        // Entries at extreme ATR are unreliable — the SL is calculated from a
        // distorted ATR value and the spike environment is too noisy.
        // MAX_ATR_FOR_ENTRY: start at 50 pts. Tune after checking daily ATR logs.
        const MAX_ATR_FOR_ENTRY = 50;
        if (atr > MAX_ATR_FOR_ENTRY) return null;

        const spikeState = this.getSpikeState(botId);

        // ── Try each mode in priority order ──────────────────

        // 1. Spike fade — highest priority, highest edge
        const spikeSig = _spikeFadeSignal(cfg, spikeState.spike, candles, atr);
        if (spikeSig) {
            return this._build(spikeSig, cfg, atr);
        }

        // 2. Run fade — structural mean reversion
        const runSig = _runFadeSignal(cfg, candles, atr);
        if (runSig) {
            return this._build(runSig, cfg, atr);
        }

        // 3. Drift re-entry — only when not in spike cooldown
        if (!this.inDriftCooldown(botId)) {
            const driftSig = _driftReentrySignal(cfg, candles, atr, spikeState);
            if (driftSig) {
                return this._build(driftSig, cfg, atr);
            }
        }

        return null;
    },

    // ── BUILD FINAL SIGNAL OBJECT ────────────────────────────
    _build(raw, cfg, atr) {
        return {
            type:         raw.type,
            label:        `KISMET ${raw.type} [${raw.mode} ${raw.score}]`,
            score:        raw.score,
            factors:      raw.factors,
            mode:         raw.mode,
            tpMultiplier: raw.tpMultiplier,
            slMultiplier: raw.slMultiplier,
            isKismet:     true,
            atr,
            symbolConfig: cfg,
        };
    },

    // ── EMERGENCY SPIKE EXIT ─────────────────────────────────
    // Call this on every bar. Returns true if open trade should be closed now.
    checkAdverseSpike(openSignal, spike) {
        if (!openSignal?.isKismet || !spike) return false;
        return (openSignal.type === 'BUY'  && spike.direction === 'down')
            || (openSignal.type === 'SELL' && spike.direction === 'up');
    },

    // Expose for backtest
    checkEntryRaw(symbol, candles, atr) {
        return this.checkEntry(symbol, candles, atr, 'backtest');
    },
};