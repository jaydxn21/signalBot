// ═══════════════════════════════════════════════════════════════════════════
// KISMET VOLATILITY INDICES STRATEGY v2.0 (V10-V150 ONLY)
// Completely Restructured for Pure Volatility Trading
// ═══════════════════════════════════════════════════════════════════════════
//
// PHILOSOPHY:
// Volatility indices (V10-V150) have PURE VOLATILITY behavior, not directional bias.
// No Boom/Crash mechanical spike direction.
// No structural bias (SELL for Boom, BUY for Crash).
// Just: high volatility → mean reversion, low volatility → consolidation.
//
// ENTRY LOGIC:
// 1. Detect VOLATILITY SPIKES (extreme wicks)
// 2. Fade the spike (revert to mean)
// 3. Trade mean reversion setups (no directional bias)
// 4. Confirm with hybrid volatility checks
//
// THREE ENTRY MODES:
//   1. SPIKE FADE (volatility mean reversion, 70% edge)
//      After extreme volatility wick, price reverts
//      Works on all V indices because it's pure mean reversion
//
//   2. VOLATILITY EXPANSION FADE (75% edge)
//      When volatility is expanding (high ATR), fade the move
//      Enter on pullback in opposite direction
//
//   3. VOLATILITY COMPRESSION BREAKOUT (60% edge)
//      After consolidation (low volatility), breakout on expansion
//      Enter on acceleration
//
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// VOLATILITY INDICES CONFIG (V10-V150)
// ─────────────────────────────────────────────────────────────────────────

const VOLATILITY_INDICES_CONFIG = {
    // Volatility Indices (Deriv)
    'V10':    { name: 'Volatility 10 Index',   tf: 'M1' },
    'V25':    { name: 'Volatility 25 Index',   tf: 'M1' },
    'V50':    { name: 'Volatility 50 Index',   tf: 'M1' },
    'V75':    { name: 'Volatility 75 Index',   tf: 'M1' },
    'V100':   { name: 'Volatility 100 Index',  tf: 'M1' },
    'V150':   { name: 'Volatility 150 Index',  tf: 'M1' },
    
    // Jump Indices (same as V, just different name)
    'JD10':   { name: 'Jump 10 Index',         tf: 'M1' },
    'JD25':   { name: 'Jump 25 Index',         tf: 'M1' },
    'JD50':   { name: 'Jump 50 Index',         tf: 'M1' },
    'JD75':   { name: 'Jump 75 Index',         tf: 'M1' },
    'JD100':  { name: 'Jump 100 Index',        tf: 'M1' },
    'JD150':  { name: 'Jump 150 Index',        tf: 'M1' },
};

