// js/backtest-core.js
// Shared utilities: candle fetching, simulation engine, indicators.
// Used by both backtest.js and strategy-builder.js

const WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
export { WS_URL };

const CHUNK_SIZE  = 1500;  // safe limit per request
const CHUNK_DELAY = 800;   // ms between chunks

async function _fetchCandles(symbol, granularity, count, onProgress) {
    if (count <= CHUNK_SIZE) {
        return _fetchChunk(symbol, granularity, count, 'latest');
    }

    // Split into chunks — fetch oldest first, walk backwards
    const chunks   = [];
    let   remaining = count;
    let   endTime   = 'latest';

    while (remaining > 0) {
        const chunkSize = Math.min(remaining, CHUNK_SIZE);
        const batch     = await _fetchChunk(symbol, granularity, chunkSize, endTime);
        if (!batch.length) break;

        chunks.unshift(batch);              // prepend — oldest data first
        remaining -= batch.length;
        endTime    = batch[0].time - 1;     // next chunk ends just before this one starts

        if (onProgress) onProgress(count - remaining, count);
        if (remaining > 0) await _sleep(CHUNK_DELAY);
    }

    // Merge, deduplicate, and sort by time
    const merged = chunks.flat();
    const seen   = new Set();
    return merged
        .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
        .sort((a, b) => a.time - b.time);
}

