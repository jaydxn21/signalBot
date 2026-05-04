// ═══════════════════════════════════════════════════════════════════════════
// KISMET VOLATILITY INDICES STRATEGY v2.0 (V10-V150 ONLY)
// Completely Restructured for Pure Volatility Trading
// ═══════════════════════════════════════════════════════════════════════════

const VOLATILITY_INDICES_CONFIG = {
    'V10':    { name: 'Volatility 10 Index',   tf: 'M1' },
    'V25':    { name: 'Volatility 25 Index',   tf: 'M1' },
    'V50':    { name: 'Volatility 50 Index',   tf: 'M1' },
    'V75':    { name: 'Volatility 75 Index',   tf: 'M1' },
    'V100':   { name: 'Volatility 100 Index',  tf: 'M1' },
    'V150':   { name: 'Volatility 150 Index',  tf: 'M1' },
    
    'JD10':   { name: 'Jump 10 Index',         tf: 'M1' },
    'JD25':   { name: 'Jump 25 Index',         tf: 'M1' },
    'JD50':   { name: 'Jump 50 Index',         tf: 'M1' },
    'JD75':   { name: 'Jump 75 Index',         tf: 'M1' },
    'JD100':  { name: 'Jump 100 Index',        tf: 'M1' },
    'JD150':  { name: 'Jump 150 Index',        tf: 'M1' },
};