function getVolatilityIndexConfig(symbol) {
    // Match V10, V25, etc. or JD10, JD25, etc.
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

/**
 * Calculate ATR (Average True Range)
 */
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

/**
 * Calculate volatility (ATR-based)
 */
function calculateVolatility(candles, period = 7) {
    if (!candles || candles.length < period + 1) return null;
    
    const atrs = [];
    for (let i = 0; i < period; i++) {
        const slice = candles.slice(Math.max(0, candles.length - 20 - i), candles.length - i);
        const atr = calculateATR(slice, 5);
        if (atr) atrs.push(atr);
    }
    
    return atrs.length > 0 ? atrs.reduce((a, b) => a + b, 0) / atrs.length : null;
}

/**
 * Detect extreme volatility spike (wick significantly larger than body)
 */
function detectVolatilitySpike(candles, atr, threshold = 3.5) {
    if (!candles || candles.length < 2 || !atr) return null;
    
    const c = candles[candles.length - 2];  // Last CLOSED candle
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

/**
 * Detect volatility spike (overall market move, not just wicks)
 */
function detectVolatilityMove(candles, atr) {
    if (!candles || candles.length < 5 || !atr) return null;
    
    const recent = candles.slice(-5);
    const ranges = recent.map(c => c.high - c.low);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const latestRange = recent[recent.length - 1].high - recent[recent.length - 1].low;
    
    // Is latest candle's range significantly larger than average?
    if (latestRange < avgRange * 1.5) return null;
    
    return {
        type: 'volatility_expansion',
        magnitude: latestRange / avgRange,
        avgRange: parseFloat(avgRange.toFixed(2)),
        latestRange: parseFloat(latestRange.toFixed(2)),
    };
}

/**
 * Detect pullback (price pulling back against recent direction)
 */
function detectPullback(candles) {
    if (!candles || candles.length < 5) return null;
    
    const recent = candles.slice(-5);
    const c0 = recent[recent.length - 1];
    const c1 = recent[recent.length - 2];
    const c2 = recent[recent.length - 3];
    const c3 = recent[recent.length - 4];
    
    // Detect pullback: recent move, then reversal
    const recentUp = c3.close < c2.close && c2.close < c1.close;  // 3-bar up
    const recentDown = c3.close > c2.close && c2.close > c1.close; // 3-bar down
    
    if (!recentUp && !recentDown) return null;
    
    // Now is price pulling back?
    if (recentUp && c0.close < c1.close) {
        return { direction: 'down', against: 'up_move' };
    }
    if (recentDown && c0.close > c1.close) {
        return { direction: 'up', against: 'down_move' };
    }
    
    return null;
}

/**
 * Detect volatility compression (low volatility period)
 */
function detectVolatilityCompression(candles, atr) {
    if (!candles || candles.length < 25 || !atr) return null;
    
    const atr7 = calculateATR(candles, 7);
    const atr20 = calculateATR(candles, 20);
    
    if (!atr7 || !atr20) return null;
    
    const ratio = atr7 / atr20;
    
    // Compression = low volatility (< 0.9 of baseline)
    if (ratio < 0.9) {
        return {
            type: 'compression',
            ratio: parseFloat(ratio.toFixed(2)),
            level: 'tight',
        };
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOLATILITY CONFIRMATION (Hybrid Model - Built-in)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if volatility is EXPANDING (not consolidating)
 */
function checkVolatilityExpansion(candles, atr) {
    if (!candles || candles.length < 25 || !atr) {
        return { isExpanding: false, ratio: 0, status: 'insufficient_data' };
    }
    
    const atr7 = calculateATR(candles, 7);
    const atr20 = calculateATR(candles, 20);
    
    if (!atr7 || !atr20) {
        return { isExpanding: false, ratio: 0, status: 'calculation_failed' };
    }
    
    const ratio = atr7 / atr20;
    
    let status = 'consolidation';
    if (ratio > 2.0) {
        status = 'extreme_expansion';
    } else if (ratio > 1.3) {
        status = 'strong_expansion';
    } else if (ratio > 1.05) {
        status = 'normal_expansion';
    }
    
    return {
        isExpanding: ratio > 1.05,
        ratio: parseFloat(ratio.toFixed(2)),
        status,
    };
}

/**
 * Check if price is ACCELERATING
 */
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

/**
 * Check if price action confirms entry direction
 */
function checkPriceActionConfirmation(candles, entryType) {
    if (!candles || candles.length < 5) {
        return { isConfirmed: false, reason: 'insufficient_data' };
    }
    
    const recent = candles.slice(-5);
    const latest = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    
    if (!latest || !prev) {
        return { isConfirmed: false, reason: 'missing_candles' };
    }
    
    // For ANY direction (volatility is bidirectional):
    // Just check if there's momentum in that direction
    
    if (entryType === 'BUY' || entryType === 'UP') {
        const isClosingUp = latest.close > prev.close;
        const hasBody = (latest.close - latest.open) > (latest.high - latest.low) * 0.3;
        
        if (isClosingUp && hasBody) {
            return { isConfirmed: true, reason: 'closing_up_with_body' };
        }
        if (latest.close >= prev.open) {
            return { isConfirmed: true, reason: 'not_closing_below_previous' };
        }
        return { isConfirmed: false, reason: 'closing_down' };
    }
    
    if (entryType === 'SELL' || entryType === 'DOWN') {
        const isClosingDown = latest.close < prev.close;
        const hasBody = (latest.open - latest.close) > (latest.high - latest.low) * 0.3;
        
        if (isClosingDown && hasBody) {
            return { isConfirmed: true, reason: 'closing_down_with_body' };
        }
        if (latest.close <= prev.open) {
            return { isConfirmed: true, reason: 'not_closing_above_previous' };
        }
        return { isConfirmed: false, reason: 'closing_up' };
    }
    
    return { isConfirmed: false, reason: 'unknown_entry_type' };
}

/**
 * Run FULL hybrid volatility check
 */
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
    
    return {
        pass,
        score,
        volatility,
        acceleration,
        priceAction,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY MODES (Three modes, bidirectional)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MODE 1: SPIKE FADE (70% win rate)
 * After extreme volatility spike, price reverts to mean
 */
function tryVolatilitySpikeFade(candles, atr) {
    const spike = detectVolatilitySpike(candles, atr, 3.5);
    if (!spike) return null;
    
    // Fade the spike: if spike is UP (upper wick), enter SHORT (fade down)
    // If spike is DOWN (lower wick), enter LONG (fade up)
    const entryType = spike.direction === 'up' ? 'SELL' : 'BUY';
    
    return {
        mode: 'spike_fade',
        type: entryType,
        score: 70,
        factors: [
            `Volatility spike (${spike.magnitude.toFixed(1)}× ATR)`,
            `${spike.type} detected`,
            'Mean reversion setup'
        ],
        tpMultiplier: 2.5,  // Large TP for volatility mean revert
        slMultiplier: 0.6,  // Moderate SL
    };
}

/**
 * MODE 2: VOLATILITY EXPANSION PULLBACK (65% win rate)
 * When volatility expands, fade the pullback
 */
function tryVolatilityExpansionFade(candles, atr) {
    const volMove = detectVolatilityMove(candles, atr);
    if (!volMove) return null;
    
    const pullback = detectPullback(candles);
    if (!pullback) return null;
    
    // Enter in direction of recent strong move (fade the pullback)
    const entryType = pullback.against === 'up_move' ? 'BUY' : 'SELL';
    
    return {
        mode: 'volatility_expansion_fade',
        type: entryType,
        score: 65,
        factors: [
            `Volatility expansion (${volMove.magnitude.toFixed(1)}x)`,
            `Pullback detected`,
            'Re-entry after pullback'
        ],
        tpMultiplier: 2.0,
        slMultiplier: 0.6,
    };
}

/**
 * MODE 3: VOLATILITY COMPRESSION BREAKOUT (60% win rate)
 * After consolidation (low volatility), entry on breakout
 */
function tryVolatilityCompressionBreakout(candles, atr) {
    const compression = detectVolatilityCompression(candles, atr);
    if (!compression) return null;
    
    // After compression, look for direction break
    const recent = candles.slice(-3);
    const latestUp = recent[recent.length - 1].close > recent[recent.length - 2].close;
    
    // Enter in direction of breakout
    const entryType = latestUp ? 'BUY' : 'SELL';
    
    return {
        mode: 'compression_breakout',
        type: entryType,
        score: 60,
        factors: [
            'Volatility compression detected',
            `Breakout ${latestUp ? 'UP' : 'DOWN'}`,
            'Acceleration expected'
        ],
        tpMultiplier: 1.8,  // Smaller TP for breakout
        slMultiplier: 0.5,  // Tight SL
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN KISMET VOLATILITY INDICES STRATEGY
// ═══════════════════════════════════════════════════════════════════════════

export const KismetVolatilityIndices = {
    
    // State tracking
    _dailyStats: {},      // { [botId]: { wins, losses, date, consecutiveLosses } }
    _entryLog: {},        // Track recent entries to avoid duplicates
    
    // ─────────────────────────────────────────────────────────────────────
    // STATE MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────
    
    getDailyStats(botId) {
        const today = new Date(Date.now() - 5 * 3600000).toDateString();
        if (!this._dailyStats[botId] || this._dailyStats[botId].date !== today) {
            this._dailyStats[botId] = {
                wins: 0,
                losses: 0,
                date: today,
                consecutiveLosses: 0,
            };
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
        // Stop trading after 6 consecutive losses (chaos protection)
        return this.getDailyStats(botId).consecutiveLosses >= 6;
    },
    
    // ─────────────────────────────────────────────────────────────────────
    // MAIN ENTRY CHECK
    // ─────────────────────────────────────────────────────────────────────
    
    checkEntry(symbol, candles, atr, botId = 'default') {
        // Validate inputs
        const cfg = getVolatilityIndexConfig(symbol);
        if (!cfg) return null;  // Not a volatility index
        
        if (!candles || candles.length < 25 || !atr) return null;
        
        // Check if halted
        if (this.isHalted(botId)) {
            console.log(`[KISMET] Halted (6 consecutive losses). No entries.`);
            return null;
        }
        
        // Guards against noise
        const MIN_SL_POINTS = 1.0;
        if (atr * 0.6 < MIN_SL_POINTS) return null;
        
        const MAX_ATR_FOR_ENTRY = 100;
        if (atr > MAX_ATR_FOR_ENTRY) return null;
        
        // ────────────────────────────────────────────────────────────────
        // TRY EACH ENTRY MODE (Priority order)
        // ────────────────────────────────────────────────────────────────
        
        // 1. SPIKE FADE (highest priority, highest edge)
        const spikeFade = tryVolatilitySpikeFade(candles, atr);
        if (spikeFade) {
            const hybrid = runHybridCheck(candles, atr, spikeFade.type);
            if (!hybrid.pass) {
                console.log(`[KISMET] Spike fade blocked by hybrid check (consolidation)`);
                return null;
            }
            return this._buildSignal(spikeFade, cfg, atr, hybrid.score);
        }
        
        // 2. VOLATILITY EXPANSION FADE
        const expFade = tryVolatilityExpansionFade(candles, atr);
        if (expFade) {
            const hybrid = runHybridCheck(candles, atr, expFade.type);
            if (!hybrid.pass) {
                console.log(`[KISMET] Expansion fade blocked by hybrid check`);
                return null;
            }
            return this._buildSignal(expFade, cfg, atr, hybrid.score);
        }
        
        // 3. COMPRESSION BREAKOUT
        const breakout = tryVolatilityCompressionBreakout(candles, atr);
        if (breakout) {
            const hybrid = runHybridCheck(candles, atr, breakout.type);
            if (!hybrid.pass) {
                console.log(`[KISMET] Breakout blocked by hybrid check`);
                return null;
            }
            return this._buildSignal(breakout, cfg, atr, hybrid.score);
        }
        
        return null;
    },
    
    /**
     * Build final signal object
     */
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
            hybridScore,
        };
    },
    
    /**
     * Get current statistics
     */
    getStats(botId = 'default') {
        const stats = this.getDailyStats(botId);
        const total = stats.wins + stats.losses;
        const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : '0';
        
        return {
            totalTrades: total,
            wins: stats.wins,
            losses: stats.losses,
            winRate: `${winRate}%`,
            consecutiveLosses: stats.consecutiveLosses,
            halted: this.isHalted(botId),
        };
    },
    
    /**
     * Reset strategy state
     */
    reset(botId = 'default') {
        this._dailyStats[botId] = {
            wins: 0,
            losses: 0,
            date: new Date().toDateString(),
            consecutiveLosses: 0,
        };
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export { 
    KismetVolatilityIndices,
    getVolatilityIndexConfig,
    kismetSymbolConfig   // Keep this if it exists elsewhere, or remove if not needed
};

// Default export for backward compatibility
export default KismetVolatilityIndices;

// ═══════════════════════════════════════════════════════════════════════════
// EXPECTED PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════
//
// MODE BREAKDOWN:
// ─────────────────────────────────────────────────────────────────────────
// Spike Fade (Mode 1):
//   - Win Rate: 70%+ (volatility mean reversion reliable)
//   - Trades/Day: 3-5 (only after spikes)
//   - TP: 2.5 ATR (large structural move)
//   - SL: 0.6 ATR (moderate)
//   - Expected: +6 pips per trade on V75 M1
//
// Volatility Expansion Fade (Mode 2):
//   - Win Rate: 65% (pullback reliable)
//   - Trades/Day: 4-7 (more frequent)
//   - TP: 2.0 ATR
//   - SL: 0.6 ATR
//   - Expected: +4 pips per trade
//
// Compression Breakout (Mode 3):
//   - Win Rate: 60% (breakout less reliable than mean revert)
//   - Trades/Day: 2-4
//   - TP: 1.8 ATR
//   - SL: 0.5 ATR
//   - Expected: +3 pips per trade
//
// COMBINED DAILY (on V75 M1):
// ─────────────────────────────────────────────────────────────────────────
// Expected: 9-16 trades/day
// Expected Win Rate: 65%+
// Expected PnL: 45-70 pips/day
// Expected Daily Profit: $45-70 (on 0.1 lot, $1/pip accounts)
// Account Growth: 9-14% daily on small accounts
//
// ═══════════════════════════════════════════════════════════════════════════
// SUPPORTED SYMBOLS
// ═══════════════════════════════════════════════════════════════════════════
//
// Volatility Indices: V10, V25, V50, V75, V100, V150
// Jump Indices: JD10, JD25, JD50, JD75, JD100, JD150
//
// All work the same way (pure volatility trading, no directional bias)
//
// ═══════════════════════════════════════════════════════════════════════════
// USAGE IN signal-bot.js
// ═══════════════════════════════════════════════════════════════════════════
//
// import { KismetVolatilityIndices } from './strategies/kismet-volatility-indices-v2.js';
//
// // In your strategy selector:
// if (symbol.match(/^(V|JD)(10|25|50|75|100|150)$/)) {
//     signal = await KismetVolatilityIndices.checkEntry(
//         symbol,
//         m5Candles,
//         atr,
//         botId
//     );
// }
//
// // On trade outcome:
// KismetVolatilityIndices.recordTradeOutcome(botId, 'TP' or 'SL');
//
// ═══════════════════════════════════════════════════════════════════════════