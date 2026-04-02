// position-sizing.js — Dynamic Position Sizing Module
//
// PURPOSE: Prevent single losses from wiping multiple wins
// Based on Kimali's issue: worst loss (-$376.86) nearly equaled best win (+$362.82)
//
// FORMULA: Lot Size = (Account Equity × Risk %) / (Stop Loss in Pips × Pip Value)
//
// FEATURES:
//   - Per-trade risk % (default 0.5-1%)
//   - Pair-specific pip values
//   - Maximum position size limits
//   - Consecutive loss scaling (reduce size after losses)
//   - Win streak scaling (increase size after wins - optional)
//   - Daily loss limit

export const PositionSizing = {
    
    // Default configuration
    _config: {
        // Base risk per trade (percentage of account)
        baseRiskPercent: 0.75,      // 0.75% of account per trade
        
        // Minimum and maximum lot sizes
        minLot: 0.01,
        maxLot: 1.00,
        
        // Scaling after consecutive losses (reduce risk)
        lossScaling: {
            enabled: true,
            after1Loss: 0.8,        // 80% of base risk
            after2Losses: 0.6,      // 60% of base risk
            after3Losses: 0.4,      // 40% of base risk
            after4Losses: 0.2,      // 20% of base risk
            after5Losses: 0.0       // Stop trading
        },
        
        // Scaling after consecutive wins (increase risk - optional, conservative defaults)
        winScaling: {
            enabled: false,          // Disabled by default (conservative)
            after1Win: 1.0,
            after2Wins: 1.0,
            after3Wins: 1.05,
            after4Wins: 1.10,
            after5Wins: 1.15
        },
        
        // Daily loss limit (as percentage of account)
        dailyLossLimitPercent: 2.0,  // Stop trading after 2% daily loss
        
        // Maximum drawdown protection
        maxDrawdownPercent: 5.0,     // Reduce size after 5% drawdown
        
        // Instrument-specific pip values (USD per lot per pip)
        pipValues: {
            // Forex majors (standard 10 USD per pip per lot)
            'EURUSD': 10.0,
            'GBPUSD': 10.0,
            'USDJPY': 9.35,         // Approximate, varies with price
            'USDCHF': 10.0,
            'USDCAD': 10.0,
            'AUDUSD': 10.0,
            'NZDUSD': 10.0,
            
            // Forex crosses
            'EURGBP': 12.50,        // Approximate
            'EURJPY': 9.35,
            'GBPJPY': 12.50,
            'CADCHF': 10.0,
            'CHFJPY': 9.35,
            
            // Default for unknown
            'default': 10.0
        },
        
        // Point values for synthetic indices (Deriv)
        pointValues: {
            'CRASH1000': 0.41,
            'BOOM1000': 0.41,
            'CRASH500': 0.41,
            'BOOM500': 0.41,
            'cryBTCUSD': 0.01,
            'BTCUSD': 0.01,
            'R_100': 0.01,
            'R_75': 0.01,
            'default': 0.01
        }
    },
    
    // Per-session state (reset daily)
    _session: {
        date: null,
        dailyPnL: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        tradesToday: 0,
        peakEquity: 0,
        currentEquity: 0
    },
    
    // ─────────────────────────────────────────────────────────────
    // INITIALIZE / RESET SESSION
    // ─────────────────────────────────────────────────────────────
    init(initialEquity) {
        const today = new Date().toDateString();
        if (this._session.date !== today) {
            this._session = {
                date: today,
                dailyPnL: 0,
                consecutiveLosses: 0,
                consecutiveWins: 0,
                tradesToday: 0,
                peakEquity: initialEquity,
                currentEquity: initialEquity
            };
        }
        return this._session;
    },
    
    // ─────────────────────────────────────────────────────────────
    // UPDATE AFTER TRADE
    // ─────────────────────────────────────────────────────────────
    updateAfterTrade(outcome, pnlAmount, currentEquity) {
        this._session.dailyPnL += pnlAmount;
        this._session.currentEquity = currentEquity;
        this._session.tradesToday++;
        
        if (currentEquity > this._session.peakEquity) {
            this._session.peakEquity = currentEquity;
        }
        
        if (outcome === 'TP') {
            this._session.consecutiveLosses = 0;
            this._session.consecutiveWins++;
        } else {
            this._session.consecutiveLosses++;
            this._session.consecutiveWins = 0;
        }
    },
    
    // ─────────────────────────────────────────────────────────────
    // CHECK IF TRADING IS ALLOWED
    // ─────────────────────────────────────────────────────────────
    canTrade(accountEquity) {
        // Check daily loss limit
        const dailyLossLimit = accountEquity * (this._config.dailyLossLimitPercent / 100);
        if (this._session.dailyPnL <= -dailyLossLimit) {
            console.log(`[PositionSizing] Daily loss limit reached: ${this._session.dailyPnL.toFixed(2)}`);
            return false;
        }
        
        // Check max drawdown
        const drawdown = ((this._session.peakEquity - accountEquity) / this._session.peakEquity) * 100;
        if (drawdown > this._config.maxDrawdownPercent) {
            console.log(`[PositionSizing] Max drawdown ${drawdown.toFixed(1)}% exceeded`);
            return false;
        }
        
        // Stop after 5 consecutive losses
        if (this._session.consecutiveLosses >= 5) {
            console.log(`[PositionSizing] 5 consecutive losses — trading halted`);
            return false;
        }
        
        return true;
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET CURRENT RISK MULTIPLIER (based on streak)
    // ─────────────────────────────────────────────────────────────
    _getRiskMultiplier() {
        let multiplier = 1.0;
        
        // Loss scaling (reduce size after losses)
        if (this._config.lossScaling.enabled) {
            const losses = this._session.consecutiveLosses;
            if (losses >= 5) multiplier = this._config.lossScaling.after5Losses;
            else if (losses >= 4) multiplier = this._config.lossScaling.after4Losses;
            else if (losses >= 3) multiplier = this._config.lossScaling.after3Losses;
            else if (losses >= 2) multiplier = this._config.lossScaling.after2Losses;
            else if (losses >= 1) multiplier = this._config.lossScaling.after1Loss;
        }
        
        // Win scaling (increase size after wins - optional)
        if (this._config.winScaling.enabled && multiplier === 1.0) {
            const wins = this._session.consecutiveWins;
            if (wins >= 5) multiplier = this._config.winScaling.after5Wins;
            else if (wins >= 4) multiplier = this._config.winScaling.after4Wins;
            else if (wins >= 3) multiplier = this._config.winScaling.after3Wins;
            else if (wins >= 2) multiplier = this._config.winScaling.after2Wins;
            else if (wins >= 1) multiplier = this._config.winScaling.after1Win;
        }
        
        return multiplier;
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET PIP VALUE FOR SYMBOL
    // ─────────────────────────────────────────────────────────────
    getPipValue(symbol, accountCurrency = 'USD') {
        // Check forex pairs
        if (this._config.pipValues[symbol]) {
            return this._config.pipValues[symbol];
        }
        
        // Check synthetic indices (point value, not pip)
        if (this._config.pointValues[symbol]) {
            return this._config.pointValues[symbol];
        }
        
        // Default
        return this._config.pipValues.default;
    },
    
    // ─────────────────────────────────────────────────────────────
    // CALCULATE STOP LOSS IN PRICE UNITS (pips or points)
    // ─────────────────────────────────────────────────────────────
    calculateStopDistance(atr, slMultiplier, symbol) {
        // ATR is already in price units
        let stopDistance = atr * slMultiplier;
        
        // For forex, convert to pips (1 pip = 0.0001 for most pairs)
        if (symbol.startsWith('frx') || this._config.pipValues[symbol]) {
            // Check if it's a JPY pair (1 pip = 0.01)
            const isJPY = symbol.includes('JPY');
            const pipSize = isJPY ? 0.01 : 0.0001;
            
            // Return stop in pips for easier calculation
            return stopDistance / pipSize;
        }
        
        // For synthetics, return as-is
        return stopDistance;
    },
    
    // ─────────────────────────────────────────────────────────────
    // MAIN FUNCTION: CALCULATE LOT SIZE
    // ─────────────────────────────────────────────────────────────
    calculateLotSize({
        symbol,
        accountEquity,
        atr,
        slMultiplier,
        riskPercent = null,        // Override base risk
        maxLotOverride = null,      // Override max lot
        useStreakScaling = true     // Apply consecutive loss/win scaling
    }) {
        // Initialize session if needed
        this.init(accountEquity);
        
        // Check if trading is allowed
        if (!this.canTrade(accountEquity)) {
            return { lotSize: 0, allowed: false, reason: 'Trading halted' };
        }
        
        // Determine risk percent
        let riskPct = riskPercent || this._config.baseRiskPercent;
        
        // Apply streak scaling
        if (useStreakScaling) {
            riskPct *= this._getRiskMultiplier();
        }
        
        // Calculate risk amount in dollars
        const riskAmount = accountEquity * (riskPct / 100);
        
        // Get stop distance in pips/points
        const stopDistance = this.calculateStopDistance(atr, slMultiplier, symbol);
        
        if (stopDistance <= 0) {
            return { lotSize: 0, allowed: false, reason: 'Invalid stop distance' };
        }
        
        // Get pip/point value
        const pipValue = this.getPipValue(symbol);
        
        // Calculate lot size
        // Formula: Lot Size = Risk Amount / (Stop Distance × Pip Value)
        let lotSize = riskAmount / (stopDistance * pipValue);
        
        // Round to 2 decimal places (standard lot size format)
        lotSize = Math.round(lotSize * 100) / 100;
        
        // Apply min/max limits
        const minLot = this._config.minLot;
        const maxLot = maxLotOverride || this._config.maxLot;
        
        if (lotSize < minLot) {
            lotSize = minLot;
        }
        if (lotSize > maxLot) {
            lotSize = maxLot;
        }
        
        // Additional safety: reduce size during high drawdown
        const drawdown = ((this._session.peakEquity - accountEquity) / this._session.peakEquity) * 100;
        if (drawdown > 3.0) {
            const drawdownFactor = Math.max(0.5, 1 - (drawdown - 3) / 10);
            lotSize = Math.round(lotSize * drawdownFactor * 100) / 100;
            console.log(`[PositionSizing] Drawdown ${drawdown.toFixed(1)}% — reducing lot size by ${((1 - drawdownFactor) * 100).toFixed(0)}%`);
        }
        
        // Final safety: never exceed 2% of account value as total exposure
        const maxExposure = accountEquity * 0.02 / (stopDistance * pipValue);
        if (lotSize > maxExposure) {
            lotSize = Math.round(maxExposure * 100) / 100;
        }
        
        return {
            lotSize: lotSize,
            allowed: true,
            riskPercent: riskPct,
            riskAmount: riskAmount,
            stopDistance: stopDistance,
            pipValue: pipValue,
            consecutiveLosses: this._session.consecutiveLosses,
            consecutiveWins: this._session.consecutiveWins,
            dailyPnL: this._session.dailyPnL,
            drawdown: drawdown
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // CONVENIENCE: FOREX-SPECIFIC CALCULATION
    // ─────────────────────────────────────────────────────────────
    calculateForexLotSize({
        symbol,
        accountEquity,
        stopPips,           // Stop loss in pips
        riskPercent = 0.75,
        pipValue = 10.0     // Default $10 per pip per lot
    }) {
        const riskAmount = accountEquity * (riskPercent / 100);
        let lotSize = riskAmount / (stopPips * pipValue);
        lotSize = Math.round(lotSize * 100) / 100;
        
        // Apply min/max
        lotSize = Math.max(this._config.minLot, Math.min(this._config.maxLot, lotSize));
        
        return lotSize;
    },
    
    // ─────────────────────────────────────────────────────────────
    // UPDATE CONFIGURATION
    // ─────────────────────────────────────────────────────────────
    updateConfig(newConfig) {
        this._config = { ...this._config, ...newConfig };
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET SESSION STATS
    // ─────────────────────────────────────────────────────────────
    getSessionStats() {
        return { ...this._session };
    },
    
    // ─────────────────────────────────────────────────────────────
    // RESET SESSION (manual override)
    // ─────────────────────────────────────────────────────────────
    resetSession(equity) {
        this._session = {
            date: new Date().toDateString(),
            dailyPnL: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            tradesToday: 0,
            peakEquity: equity,
            currentEquity: equity
        };
    }
};

// ─────────────────────────────────────────────────────────────
// EXPORT FOR USE IN STRATEGIES
// ─────────────────────────────────────────────────────────────
export default PositionSizing;