// structure-engine.js — Universal Structure Logic
//
// PURPOSE: Provide structural context for ALL strategies
//   - Demand zones (support)
//   - Supply zones (resistance)
//   - Daily high / low
//   - Weekly high / low
//   - Order blocks
//   - Fair value gaps

export const StructureEngine = {
    
    // ─────────────────────────────────────────────────────────────
    // DAILY LEVELS
    // ─────────────────────────────────────────────────────────────
    getDailyLevels(dailyCandles) {
        if (!dailyCandles || dailyCandles.length < 2) return null;
        
        const yesterday = dailyCandles[dailyCandles.length - 2];
        const today = dailyCandles[dailyCandles.length - 1];
        
        return {
            dailyHigh: yesterday.high,
            dailyLow: yesterday.low,
            dailyOpen: yesterday.open,
            dailyClose: yesterday.close,
            dailyRange: yesterday.high - yesterday.low,
            todayHigh: today?.high || yesterday.high,
            todayLow: today?.low || yesterday.low,
            dailyMid: (yesterday.high + yesterday.low) / 2,
            daily25: yesterday.low + (yesterday.high - yesterday.low) * 0.25,
            daily75: yesterday.low + (yesterday.high - yesterday.low) * 0.75,
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // WEEKLY LEVELS
    // ─────────────────────────────────────────────────────────────
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
    
    // ─────────────────────────────────────────────────────────────
    // DEMAND ZONES (Support)
    // ─────────────────────────────────────────────────────────────
    findDemandZones(candles, lookback = 100, minStrength = 2) {
        if (!candles || candles.length < 20) return [];
        
        const zones = [];
        const slice = candles.slice(-lookback);
        
        for (let i = 10; i < slice.length - 5; i++) {
            const zoneLow = slice[i].low;
            const zoneHigh = slice[i].close;
            
            const isBullish = slice[i].close > slice[i].open;
            const bodySize = Math.abs(slice[i].close - slice[i].open);
            const rangeSize = slice[i].high - slice[i].low;
            const strongBody = bodySize > rangeSize * 0.6;
            
            if (!isBullish || !strongBody) continue;
            
            let touches = 0;
            let breaks = 0;
            
            for (let j = i + 2; j < Math.min(i + 30, slice.length); j++) {
                const candle = slice[j];
                if (candle.low <= zoneHigh && candle.low >= zoneLow - (zoneHigh - zoneLow) * 0.3) {
                    touches++;
                    if (candle.close < zoneLow) breaks++;
                }
            }
            
            if (touches >= minStrength && breaks === 0) {
                zones.push({
                    type: 'DEMAND',
                    low: zoneLow,
                    high: zoneHigh,
                    strength: touches,
                    timestamp: slice[i].time,
                });
            }
        }
        
        return this._mergeZones(zones);
    },
    
    // ─────────────────────────────────────────────────────────────
    // SUPPLY ZONES (Resistance)
    // ─────────────────────────────────────────────────────────────
    findSupplyZones(candles, lookback = 100, minStrength = 2) {
        if (!candles || candles.length < 20) return [];
        
        const zones = [];
        const slice = candles.slice(-lookback);
        
        for (let i = 10; i < slice.length - 5; i++) {
            const zoneLow = slice[i].open;
            const zoneHigh = slice[i].high;
            
            const isBearish = slice[i].close < slice[i].open;
            const bodySize = Math.abs(slice[i].close - slice[i].open);
            const rangeSize = slice[i].high - slice[i].low;
            const strongBody = bodySize > rangeSize * 0.6;
            
            if (!isBearish || !strongBody) continue;
            
            let touches = 0;
            let breaks = 0;
            
            for (let j = i + 2; j < Math.min(i + 30, slice.length); j++) {
                const candle = slice[j];
                if (candle.high >= zoneLow && candle.high <= zoneHigh + (zoneHigh - zoneLow) * 0.3) {
                    touches++;
                    if (candle.close > zoneHigh) breaks++;
                }
            }
            
            if (touches >= minStrength && breaks === 0) {
                zones.push({
                    type: 'SUPPLY',
                    low: zoneLow,
                    high: zoneHigh,
                    strength: touches,
                    timestamp: slice[i].time,
                });
            }
        }
        
        return this._mergeZones(zones);
    },
    
    // ─────────────────────────────────────────────────────────────
    // ORDER BLOCKS
    // ─────────────────────────────────────────────────────────────
    findOrderBlocks(candles, lookback = 100) {
        if (!candles || candles.length < 20) return [];
        
        const blocks = [];
        const slice = candles.slice(-lookback);
        
        for (let i = 5; i < slice.length - 5; i++) {
            const prev = slice[i - 1];
            const curr = slice[i];
            
            if (!prev || !curr) continue;
            
            const isBearishBlock = prev.close < prev.open;
            const isBullishBreak = curr.close > curr.open && curr.close > prev.high;
            const bigMove = Math.abs(curr.close - prev.close) > (prev.high - prev.low) * 1.5;
            
            if (isBearishBlock && isBullishBreak && bigMove) {
                blocks.push({ type: 'BULLISH_OB', low: prev.low, high: prev.high });
            }
            
            const isBullishBlock = prev.close > prev.open;
            const isBearishBreak = curr.close < curr.open && curr.close < prev.low;
            
            if (isBullishBlock && isBearishBreak && bigMove) {
                blocks.push({ type: 'BEARISH_OB', low: prev.low, high: prev.high });
            }
        }
        
        return blocks;
    },
    
    // ─────────────────────────────────────────────────────────────
    // FAIR VALUE GAPS
    // ─────────────────────────────────────────────────────────────
    findFVG(candles, lookback = 100) {
        if (!candles || candles.length < 10) return [];
        
        const fvgs = [];
        const slice = candles.slice(-lookback);
        
        for (let i = 2; i < slice.length - 2; i++) {
            const prev = slice[i - 1];
            const curr = slice[i];
            
            if (!prev || !curr) continue;
            
            if (prev.high < curr.low) {
                fvgs.push({ type: 'BULLISH_FVG', low: prev.high, high: curr.low, filled: false });
            }
            
            if (curr.high < prev.low) {
                fvgs.push({ type: 'BEARISH_FVG', low: curr.high, high: prev.low, filled: false });
            }
        }
        
        return fvgs;
    },
    
    // ─────────────────────────────────────────────────────────────
    // PRICE POSITION RELATIVE TO STRUCTURE
    // ─────────────────────────────────────────────────────────────
    getPricePosition(price, dailyLevels, weeklyLevels = null, demandZones = [], supplyZones = []) {
        if (!dailyLevels) return 'UNKNOWN';
        
        const atDailySupport = Math.abs(price - dailyLevels.dailyLow) / dailyLevels.dailyRange < 0.02;
        const atDailyResistance = Math.abs(price - dailyLevels.dailyHigh) / dailyLevels.dailyRange < 0.02;
        
        let atDemandZone = false;
        for (const zone of demandZones) {
            if (price >= zone.low && price <= zone.high) { atDemandZone = true; break; }
        }
        
        let atSupplyZone = false;
        for (const zone of supplyZones) {
            if (price >= zone.low && price <= zone.high) { atSupplyZone = true; break; }
        }
        
        let atWeeklySupport = false;
        let atWeeklyResistance = false;
        if (weeklyLevels) {
            atWeeklySupport = Math.abs(price - weeklyLevels.weeklyLow) / weeklyLevels.weeklyRange < 0.03;
            atWeeklyResistance = Math.abs(price - weeklyLevels.weeklyHigh) / weeklyLevels.weeklyRange < 0.03;
        }
        
        if (atDailySupport || atDemandZone || atWeeklySupport) return 'SUPPORT';
        if (atDailyResistance || atSupplyZone || atWeeklyResistance) return 'RESISTANCE';
        
        const nearMid = Math.abs(price - dailyLevels.dailyMid) / dailyLevels.dailyRange < 0.05;
        if (nearMid) return 'MID_RANGE';
        
        if (price > dailyLevels.dailyHigh * 1.002) return 'BREAKOUT_UP';
        if (price < dailyLevels.dailyLow * 0.998) return 'BREAKOUT_DOWN';
        
        return 'RANGING';
    },
    
    // ─────────────────────────────────────────────────────────────
    // TRADE QUALITY SCORE
    // ─────────────────────────────────────────────────────────────
    getStructureScore(price, bias, dailyLevels, weeklyLevels, demandZones, supplyZones) {
        let score = 50;
        const position = this.getPricePosition(price, dailyLevels, weeklyLevels, demandZones, supplyZones);
        
        if (bias === 'BUY') {
            if (position === 'SUPPORT') score += 30;
            else if (position === 'MID_RANGE') score += 10;
            else if (position === 'RESISTANCE') score -= 20;
            else if (position === 'BREAKOUT_UP') score += 15;
            else if (position === 'BREAKOUT_DOWN') score -= 30;
        } else if (bias === 'SELL') {
            if (position === 'RESISTANCE') score += 30;
            else if (position === 'MID_RANGE') score += 10;
            else if (position === 'SUPPORT') score -= 20;
            else if (position === 'BREAKOUT_DOWN') score += 15;
            else if (position === 'BREAKOUT_UP') score -= 30;
        }
        
        if (weeklyLevels) {
            if (bias === 'BUY' && price < weeklyLevels.weeklyLow * 1.01) score += 15;
            if (bias === 'SELL' && price > weeklyLevels.weeklyHigh * 0.99) score += 15;
        }
        
        return Math.min(100, Math.max(0, score));
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET DISTANCE TO NEAREST STRUCTURE LEVEL
    // ─────────────────────────────────────────────────────────────
    getDistanceToNearestLevel(price, dailyLevels, demandZones, supplyZones) {
        let nearest = Infinity;
        let nearestType = null;
        
        const levels = [
            { price: dailyLevels?.dailyLow, type: 'DAILY_SUPPORT' },
            { price: dailyLevels?.dailyHigh, type: 'DAILY_RESISTANCE' },
            { price: dailyLevels?.dailyMid, type: 'DAILY_MID' },
        ];
        
        for (const zone of demandZones) {
            levels.push({ price: zone.high, type: 'DEMAND_ZONE' });
        }
        
        for (const zone of supplyZones) {
            levels.push({ price: zone.low, type: 'SUPPLY_ZONE' });
        }
        
        for (const level of levels) {
            if (!level.price) continue;
            const dist = Math.abs(price - level.price);
            if (dist < nearest) {
                nearest = dist;
                nearestType = level.type;
            }
        }
        
        return { distance: nearest, type: nearestType };
    },
    
    // ─────────────────────────────────────────────────────────────
    // GET COMPLETE STRUCTURE MAP
    // ─────────────────────────────────────────────────────────────
    getStructureMap(candles, dailyCandles, weeklyCandles = null) {
        const dailyLevels = this.getDailyLevels(dailyCandles);
        const weeklyLevels = weeklyCandles ? this.getWeeklyLevels(weeklyCandles) : null;
        const demandZones = this.findDemandZones(candles, 200);
        const supplyZones = this.findSupplyZones(candles, 200);
        const orderBlocks = this.findOrderBlocks(candles, 100);
        const fvgs = this.findFVG(candles, 100);
        
        return {
            dailyLevels,
            weeklyLevels,
            demandZones,
            supplyZones,
            orderBlocks,
            fvgs,
            getPricePosition: (price) => this.getPricePosition(price, dailyLevels, weeklyLevels, demandZones, supplyZones),
            getStructureScore: (price, bias) => this.getStructureScore(price, bias, dailyLevels, weeklyLevels, demandZones, supplyZones),
            getDistanceToNearestLevel: (price) => this.getDistanceToNearestLevel(price, dailyLevels, demandZones, supplyZones),
        };
    },
    
    // ─────────────────────────────────────────────────────────────
    // HELPER: Merge overlapping zones
    // ─────────────────────────────────────────────────────────────
    _mergeZones(zones) {
        if (zones.length === 0) return [];
        
        const sorted = [...zones].sort((a, b) => a.low - b.low);
        const merged = [sorted[0]];
        
        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            const curr = sorted[i];
            
            if (curr.low <= last.high) {
                last.high = Math.max(last.high, curr.high);
                last.low = Math.min(last.low, curr.low);
                last.strength += curr.strength;
            } else {
                merged.push(curr);
            }
        }
        
        return merged;
    },
};

export default StructureEngine;