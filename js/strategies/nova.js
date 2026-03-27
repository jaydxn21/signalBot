// nova.js — NOVA v2  Crash & Boom Strategy
//
// KEY IMPROVEMENTS over v1:
//   1. R:R fix — TP is always wider than SL in dollar terms.
//      SL = 0.8× ATR (tighter), TP = 1.5× ATR (wider). Avg loss < avg win.
//   2. Spike-fade entries get asymmetric TP: 2.5× ATR (was 2.0×)
//   3. Crash 1000 signal quality fix — added volatility gate to block
//      entries during spike cooldown noise (was causing PF 0.80 on Crash)
//   4. Trend filter — only trade if price is on correct side of EMA50
//   5. RSI direction fixed — BUY needs RSI recovering (>40, <65),
//      SELL needs RSI overextended or falling (<60, >35)
//   6. Added Boom 500 / Crash 500 support
//
// PATCH v2.1:
//   FIX A — Multi-TF gate: require 2+ TF agreement before firing.
//            Single-TF signals were causing 3× over-firing vs backtest.
//   FIX B — ATR/SL noise guard: skip if M5 ATR makes the designed SL
//            sub-candle noise (guaranteed wick stop-out).

const NOVA_SYMBOLS = {
    'CRASH1000':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', atrMult: 1.0 },
    'BOOM1000':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  atrMult: 1.0 },
    'CRASH_1000': { bias: 'BUY',  spikeDir: 'down', name: 'Crash 1000', atrMult: 1.0 },
    'BOOM_1000':  { bias: 'SELL', spikeDir: 'up',   name: 'Boom 1000',  atrMult: 1.0 },
    'CRASH500':   { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  atrMult: 0.8 },
    'BOOM500':    { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   atrMult: 0.8 },
    'CRASH_500':  { bias: 'BUY',  spikeDir: 'down', name: 'Crash 500',  atrMult: 0.8 },
    'BOOM_500':   { bias: 'SELL', spikeDir: 'up',   name: 'Boom 500',   atrMult: 0.8 },
};

export function novaSymbolConfig(symbol) {
    return NOVA_SYMBOLS[symbol] || null;
}

// ─────────────────────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────────────────────
function _ema(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let v = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) v = candles[i].close * k + v * (1 - k);
    return v;
}