function getVolatilityIndexConfig(symbol) {
    for (const [key, config] of Object.entries(VOLATILITY_INDICES_CONFIG)) {
        if (symbol.includes(key)) {
            return config;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE VOLATILITY INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    
    const trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        if (i === 0) continue;
        const c = candles[i];
        const p = candles[i - 1];
        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        );
        trs.push(tr);
    }
    
    return trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

function detectVolatilitySpike(candles, atr, threshold = 3.5) {
    if (!candles || candles.length < 2 || !atr) return null;
    
    const c = candles[candles.length - 2];
    if (!c) return null;
    
    const wickUp = c.high - Math.max(c.open, c.close);
    const wickDown = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    
    const isUp = wickUp >= atr * threshold && wickUp > body * 1.5;
    const isDown = wickDown >= atr * threshold && wickDown > body * 1.5;
    
    if (!isUp && !isDown) return null;
    
    return {
        direction: isUp ? 'up' : 'down',
        magnitude: (isUp ? wickUp : wickDown) / atr,
        type: isUp ? 'upper_wick' : 'lower_wick',
        price: c.close,
        time: c.time,
    };
}

function detectVolatilityMove(candles, atr) {
    if (!candles || candles.length < 5 || !atr) return null;
    
    const recent = candles.slice(-5);
    const ranges = recent.map(c => c.high - c.low);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const latestRange = recent[recent.length - 1].high - recent[recent.length - 1].low;
    
    if (latestRange < avgRange * 1.5) return null;
    
    return {
        type: 'volatility_expansion',
        magnitude: latestRange / avgRange,
        avgRange: parseFloat(avgRange.toFixed(2)),
        latestRange: parseFloat(latestRange.toFixed(2)),
    };
}

function detectPullback(candles) {
    if (!candles || candles.length < 5) return null;
    
    const recent = candles.slice(-5);
    const c0 = recent[recent.length - 1];
    const c1 = recent[recent.length - 2];
    const c2 = recent[recent.length - 3];
    const c3 = recent[recent.length - 4];
    
    const recentUp = c3.close < c2.close && c2.close < c1.close;
    const recentDown = c3.close > c2.close && c2.close > c1.close;
    
    if (!recentUp && !recentDown) return null;
    
    if (recentUp && c0.close < c1.close) return { direction: 'down', against: 'up_move' };
    if (recentDown && c0.close > c1.close) return { direction: 'up', against: 'down_move' };
    
    return null;
}

function detectVolatilityCompression(candles, atr) {
    if (!candles || candles.length < 25 || !atr) return null;
    
    const atr7 = calculateATR(candles, 7);
    const atr20 = calculateATR(candles, 20);
    
    if (!atr7 || !atr20) return null;
    
    const ratio = atr7 / atr20;
    
    if (ratio < 0.9) {
        return {
            type: 'compression',
            ratio: parseFloat(ratio.toFixed(2)),
            level: 'tight',
        };
    }
    return null;
}

function checkVolatilityExpansion(candles, atr) {
    if (!candles || candles.length < 25 || !atr) {
        return { isExpanding: false, ratio: 0, status: 'insufficient_data' };
    }
    
    const atr7 = calculateATR(candles, 7);
    const atr20 = calculateATR(candles, 20);
    
    if (!atr7 || !atr20) return { isExpanding: false, ratio: 0, status: 'calculation_failed' };
    
    const ratio = atr7 / atr20;
    
    let status = 'consolidation';
    if (ratio > 2.0) status = 'extreme_expansion';
    else if (ratio > 1.3) status = 'strong_expansion';
    else if (ratio > 1.05) status = 'normal_expansion';
    
    return {
        isExpanding: ratio > 1.05,
        ratio: parseFloat(ratio.toFixed(2)),
        status,
    };
}

function checkAcceleration(candles) {
    if (!candles || candles.length < 5) {
        return { isAccelerating: false, acceleration: 0 };
    }
    
    const recent = candles.slice(-5);
    const bodies = recent.slice(0, 3).map(c => Math.abs(c.close - c.open));
    const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
    const latestBody = recent[recent.length - 1] ? 
        Math.abs(recent[recent.length - 1].close - recent[recent.length - 1].open) : 0;
    
    const acceleration = avgBody > 0 ? latestBody / avgBody : 0;
    
    return {
        isAccelerating: acceleration > 1.2,
        acceleration: parseFloat(acceleration.toFixed(2)),
    };
}

function checkPriceActionConfirmation(candles, entryType) {
    if (!candles || candles.length < 5) return { isConfirmed: false, reason: 'insufficient_data' };
    
    const recent = candles.slice(-5);
    const latest = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    
    if (!latest || !prev) return { isConfirmed: false, reason: 'missing_candles' };
    
    if (entryType === 'BUY' || entryType === 'UP') {
        const isClosingUp = latest.close > prev.close;
        const hasBody = (latest.close - latest.open) > (latest.high - latest.low) * 0.3;
        if (isClosingUp && hasBody) return { isConfirmed: true, reason: 'closing_up_with_body' };
        if (latest.close >= prev.open) return { isConfirmed: true, reason: 'not_closing_below_previous' };
        return { isConfirmed: false, reason: 'closing_down' };
    }
    
    if (entryType === 'SELL' || entryType === 'DOWN') {
        const isClosingDown = latest.close < prev.close;
        const hasBody = (latest.open - latest.close) > (latest.high - latest.low) * 0.3;
        if (isClosingDown && hasBody) return { isConfirmed: true, reason: 'closing_down_with_body' };
        if (latest.close <= prev.open) return { isConfirmed: true, reason: 'not_closing_above_previous' };
        return { isConfirmed: false, reason: 'closing_up' };
    }
    
    return { isConfirmed: false, reason: 'unknown_entry_type' };
}

function runHybridCheck(candles, atr, entryType) {
    const volatility = checkVolatilityExpansion(candles, atr);
    const acceleration = checkAcceleration(candles);
    const priceAction = checkPriceActionConfirmation(candles, entryType);
    
    const pass = volatility.isExpanding && acceleration.isAccelerating && priceAction.isConfirmed;
    
    let score = 0;
    if (volatility.isExpanding) score += 30;
    if (acceleration.isAccelerating) score += 30;
    if (priceAction.isConfirmed) score += 30;
    if (pass && volatility.ratio > 1.3) score += 10;
    
    return { pass, score, volatility, acceleration, priceAction };
}

// Entry Modes
function tryVolatilitySpikeFade(candles, atr) {
    const spike = detectVolatilitySpike(candles, atr, 3.5);
    if (!spike) return null;
    
    const entryType = spike.direction === 'up' ? 'SELL' : 'BUY';
    
    return {
        mode: 'spike_fade',
        type: entryType,
        score: 70,
        factors: [`Volatility spike (${spike.magnitude.toFixed(1)}× ATR)`, `${spike.type} detected`, 'Mean reversion setup'],
        tpMultiplier: 2.5,
        slMultiplier: 0.6,
    };
}

function tryVolatilityExpansionFade(candles, atr) {
    const volMove = detectVolatilityMove(candles, atr);
    if (!volMove) return null;
    
    const pullback = detectPullback(candles);
    if (!pullback) return null;
    
    const entryType = pullback.against === 'up_move' ? 'BUY' : 'SELL';
    
    return {
        mode: 'volatility_expansion_fade',
        type: entryType,
        score: 65,
        factors: [`Volatility expansion (${volMove.magnitude.toFixed(1)}x)`, `Pullback detected`],
        tpMultiplier: 2.0,
        slMultiplier: 0.6,
    };
}

function tryVolatilityCompressionBreakout(candles, atr) {
    const compression = detectVolatilityCompression(candles, atr);
    if (!compression) return null;
    
    const recent = candles.slice(-3);
    const latestUp = recent[recent.length - 1].close > recent[recent.length - 2].close;
    const entryType = latestUp ? 'BUY' : 'SELL';
    
    return {
        mode: 'compression_breakout',
        type: entryType,
        score: 60,
        factors: ['Volatility compression detected', `Breakout ${latestUp ? 'UP' : 'DOWN'}`],
        tpMultiplier: 1.8,
        slMultiplier: 0.5,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN STRATEGY
// ═══════════════════════════════════════════════════════════════════════════

export const KismetVolatilityIndices = {
    _dailyStats: {},

    getDailyStats(botId) {
        const today = new Date(Date.now() - 5 * 3600000).toDateString();
        if (!this._dailyStats[botId] || this._dailyStats[botId].date !== today) {
            this._dailyStats[botId] = { wins: 0, losses: 0, date: today, consecutiveLosses: 0 };
        }
        return this._dailyStats[botId];
    },

    recordTradeOutcome(botId, outcome) {
        const stats = this.getDailyStats(botId);
        if (outcome === 'TP') {
            stats.wins++;
            stats.consecutiveLosses = 0;
        } else {
            stats.losses++;
            stats.consecutiveLosses++;
        }
    },

    isHalted(botId) {
        return this.getDailyStats(botId).consecutiveLosses >= 6;
    },

    checkEntry(symbol, candles, atr, botId = 'default') {
        const cfg = getVolatilityIndexConfig(symbol);
        if (!cfg) return null;
        if (!candles || candles.length < 25 || !atr) return null;
        if (this.isHalted(botId)) return null;

        const MIN_SL_POINTS = 1.0;
        if (atr * 0.6 < MIN_SL_POINTS) return null;
        if (atr > 100) return null;

        // Try entry modes in priority order
        let signal = tryVolatilitySpikeFade(candles, atr);
        if (signal) {
            const hybrid = runHybridCheck(candles, atr, signal.type);
            if (hybrid.pass) return this._buildSignal(signal, cfg, atr, hybrid.score);
        }

        signal = tryVolatilityExpansionFade(candles, atr);
        if (signal) {
            const hybrid = runHybridCheck(candles, atr, signal.type);
            if (hybrid.pass) return this._buildSignal(signal, cfg, atr, hybrid.score);
        }

        signal = tryVolatilityCompressionBreakout(candles, atr);
        if (signal) {
            const hybrid = runHybridCheck(candles, atr, signal.type);
            if (hybrid.pass) return this._buildSignal(signal, cfg, atr, hybrid.score);
        }

        return null;
    },

    _buildSignal(raw, cfg, atr, hybridScore) {
        const finalScore = Math.min(100, raw.score + hybridScore / 2);
        return {
            type: raw.type,
            mode: raw.mode,
            score: finalScore,
            factors: raw.factors,
            tpMultiplier: raw.tpMultiplier,
            slMultiplier: raw.slMultiplier,
            isKismet: true,
            isVolatilityIndex: true,
            symbol: cfg.name,
            atr,
        };
    },

    reset(botId = 'default') {
        this._dailyStats[botId] = { wins: 0, losses: 0, date: new Date().toDateString(), consecutiveLosses: 0 };
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export { KismetVolatilityIndices, getVolatilityIndexConfig };
export default KismetVolatilityIndices;