function _fetchChunk(symbol, granularity, count, end) {
    return new Promise((resolve, reject) => {
        const ws  = new WebSocket(WS_URL);
        let   resolved = false;

        const payload = {
            ticks_history:     symbol,
            granularity:       granularity,
            count:             count,
            style:             'candles',
            adjust_start_time: 1,
        };
        // 'latest' means no end param — use epoch number for historical chunks
        if (end !== 'latest') payload.end = end;
        else payload.end = 'latest';

        ws.onopen = () => ws.send(JSON.stringify(payload));

        ws.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            if (msg.error) {
                reject(new Error(msg.error.message));
                ws.close();
                return;
            }
            if (msg.candles) {
                resolved = true;
                ws.close();
                resolve(msg.candles.map(c => ({
                    time:  c.epoch,
                    open:  parseFloat(c.open),
                    high:  parseFloat(c.high),
                    low:   parseFloat(c.low),
                    close: parseFloat(c.close),
                })));
            }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        ws.onclose = () => { if (!resolved) reject(new Error('Connection closed')); };
        setTimeout(() => { if (!resolved) { ws.close(); reject(new Error('Request timeout')); } }, 25000);
    });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _calcATR(candles, period=14) {
    if (candles.length < period+1) return null;
    const trs = candles.slice(1).map((c,i) => Math.max(
        c.high-c.low,
        Math.abs(c.high-candles[i].close),
        Math.abs(c.low -candles[i].close)
    ));
    return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function _calcRSI(candles, state, period=14) {
    if (candles.length < 2) return 50;
    const last  = candles[candles.length-1];
    const prev  = candles[candles.length-2];
    const delta = last.close - prev.close;
    const gain  = delta > 0 ? delta : 0;
    const loss  = delta < 0 ? -delta : 0;
    if (!state.initialized) {
        state.prevAvgGain = gain;
        state.prevAvgLoss = loss;
        state.initialized = true;
    }
    const k = 1/period;
    state.prevAvgGain = state.prevAvgGain*(1-k) + gain*k;
    state.prevAvgLoss = state.prevAvgLoss*(1-k) + loss*k;
    if (state.prevAvgLoss === 0) return 100;
    const rs = state.prevAvgGain / state.prevAvgLoss;
    return 100 - 100/(1+rs);
}

function _tfLabel(tf) {
    return { 60:'M1',300:'M5',900:'M15',1800:'M30',3600:'H1',14400:'H4' }[tf] || tf;
}


function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// SIMULATION ENGINE
// Runs a strategy bar-by-bar over historical candles.
// strategyOrId: a StrategyEngine instance, a custom object with
//   .analyze(), or null (no signal — used for walk-forward split)
// ─────────────────────────────────────────────────────────────
export function _simulate(candles, h4Candles, strategyOrId, stake = 10, commission = 0) {
    const isCustom   = strategyOrId && typeof strategyOrId === 'object' && typeof strategyOrId.analyze === 'function';
    const rsiState   = { prevAvgGain:0, prevAvgLoss:0, initialized:false };
    const trades     = [];
    const equity     = [0];
    let   openTrade  = null;
    let   running    = 0;
    let   lastFired  = 0;
    const WARMUP     = 50;

    for (let i = WARMUP; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const bar   = slice[slice.length - 1];

        // Check open trade outcome first
        if (openTrade) {
            const { type, entry, sl, tp, stakeAmt, commAmt } = openTrade;
            let closed = false;
            if (type === 'BUY') {
                if (bar.low  <= sl) { const pnl = -(Math.abs(entry-sl)*stakeAmt)-commAmt; running+=pnl; _closeTrade(trades,'SL',bar.close,pnl); equity.push(running); openTrade=null; closed=true; }
                else if (bar.high >= tp) { const pnl = (Math.abs(entry-tp)*stakeAmt)-commAmt; running+=pnl; _closeTrade(trades,'TP',bar.close,pnl); equity.push(running); openTrade=null; closed=true; }
            } else {
                if (bar.high >= sl) { const pnl = -(Math.abs(entry-sl)*stakeAmt)-commAmt; running+=pnl; _closeTrade(trades,'SL',bar.close,pnl); equity.push(running); openTrade=null; closed=true; }
                else if (bar.low  <= tp) { const pnl = (Math.abs(entry-tp)*stakeAmt)-commAmt; running+=pnl; _closeTrade(trades,'TP',bar.close,pnl); equity.push(running); openTrade=null; closed=true; }
            }
            if (closed) continue;
            equity.push(running);
            continue;
        }

        if (i - lastFired < 2) { equity.push(running); continue; }
        if (!strategyOrId)     { equity.push(running); continue; }

        const h4Slice = h4Candles.filter(c => c.time <= bar.time);
        const atr     = _calcATR(slice, 14);
        const rsi     = _calcRSI(slice, rsiState);

        let signal = null;
        try {
            signal = isCustom
                ? strategyOrId.analyze('__custom__', slice, h4Slice, rsiState, atr, '', rsi)
                : null; // named strategy IDs need StrategyEngine on server side
        } catch(e) { /* strategy error — skip bar */ }

        if (!signal) { equity.push(running); continue; }

        const type   = signal.type || signal;
        const slMult = signal.slMultiplier || 1.5;
        const tpMult = signal.tpMultiplier || 2.0;
        const slDist = atr ? atr * slMult : Math.abs(bar.close * 0.002);
        const tpDist = slDist * tpMult;
        const sl     = type === 'BUY' ? bar.close - slDist : bar.close + slDist;
        const tp     = type === 'BUY' ? bar.close + tpDist : bar.close - tpDist;

        openTrade = { type, entry: bar.close, sl, tp, stakeAmt: stake, commAmt: commission };
        lastFired = i;
        trades.push({ time: bar.time, barIdx: i, type, entry: bar.close, sl, tp, outcome: null, exit: null, pnl: null });
        equity.push(running);
    }

    // Force-close open trade at last price
    if (openTrade && candles.length > 0) {
        const last = candles[candles.length - 1];
        const pnl  = openTrade.type === 'BUY'
            ? (last.close - openTrade.entry) * openTrade.stakeAmt - openTrade.commAmt
            : (openTrade.entry - last.close) * openTrade.stakeAmt - openTrade.commAmt;
        running += pnl;
        if (trades.length) { trades[trades.length-1].outcome='OPEN'; trades[trades.length-1].exit=last.close; trades[trades.length-1].pnl=pnl; }
        equity.push(running);
    }

    return { trades, equity };
}

function _closeTrade(trades, outcome, exit, pnl) {
    if (trades.length) { trades[trades.length-1].outcome=outcome; trades[trades.length-1].exit=exit; trades[trades.length-1].pnl=pnl; }
}

export { CHUNK_SIZE, CHUNK_DELAY, _fetchCandles, _fetchChunk, _calcATR, _calcRSI, _tfLabel, _sleep };

// ─────────────────────────────────────────────────────────────
// BUILT-IN STRATEGIES
// Standalone versions for browser backtest without strategy-engine.js
// Mirror the logic from the server-side strategy files.
// ─────────────────────────────────────────────────────────────
export function _getBuiltinStrategy(id) {
    const strats = {

        trend: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 50) return null;
            const bar  = c[c.length-1], prev = c[c.length-2];
            const ema  = (arr, p) => { let e=arr.slice(0,p).reduce((s,x)=>s+x.close,0)/p; const k=2/(p+1); for(let i=p;i<arr.length;i++) e=arr[i].close*k+e*(1-k); return e; };
            const e20  = ema(c,20), e50 = ema(c,50);
            const rsi  = _calcRSI(c, rsiState);
            if (bar.close>e50 && e20>e50 && rsi<48 && rsi>30) return { type:'BUY',  tpMultiplier:2.0, slMultiplier:1.0 };
            if (bar.close<e50 && e20<e50 && rsi>52 && rsi<70) return { type:'SELL', tpMultiplier:2.0, slMultiplier:1.0 };
            return null;
        },

        vwap_reversion: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 50) return null;
            const bar = c[c.length-1];
            const rsi = _calcRSI(c, rsiState);
            let tv=0,tpv=0; c.forEach(x=>{const v=1;tv+=v;tpv+=((x.high+x.low+x.close)/3)*v;});
            const vwap = tpv/tv;
            const body = atr ? Math.abs(bar.close-bar.open)/atr : 0;
            if (bar.close<vwap && rsi<40 && body>0.3) return { type:'BUY',  tpMultiplier:1.8, slMultiplier:1.2 };
            if (bar.close>vwap && rsi>60 && body>0.3) return { type:'SELL', tpMultiplier:1.8, slMultiplier:1.2 };
            return null;
        },

        h4_kiss: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 21 || !h4 || h4.length < 21) return null;
            const bar = c[c.length-1];
            const ema = (arr, p) => { let e=arr.slice(0,p).reduce((s,x)=>s+x.close,0)/p; const k=2/(p+1); for(let i=p;i<arr.length;i++) e=arr[i].close*k+e*(1-k); return e; };
            const h4e = ema(h4,21), e50 = ema(c,50);
            const rsi = _calcRSI(c, rsiState);
            if (!h4e || !e50) return null;
            const near = atr ? Math.abs(bar.close-h4e) < atr*0.8 : false;
            if (near && bar.close>h4e && h4e>e50 && rsi>40 && rsi<60) return { type:'BUY',  tpMultiplier:2.5, slMultiplier:1.0 };
            if (near && bar.close<h4e && h4e<e50 && rsi>40 && rsi<60) return { type:'SELL', tpMultiplier:2.5, slMultiplier:1.0 };
            return null;
        },

        range_boundary: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 20) return null;
            const bar = c[c.length-1];
            const rsi = _calcRSI(c, rsiState);
            const sl  = c.slice(-20).map(x=>x.close); const mid=sl.reduce((a,b)=>a+b,0)/20;
            const std = Math.sqrt(sl.reduce((s,v)=>s+(v-mid)**2,0)/20);
            const bbU = mid+2*std, bbL = mid-2*std;
            if (bar.close > bbL && rsi < 35) return { type:'BUY',  tpMultiplier:2.0, slMultiplier:1.5 };
            if (bar.close < bbU && rsi > 65) return { type:'SELL', tpMultiplier:2.0, slMultiplier:1.5 };
            return null;
        },

        synthetic_scalp: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 20) return null;
            const bar = c[c.length-1];
            const rsi = _calcRSI(c, rsiState);
            const sl  = c.slice(-20).map(x=>x.close); const mid=sl.reduce((a,b)=>a+b,0)/20;
            const std = Math.sqrt(sl.reduce((s,v)=>s+(v-mid)**2,0)/20);
            const bbU = mid+2*std, bbL = mid-2*std;
            if (rsi < 30 && bar.close > bbL) return { type:'BUY',  tpMultiplier:1.5, slMultiplier:1.2 };
            if (rsi > 70 && bar.close < bbU) return { type:'SELL', tpMultiplier:1.5, slMultiplier:1.2 };
            return null;
        },

        ultra_scalp: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 5) return null;
            const bar = c[c.length-1], prev = c[c.length-2];
            if (bar.close > prev.high) return { type:'BUY',  tpMultiplier:1.2, slMultiplier:0.8 };
            if (bar.close < prev.low)  return { type:'SELL', tpMultiplier:1.2, slMultiplier:0.8 };
            return null;
        },

        momentum: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 50) return null;
            const bar = c[c.length-1], prev = c[c.length-2];
            const ema = (arr, p) => { let e=arr.slice(0,p).reduce((s,x)=>s+x.close,0)/p; const k=2/(p+1); for(let i=p;i<arr.length;i++) e=arr[i].close*k+e*(1-k); return e; };
            const e8p  = ema(c.slice(0,-1),8),  e20p = ema(c.slice(0,-1),20);
            const e8   = ema(c,8),               e20  = ema(c,20), e50 = ema(c,50);
            const rsi  = _calcRSI(c, rsiState);
            if (e8p<=e20p && e8>e20 && rsi>50 && bar.close>e50) return { type:'BUY',  tpMultiplier:2.0, slMultiplier:1.5 };
            if (e8p>=e20p && e8<e20 && rsi<50 && bar.close<e50) return { type:'SELL', tpMultiplier:2.0, slMultiplier:1.5 };
            return null;
        },

        rsi_fade: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 14) return null;
            const rsi = _calcRSI(c, rsiState);
            if (rsi < 25) return { type:'BUY',  tpMultiplier:1.8, slMultiplier:1.2 };
            if (rsi > 75) return { type:'SELL', tpMultiplier:1.8, slMultiplier:1.2 };
            return null;
        },

        swing: (candles, h4, rsiState, atr) => {
            const c = candles; if (c.length < 50) return null;
            const bar = c[c.length-1];
            const ema = (arr, p) => { let e=arr.slice(0,p).reduce((s,x)=>s+x.close,0)/p; const k=2/(p+1); for(let i=p;i<arr.length;i++) e=arr[i].close*k+e*(1-k); return e; };
            const e50  = ema(c,50), e200 = ema(c,200);
            const rsi  = _calcRSI(c, rsiState);
            if (!e200) return null;
            if (bar.close>e200 && e50>e200 && rsi<45 && rsi>30) return { type:'BUY',  tpMultiplier:3.0, slMultiplier:1.5 };
            if (bar.close<e200 && e50<e200 && rsi>55 && rsi<70) return { type:'SELL', tpMultiplier:3.0, slMultiplier:1.5 };
            return null;
        },
    };

    const fn = strats[id];
    if (!fn) return null;

    return {
        analyze(stratId, candles, h4Candles, rsiState, atr) {
            return fn(candles, h4Candles, rsiState, atr);
        }
    };
}