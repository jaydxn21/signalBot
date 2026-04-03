// structure-engine.js — Universal Structure Logic

export const StructureEngine = {
    
    getDailyLevels(dailyCandles) {
        if (!dailyCandles || dailyCandles.length < 2) return null;
        const yesterday = dailyCandles[dailyCandles.length - 2];
        return {
            dailyHigh: yesterday.high,
            dailyLow: yesterday.low,
            dailyOpen: yesterday.open,
            dailyClose: yesterday.close,
            dailyRange: yesterday.high - yesterday.low,
            dailyMid: (yesterday.high + yesterday.low) / 2,
        };
    },
    
    getWeeklyLevels(weeklyCandles) {
        if (!weeklyCandles || weeklyCandles.length < 2) return null;
        const lastWeek = weeklyCandles[weeklyCandles.length - 2];
        return {
            weeklyHigh: lastWeek.high,
            weeklyLow: lastWeek.low,
            weeklyRange: lastWeek.high - lastWeek.low,
            weeklyMid: (lastWeek.high + lastWeek.low) / 2,
        };
    },
    
    findDemandZones(candles, lookback = 100, minStrength = 1) {
        return []; // Simplified for now
    },
    
    findSupplyZones(candles, lookback = 100, minStrength = 1) {
        return []; // Simplified for now
    },
    
    getPricePosition(price, dailyLevels, weeklyLevels = null, demandZones = [], supplyZones = []) {
        if (!dailyLevels) return 'MID_RANGE';
        
        const atDailySupport = Math.abs(price - dailyLevels.dailyLow) / dailyLevels.dailyRange < 0.03;
        const atDailyResistance = Math.abs(price - dailyLevels.dailyHigh) / dailyLevels.dailyRange < 0.03;
        
        if (atDailySupport) return 'SUPPORT';
        if (atDailyResistance) return 'RESISTANCE';
        
        const nearMid = Math.abs(price - dailyLevels.dailyMid) / dailyLevels.dailyRange < 0.1;
        if (nearMid) return 'MID_RANGE';
        
        if (price > dailyLevels.dailyHigh * 1.002) return 'BREAKOUT_UP';
        if (price < dailyLevels.dailyLow * 0.998) return 'BREAKOUT_DOWN';
        
        return 'RANGING';
    },
    
    getStructureScore(price, bias, dailyLevels, weeklyLevels, demandZones, supplyZones) {
        let score = 50;
        const position = this.getPricePosition(price, dailyLevels, weeklyLevels, demandZones, supplyZones);
        
        if (bias === 'BUY') {
            if (position === 'SUPPORT') score += 25;
            else if (position === 'MID_RANGE') score += 10;
            else if (position === 'RESISTANCE') score -= 15;
            else if (position === 'BREAKOUT_UP') score += 10;
        } else if (bias === 'SELL') {
            if (position === 'RESISTANCE') score += 25;
            else if (position === 'MID_RANGE') score += 10;
            else if (position === 'SUPPORT') score -= 15;
            else if (position === 'BREAKOUT_DOWN') score += 10;
        }
        
        return Math.min(100, Math.max(0, score));
    },
    
    getDistanceToNearestLevel(price, dailyLevels, demandZones, supplyZones) {
        return { distance: 999, type: null };
    },
    
    getStructureMap(candles, dailyCandles, weeklyCandles = null) {
        const dailyLevels = this.getDailyLevels(dailyCandles);
        const weeklyLevels = weeklyCandles ? this.getWeeklyLevels(weeklyCandles) : null;
        const demandZones = this.findDemandZones(candles, 100);
        const supplyZones = this.findSupplyZones(candles, 100);
        
        return {
            dailyLevels,
            weeklyLevels,
            demandZones,
            supplyZones,
            getPricePosition: (price) => this.getPricePosition(price, dailyLevels, weeklyLevels, demandZones, supplyZones),
            getStructureScore: (price, bias) => this.getStructureScore(price, bias, dailyLevels, weeklyLevels, demandZones, supplyZones),
            getDistanceToNearestLevel: (price) => this.getDistanceToNearestLevel(price, dailyLevels, demandZones, supplyZones),
        };
    },
};

export default StructureEngine;