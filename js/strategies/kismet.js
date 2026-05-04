// ═══════════════════════════════════════════════════════════════════════════
// KISMET VOLATILITY INDICES STRATEGY v2.0
// Pure Volatility Trading for V10-V150 & JD Indices
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
        if (symbol.includes(key)) return config;
    }
    return null;
}

// Core Helper Functions (calculateATR, detectVolatilitySpike, etc.)
function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        if (i === 0) continue;
        const c = candles[i];
        const p = candles[i - 1];
        const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        trs.push(tr);
    }
    return trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

// ... [All your other helper functions remain the same] ...

// (I'm keeping the rest of your functions as-is for brevity - just ensure they are before the main object)

function tryVolatilitySpikeFade(candles, atr) { /* your code */ }
function tryVolatilityExpansionFade(candles, atr) { /* your code */ }
function tryVolatilityCompressionBreakout(candles, atr) { /* your code */ }
function runHybridCheck(candles, atr, entryType) { /* your code */ }

// ═══════════════════════════════════════════════════════════════════════════
// MAIN STRATEGY OBJECT
// ═══════════════════════════════════════════════════════════════════════════

const KismetVolatilityIndices = {
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
        if (!cfg || !candles || candles.length < 25 || !atr) return null;
        if (this.isHalted(botId)) return null;

        if (atr * 0.6 < 1.0 || atr > 100) return null;

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
        return {
            type: raw.type,
            mode: raw.mode,
            score: Math.min(100, raw.score + hybridScore / 2),
            factors: raw.factors,
            tpMultiplier: raw.tpMultiplier,
            slMultiplier: raw.slMultiplier,
            isKismet: true,
            isVolatilityIndex: true,
            symbol: cfg.name,
            atr,
        };
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS - ONLY ONE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

export { KismetVolatilityIndices, getVolatilityIndexConfig };
export default KismetVolatilityIndices;