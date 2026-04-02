// structure-simple.js — Pure structure trading
// Entry: Price touches daily low + demand zone
// Exit: Price reaches daily mid or supply zone
// SL: 0.5% below demand zone
// TP: At daily mid (1:2 R:R typical)

export function simpleStructureEntry(candles, dailyCandles, atr) {
    const structure = StructureEngine.getStructureMap(candles, dailyCandles);
    const price = candles[candles.length - 1].close;
    const position = structure.getPricePosition(price);
    
    // BUY at support
    if (position === 'SUPPORT' && structure.demandZones.length > 0) {
        const nearestDemand = structure.demandZones[0];
        const stopLoss = nearestDemand.low * 0.995;
        const takeProfit = structure.dailyLevels.dailyMid;
        
        if (takeProfit > price && (price - stopLoss) > 0) {
            const risk = price - stopLoss;
            const reward = takeProfit - price;
            const rr = reward / risk;
            
            if (rr >= 1.5) {
                return { type: 'BUY', sl: stopLoss, tp: takeProfit, rr };
            }
        }
    }
    
    // SELL at resistance
    if (position === 'RESISTANCE' && structure.supplyZones.length > 0) {
        const nearestSupply = structure.supplyZones[0];
        const stopLoss = nearestSupply.high * 1.005;
        const takeProfit = structure.dailyLevels.dailyMid;
        
        if (takeProfit < price && (stopLoss - price) > 0) {
            const risk = stopLoss - price;
            const reward = price - takeProfit;
            const rr = reward / risk;
            
            if (rr >= 1.5) {
                return { type: 'SELL', sl: stopLoss, tp: takeProfit, rr };
            }
        }
    }
    
    return null;
}