function _rsi(candles, period = 14) {
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

function _atr(candles, period = 10) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _bb(candles, period = 20) {
    if (candles.length < period) return null;
    const sl   = candles.slice(-period);
    const mean = sl.reduce((a, c) => a + c.close, 0) / period;
    const std  = Math.sqrt(sl.reduce((a, c) => a + (c.close - mean) ** 2, 0) / period);
    return { upper: mean + 2 * std, lower: mean - 2 * std, mid: mean, std };
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
// SPIKE DETECTOR
// ─────────────────────────────────────────────────────────────
export function detectSpike(candles, atr) {
    if (!candles || candles.length < 2 || !atr) return null;
    const c = candles[candles.length - 2];
    if (!c) return null;

    const wickUp   = c.high - Math.max(c.open, c.close);
    const wickDown = Math.min(c.open, c.close) - c.low;
    const body     = Math.abs(c.close - c.open);

    // Crash/Boom spikes appear as full body candles on M1 (not wicks)
    // A spike = large directional body >= 4×ATR
    const isBullBody = c.close > c.open && body >= atr * 4;
    const isBearBody = c.close < c.open && body >= atr * 4;
    // Also keep wick detection as fallback for other brokers/TFs
    const isUpSpike   = wickUp   >= atr * 4 && wickUp   > body * 2;
    const isDownSpike = wickDown >= atr * 4 && wickDown > body * 2;

    const isUp   = isBullBody || isUpSpike;
    const isDown = isBearBody || isDownSpike;

    if (!isUp && !isDown) return null;

    const magnitude = isUp
        ? (isBullBody ? body : wickUp) / atr
        : (isBearBody ? body : wickDown) / atr;

    return {
        direction: isUp ? 'up' : 'down',
        magnitude,
        time: c.time,
    };
}

// ─────────────────────────────────────────────────────────────
// SINGLE-TF SIGNAL  — v2 with R:R fix and trend filter
// ─────────────────────────────────────────────────────────────
function _signalOnTF(candles, tfLabel, bias, recentSpike) {
    if (candles.length < 25) return null;

    const cl  = candles.slice(0, -1);
    const c0  = cl[cl.length - 1];
    const c1  = cl[cl.length - 2];
    const c2  = cl[cl.length - 3];
    if (!c0 || !c1 || !c2) return null;

    const rsiVal = _rsi(cl);
    const ema8   = _ema(cl, 8);
    const ema21  = _ema(cl, 21);
    const ema50  = _ema(cl, 50);
    const bbVal  = _bb(cl, 20);
    const atrVal = _atr(cl, 10);

    if (!rsiVal || !ema8 || !ema21 || !bbVal || !atrVal) return null;

    // ── TREND FILTER — price must be on correct side of EMA50 ─
    // Crash bias=BUY: price should be above EMA50 (uptrend between spikes)
    // Boom  bias=SELL: price should be below EMA50 (downtrend between spikes)
    // Relaxed if we just had a spike (immediate reversal entry)
    if (!recentSpike && ema50) {
        if (bias === 'BUY'  && c0.close < ema50 * 0.998) return null;
        if (bias === 'SELL' && c0.close > ema50 * 1.002) return null;
    }

    const { bull: engBull, bear: engBear } = _engulf(c1, c0);

    const votes   = { BUY: 0, SELL: 0 };
    const factors = { BUY: [], SELL: [] };

    // ── BIAS BONUS ───────────────────────────────────────────
    if (bias === 'SELL') { votes.SELL += 1; factors.SELL.push(`${tfLabel} drift↓`); }
    if (bias === 'BUY')  { votes.BUY  += 1; factors.BUY.push(`${tfLabel} drift↑`); }

    // ── POST-SPIKE FADE — highest quality entry ───────────────
    if (recentSpike) {
        if (recentSpike.direction === 'up'   && bias === 'SELL') { votes.SELL += 2; factors.SELL.push(`${tfLabel} post-spike↓`); }
        if (recentSpike.direction === 'down' && bias === 'BUY')  { votes.BUY  += 2; factors.BUY.push(`${tfLabel} post-spike↑`); }
    }

    // ── EMA alignment ────────────────────────────────────────
    if (ema8 > ema21 && c0.close > ema8)  { votes.BUY++;  factors.BUY.push(`${tfLabel} EMA↑`); }
    if (ema8 < ema21 && c0.close < ema8)  { votes.SELL++; factors.SELL.push(`${tfLabel} EMA↓`); }

    // ── RSI — fixed direction ─────────────────────────────────
    // BUY: RSI recovering from low (>40 confirming upward momentum)
    // SELL: RSI falling from high (<60 confirming downward momentum)
    if (rsiVal > 40 && rsiVal < 65) { votes.BUY++;  factors.BUY.push(`${tfLabel} RSI ${rsiVal.toFixed(0)}`); }
    if (rsiVal < 60 && rsiVal > 35) { votes.SELL++; factors.SELL.push(`${tfLabel} RSI ${rsiVal.toFixed(0)}`); }

    // ── BB band position ─────────────────────────────────────
    if (c0.low  <= bbVal.lower) { votes.BUY++;  factors.BUY.push(`${tfLabel} BB low`); }
    if (c0.high >= bbVal.upper) { votes.SELL++; factors.SELL.push(`${tfLabel} BB high`); }

    // ── Engulfing — strong reversal confirmation ──────────────
    if (engBull) { votes.BUY  += 2; factors.BUY.push(`${tfLabel} engulf↑`); }
    if (engBear) { votes.SELL += 2; factors.SELL.push(`${tfLabel} engulf↓`); }

    // ── 3-bar momentum in bias direction ─────────────────────
    if (c2.close < c1.close && c1.close < c0.close && bias === 'BUY')  { votes.BUY++;  factors.BUY.push(`${tfLabel} 3-bar↑`); }
    if (c2.close > c1.close && c1.close > c0.close && bias === 'SELL') { votes.SELL++; factors.SELL.push(`${tfLabel} 3-bar↓`); }

    // Require 3+ votes in bias direction
    if (votes.BUY  >= 3 && votes.BUY  > votes.SELL && bias === 'BUY')  return { dir: 'BUY',  count: votes.BUY,  factors: factors.BUY,  atr: atrVal };
    if (votes.SELL >= 3 && votes.SELL > votes.BUY  && bias === 'SELL') return { dir: 'SELL', count: votes.SELL, factors: factors.SELL, atr: atrVal };
    return null;
}

// ─────────────────────────────────────────────────────────────
// NOVA STRATEGY
// ─────────────────────────────────────────────────────────────
export const NovaStrategy = {

    _spikeState: {},

    getSpikeState(botId) {
        if (!this._spikeState[botId]) this._spikeState[botId] = { spike: null, cooldownUntil: 0 };
        return this._spikeState[botId];
    },

    recordSpike(botId, spike, tfSecs) {
        this._spikeState[botId] = {
            spike,
            cooldownUntil: Date.now() + tfSecs * 3 * 1000,
        };
    },

    inCooldown(botId) {
        return Date.now() < (this._spikeState[botId]?.cooldownUntil || 0);
    },

    checkEntry(symbol, m1Candles, m5Candles, m15Candles, recentSpike) {
        const cfg = novaSymbolConfig(symbol);
        if (!cfg) return null;

        const bias    = cfg.bias;
        const results = [];

        if (m1Candles?.length  >= 25) { const r = _signalOnTF(m1Candles,  'M1',  bias, recentSpike); if (r) results.push({ ...r, tf: 'M1'  }); }
        if (m5Candles?.length  >= 25) { const r = _signalOnTF(m5Candles,  'M5',  bias, recentSpike); if (r) results.push({ ...r, tf: 'M5'  }); }
        if (m15Candles?.length >= 25) { const r = _signalOnTF(m15Candles, 'M15', bias, recentSpike); if (r) results.push({ ...r, tf: 'M15' }); }

        if (results.length === 0) return null;

        const biasResults = results.filter(r => r.dir === bias);
        if (biasResults.length === 0) return null;

        // ── FIX A: Multi-TF gate ──────────────────────────────────────────────
        // Require at least 2 timeframes in agreement before firing.
        // Single-TF signals (1 TF with 3+ votes) caused 3× over-firing vs backtest.
        // This single line closes the primary gap between backtest and live trade count.
        if (biasResults.length < 2) return null;

        const tfCount    = biasResults.length;
        const allFactors = [...new Set(biasResults.flatMap(r => r.factors))];
        const bestATR    = biasResults.reduce((a, r) => Math.max(a, r.atr || 0), 0);
        const tfNames    = biasResults.map(r => r.tf).join('+');
        const hasEngulf  = allFactors.some(f => f.includes('engulf'));
        const hasSpike   = allFactors.some(f => f.includes('post-spike'));

        const score = Math.min(100,
            40
            + (tfCount - 1) * 15
            + (hasEngulf ? 10 : 0)
            + (hasSpike  ? 15 : 0)
            + biasResults.reduce((a, r) => a + r.count * 3, 0)
        );

        // ── v2 R:R FIX ────────────────────────────────────────
        // SL is TIGHTER than TP — losses smaller than wins.
        // slMultiplier 0.8 means SL = 0.8× ATR
        // tpMultiplier 1.5 means TP = 1.5× ATR → R:R = 1.875:1
        // Post-spike fade: slMult 0.8, tpMult 2.5 → R:R = 3.125:1
        const slMult = cfg.atrMult * 0.8;
        const tpMult = hasSpike ? cfg.atrMult * 2.5 : cfg.atrMult * 1.5;

        // ── FIX B: ATR/SL noise guard ─────────────────────────────────────────
        // On Crash 1000 M5, ATR is typically 1.5–4 pts. The designed SL is
        // 0.8× ATR = ~1.2–3.2 pts. When ATR is high (volatile candle), the SL
        // is sub-candle noise — a wick stop-out is near-certain on the next bar.
        // Skip the signal if the M5 ATR result is above the safe threshold.
        // Threshold tuning: start at 3.0, adjust after observing 1 day of ATR logs.
        // Increase if too many valid signals are blocked; decrease if wick stops persist.
        const M5_ATR_NOISE_THRESHOLD = 3.0; // pts — tune based on live ATR observations
        const m5Result = biasResults.find(r => r.tf === 'M5');
        if (m5Result?.atr && m5Result.atr > M5_ATR_NOISE_THRESHOLD) return null;

        return {
            type:         bias,
            label:        `NOVA ${bias} [${tfNames} ${score}]`,
            score,
            factors:      allFactors,
            tfCount,
            tfNames,
            tpMultiplier: tpMult,
            slMultiplier: slMult,
            isNova:       true,
            atr:          bestATR || null,
            symbolConfig: cfg,
        };
    },
};