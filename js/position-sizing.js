// position-sizing.js — Dynamic Position Sizing Module
//
// PURPOSE: Prevent single losses from wiping multiple wins
//
// FORMULA: Lot Size = (Account Equity × Risk %) / (Stop Loss in Pips × Pip Value)

export const PositionSizing = {
    
    // Default configuration
    _config: {
        baseRiskPercent: 0.75,
        minLot: 0.01,
        maxLot: 1.00,
        lossScaling: {
            enabled: true,
            after1Loss: 0.8,
            after2Losses: 0.6,
            after3Losses: 0.4,
            after4Losses: 0.2,
            after5Losses: 0.0
        },
        winScaling: {
            enabled: false,
            after1Win: 1.0,
            after2Wins: 1.0,
            after3Wins: 1.05,
            after4Wins: 1.10,
            after5Wins: 1.15
        },
        dailyLossLimitPercent: 2.0,
        maxDrawdownPercent: 5.0,
        pipValues: {
            'EURUSD': 10.0, 'GBPUSD': 10.0, 'USDJPY': 9.35,
            'USDCHF': 10.0, 'USDCAD': 10.0, 'AUDUSD': 10.0,
            'NZDUSD': 10.0, 'EURGBP': 12.50, 'EURJPY': 9.35,
            'GBPJPY': 12.50, 'CADCHF': 10.0, 'CHFJPY': 9.35,
            'default': 10.0
        },
        pointValues: {
            'CRASH1000': 0.41, 'BOOM1000': 0.41,
            'CRASH500': 0.41, 'BOOM500': 0.41,
            'cryBTCUSD': 0.01, 'BTCUSD': 0.01,
            'R_100': 0.01, 'R_75': 0.01,
            'default': 0.01
        }
    },
    
    // Per-session state
    _session: {
        date: null,
        dailyPnL: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        tradesToday: 0,
        peakEquity: 0,
        currentEquity: 0
    },
    
    _symbolState: new Map(),
    
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
    // RESET (force reset all state - FIXED)
    // ─────────────────────────────────────────────────────────────
    reset() {
        const today = new Date().toDateString();
        this._session = {
            date: today,
            dailyPnL: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            tradesToday: 0,
            peakEquity: this._session?.peakEquity || 10000,
            currentEquity: this._session?.currentEquity || 10000
        };
        this._symbolState.clear();
        console.log(`[PositionSizing] Reset complete - all streaks cleared`);
    },
    
    // ─────────────────────────────────────────────────────────────
    // RESET SESSION (manual override)
    // ─────────────────────────────────────────────────────────────
    resetSession(equity) {
        const today = new Date().toDateString();
        this._session = {
            date: today,
            dailyPnL: 0,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            tradesToday: 0,
            peakEquity: equity,
            currentEquity: equity
        };
        this._symbolState.clear();
        console.log(`[PositionSizing] Session reset - equity: $${equity}`);
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
        const dailyLossLimit = accountEquity * (this._config.dailyLossLimitPercent / 100);
        if (this._session.dailyPnL <= -dailyLossLimit) {
            console.log(`[PositionSizing] Daily loss limit reached: ${this._session.dailyPnL.toFixed(2)}`);
            return false;
        }
        
        const drawdown = ((this._session.peakEquity - accountEquity) / this._session.peakEquity) * 100;
        if (drawdown > this._config.maxDrawdownPercent) {
            console.log(`[PositionSizing] Max drawdown ${drawdown.toFixed(1)}% exceeded`);
            return false;
        }
        
        if (this._session.consecutiveLosses >= 5) {
            console.log(`[PositionSizing] 5 consecutive losses — trading halted`);
            return false;
        }
        
        return true;
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET CURRENT RISK MULTIPLIER
    // ─────────────────────────────────────────────────────────────
    _getRiskMultiplier() {
        let multiplier = 1.0;
        
        if (this._config.lossScaling.enabled) {
            const losses = this._session.consecutiveLosses;
            if (losses >= 5) multiplier = this._config.lossScaling.after5Losses;
            else if (losses >= 4) multiplier = this._config.lossScaling.after4Losses;
            else if (losses >= 3) multiplier = this._config.lossScaling.after3Losses;
            else if (losses >= 2) multiplier = this._config.lossScaling.after2Losses;
            else if (losses >= 1) multiplier = this._config.lossScaling.after1Loss;
        }
        
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
    getPipValue(symbol) {
        if (this._config.pipValues[symbol]) {
            return this._config.pipValues[symbol];
        }
        if (this._config.pointValues[symbol]) {
            return this._config.pointValues[symbol];
        }
        return this._config.pipValues.default;
    },
    
    // ─────────────────────────────────────────────────────────────
    // CALCULATE STOP LOSS DISTANCE
    // ─────────────────────────────────────────────────────────────
    calculateStopDistance(atr, slMultiplier, symbol) {
        let stopDistance = atr * slMultiplier;
        
        if (symbol.startsWith('frx') || this._config.pipValues[symbol]) {
            const isJPY = symbol.includes('JPY');
            const pipSize = isJPY ? 0.01 : 0.0001;
            return stopDistance / pipSize;
        }
        
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
        riskPercent = null,
        maxLotOverride = null,
        useStreakScaling = true
    }) {
        this.init(accountEquity);
        
        if (!this.canTrade(accountEquity)) {
            return { lotSize: 0, allowed: false, reason: 'Trading halted' };
        }
        
        let riskPct = riskPercent || this._config.baseRiskPercent;
        
        if (useStreakScaling) {
            riskPct *= this._getRiskMultiplier();
        }
        
        const riskAmount = accountEquity * (riskPct / 100);
        const stopDistance = this.calculateStopDistance(atr, slMultiplier, symbol);
        
        if (stopDistance <= 0) {
            return { lotSize: 0, allowed: false, reason: 'Invalid stop distance' };
        }
        
        const pipValue = this.getPipValue(symbol);
        let lotSize = riskAmount / (stopDistance * pipValue);
        lotSize = Math.round(lotSize * 100) / 100;
        
        const minLot = this._config.minLot;
        const maxLot = maxLotOverride || this._config.maxLot;
        
        if (lotSize < minLot) lotSize = minLot;
        if (lotSize > maxLot) lotSize = maxLot;
        
        const drawdown = ((this._session.peakEquity - accountEquity) / this._session.peakEquity) * 100;
        if (drawdown > 3.0) {
            const drawdownFactor = Math.max(0.5, 1 - (drawdown - 3) / 10);
            lotSize = Math.round(lotSize * drawdownFactor * 100) / 100;
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
    calculateForexLotSize({ symbol, accountEquity, stopPips, riskPercent = 0.75, pipValue = 10.0 }) {
        const riskAmount = accountEquity * (riskPercent / 100);
        let lotSize = riskAmount / (stopPips * pipValue);
        lotSize = Math.round(lotSize * 100) / 100;
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
    }
};

export default PositionSizing;