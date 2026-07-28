// strategy-engine.js — Simplified for auto-discovery

// ─── DYNAMIC STRATEGY LOADER ─────────────────────────────────────────────

let strategyModules = {};

async function loadStrategy(strategyName) {
    try {
        const module = await import(`./strategies/${strategyName}.js`);
        const Strategy = module.default || Object.values(module).find(v => typeof v === 'function');
        if (Strategy) {
            strategyModules[strategyName] = Strategy;
            console.log(`✅ StrategyEngine loaded: ${strategyName}`);
            return Strategy;
        }
    } catch (e) {
        // Strategy doesn't exist
    }
    return null;
}

async function getStrategy(strategyName) {
    if (!strategyModules[strategyName]) {
        await loadStrategy(strategyName);
    }
    return strategyModules[strategyName] || null;
}

// ─── STRATEGY ENGINE ─────────────────────────────────────────────────────

export class StrategyEngine {
    constructor() {
        this.lastSignalTime = 0;
        this.strategyCache = {};
    }

    async analyze(strategyType, lowerTFCandles, higherTFCandles, rsiState, atr, symbol = '', rsi = null) {
        // First, try to get the strategy
        let Strategy = strategyModules[strategyType];
        
        // If not loaded, try to load it
        if (!Strategy) {
            Strategy = await loadStrategy(strategyType);
            if (!Strategy) {
                console.warn(`Strategy "${strategyType}" not found`);
                return null;
            }
        }

        // Check if the strategy has a checkEntry method
        if (typeof Strategy.checkEntry !== 'function') {
            console.warn(`Strategy "${strategyType}" missing checkEntry method`);
            return null;
        }

        // Prevent duplicate signals on same candle
        const lastCandle = lowerTFCandles[lowerTFCandles.length - 1];
        if (!lastCandle || lastCandle.time === this.lastSignalTime) {
            return null;
        }

        let signal = null;

        try {
            // Call the strategy's checkEntry with appropriate parameters
            // Most strategies expect (candles, atr, symbol, ...)
            // Some need higher timeframe candles
            if (strategyType === 'h4_kiss' || strategyType === 'cipher') {
                signal = Strategy.checkEntry(lowerTFCandles, higherTFCandles, atr, symbol);
            } else if (strategyType === 'momentum') {
                signal = Strategy.checkEntry(lowerTFCandles, atr, symbol, higherTFCandles, rsi);
            } else {
                signal = Strategy.checkEntry(lowerTFCandles, atr, symbol);
            }
        } catch (error) {
            console.error(`Strategy "${strategyType}" error:`, error);
            return null;
        }

        if (signal) {
            this.lastSignalTime = lastCandle.time;
            return signal;
        }

        return null;
    }

    async registerLoss(strategyType) {
        try {
            const Strategy = await getStrategy(strategyType);
            if (Strategy && typeof Strategy.registerLoss === 'function') {
                Strategy.registerLoss();
            }
        } catch (e) {
            // Ignore
        }
    }

    // Helper to get available strategies
    static async getAvailableStrategies() {
        try {
            const response = await fetch('/api/strategy-manifest');
            if (response.ok) {
                const manifest = await response.json();
                return manifest.strategies.map(s => s.name);
            }
        } catch (e) {
            // Fallback
        }
        return ['breakout_trend'];
    }

    // Helper to check if a strategy exists
    static async strategyExists(strategyName) {
        const available = await StrategyEngine.getAvailableStrategies();
        return available.includes(strategyName);
    }
}

// ─── EXPOSE TO WINDOW ────────────────────────────────────────────────────

window.StrategyEngine = StrategyEngine;
window._strategyModules = strategyModules;

// ─── PRELOAD DEFAULT STRATEGY ────────────────────────────────────────────

// Try to load the default strategy on init
(async function preloadDefaultStrategy() {
    try {
        const module = await import('./strategies/breakout_trend.js');
        const Strategy = module.default || Object.values(module).find(v => typeof v === 'function');
        if (Strategy) {
            strategyModules['breakout_trend'] = Strategy;
            console.log('✅ Preloaded breakout_trend strategy');
        }
    } catch (e) {
        console.log('ℹ️ breakout_trend not found, will load on demand');
    }
})();