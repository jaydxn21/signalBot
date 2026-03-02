import { DerivAPI }         from './js/deriv-api.js';
import { ChartEngine }      from './js/chart-engine.js';
import { StrategyEngine }   from './js/strategy-engine.js';
import { UIManager }        from './js/ui-manager.js';
import { Indicators }       from './js/indicators.js';
import { Storage }          from './js/storage.js';
import { OverlayManager }   from './js/overlays.js';
import { MomentumStrategy } from './js/strategies/momentum.js';
import { DataLogger }       from './js/data-logger.js';

let api, chart, strategy;
let candles = [], h4Candles = [], orbHTFCandles = [];
let rsiState = { prevAvgGain: 0, prevAvgLoss: 0, initialized: false };
let isRunning = false;
let lastFiredSignalTime = 0; // now tracks Date.now() ms, not candle time
let symbolMap  = {};
let openSignal = null;

const SYMBOL_MAP = {
    'R_100':      'Volatility 100 Index',
    'R_75':       'Volatility 75 Index',
    'R_50':       'Volatility 50 Index',
    'R_25':       'Volatility 25 Index',
    'R_10':       'Volatility 10 Index',
    '1HZ100V':    'Volatility 100 (1s) Index',
    '1HZ75V':     'Volatility 75 (1s) Index',
    '1HZ50V':     'Volatility 50 (1s) Index',
    '1HZ25V':     'Volatility 25 (1s) Index',
    '1HZ10V':     'Volatility 10 (1s) Index',
    'cryBTCUSD':  'BTCUSD',
    'cryETHUSD':  'ETHUSD',
    'cryLTCUSD':  'LTCUSD',
    'cryXRPUSD':  'XRPUSD',
    'frxXAUUSD':  'XAUUSD',
    'frxXAGUSD':  'XAGUSD',
    'frxEURUSD':  'EURUSD',
    'frxGBPUSD':  'GBPUSD',
    'frxUSDJPY':  'USDJPY',
    'frxAUDUSD':  'AUDUSD',
    'frxUSDCAD':  'USDCAD',
    'frxUSDCHF':  'USDCHF',
    'frxEURGBP':  'EURGBP',
    'frxGBPJPY':  'GBPJPY',
    'JD10':       'Jump 10 Index',
    'JD25':       'Jump 25 Index',
    'JD50':       'Jump 50 Index',
    'JD75':       'Jump 75 Index',
    'JD100':      'Jump 100 Index',
};

function logout() {
    if (api && api.socket) api.socket.close();
    Storage.clearToken();
    isRunning = false;
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('api-token').value = '';
    UIManager.setConnectionStatus(false);
    UIManager.log("Disconnected. Please log in again.", "text-amber-400");
}

async function init() {
    strategy = new StrategyEngine();
    chart    = new ChartEngine('chart');
    api      = new DerivAPI(96293, (data) => handleData(data));

    const savedToken = Storage.getToken();
    if (savedToken) {
        document.getElementById('auth-overlay').style.display = 'none';
        api.connect(savedToken);
    }

    document.getElementById('btn-login').onclick = () => {
        const token = document.getElementById('api-token').value;
        if (!token) return alert("Token Required");
        Storage.saveToken(token);
        document.getElementById('auth-overlay').style.display = 'none';
        api.connect(token);
    };

    const settings = Storage.loadSettings();

    const savedCategory = settings.category || 'volatility';
    const catBtn = document.querySelector(`[data-cat="${savedCategory}"]`);
    if (catBtn) setCategory(catBtn);
    populateSymbols(savedCategory, settings.symbol);

    document.getElementById('timeframe').value = settings.timeframe || '300';
    document.getElementById('strategy').value  = settings.strategy  || 'momentum';

    if (settings.strategy === 'orb') {
        document.getElementById('orb-htf-row').classList.remove('hidden');
        document.getElementById('timeframe').value = '60';
    }

    document.getElementById('btn-start').onclick = startMonitoring;
    document.getElementById('btn-logout').onclick = logout;

    ['show-asian','show-pdhpdl','show-fvg','show-major','show-h4','show-orb'].forEach(id => {
        document.getElementById(id).addEventListener('change', redrawOverlays);
    });
}

function startMonitoring() {
    if (isRunning) return location.reload();

    isRunning = true;
    UIManager.startSession();

    const btn = document.getElementById('btn-start');
    btn.innerText = "STOP BOT";
    btn.classList.add('bg-red-900', 'animate-pulse');

    const catBtn = document.querySelector('.cat-btn.active-cat');

    const settings = {
        symbol:    document.getElementById('symbol').value,
        timeframe: document.getElementById('timeframe').value,
        strategy:  document.getElementById('strategy').value,
        orbHTF:    document.getElementById('orb-htf').value,
        category:  catBtn ? catBtn.dataset.cat : 'volatility'
    };
    Storage.saveSettings(settings);

    if (api.socket && api.socket.readyState === WebSocket.OPEN) {
        api.subscribe(settings.symbol, settings.timeframe);
        api.subscribe(settings.symbol, 14400);

        if (settings.strategy === 'orb') {
            api.subscribe(settings.symbol, settings.orbHTF);
            UIManager.log(`ORB: M1 chart | ${settings.orbHTF == 300 ? 'M5' : 'M15'} analysis`, "text-amber-400");
        }

        if (settings.strategy === 'momentum') {
            const isForex = settings.symbol.startsWith('frx');
            UIManager.log(
                isForex
                    ? "Momentum Scalper — Forex/Gold mode (session 08:00-17:00 UTC)"
                    : "Momentum Scalper active — H4 trend filter enabled.",
                "text-amber-400"
            );
        }
    } else {
        UIManager.log("Waiting for authorization...", "text-amber-400");
    }

    UIManager.log(`Monitoring ${settings.symbol}...`, "text-emerald-400");
}

function handleData(data) {
    if (data.error) {
        UIManager.log(`API Error: ${data.error.message}`, 'text-red-400');
        console.error("Deriv API Error:", data.error);
        return;
    }

    if (data.msg_type === 'authorize') {
        UIManager.setConnectionStatus(true);
        UIManager.log("Terminal Online", "text-cyan-400");
        api.fetchActiveSymbols();
        if (isRunning) startMonitoring();
    }

    if (data.msg_type === 'active_symbols') {
        data.active_symbols.forEach(s => { symbolMap[s.symbol] = s.display_name; });
        UIManager.log(`Symbols loaded (${data.active_symbols.length}).`, "text-slate-400");
    }

    if (data.msg_type === 'candles') {
        const gran    = data.echo_req.granularity;
        const history = data.candles.map(c => ({
            time:  parseInt(c.epoch),
            open:  parseFloat(c.open),
            high:  parseFloat(c.high),
            low:   parseFloat(c.low),
            close: parseFloat(c.close)
        }));

        if (gran === 14400) {
            h4Candles = history;
            UIManager.log("H4 Levels Updated.");
        } else if (
            gran === parseInt(document.getElementById('orb-htf').value) &&
            document.getElementById('strategy').value === 'orb' &&
            gran !== parseInt(document.getElementById('timeframe').value)
        ) {
            orbHTFCandles = history;
            UIManager.log(`ORB HTF (${gran === 300 ? 'M5' : 'M15'}) loaded.`, "text-amber-400");
        } else {
            candles = history;
            chart.setData(candles);
        }
        redrawOverlays();
    }

    if (data.msg_type === 'ohlc') {
        const gran = data.echo_req.granularity;
        const bar  = {
            time:  parseInt(data.ohlc.open_time),
            open:  parseFloat(data.ohlc.open),
            high:  parseFloat(data.ohlc.high),
            low:   parseFloat(data.ohlc.low),
            close: parseFloat(data.ohlc.close)
        };

        updateLocalData(bar, gran);

        if (isRunning) {
            const rsi = Indicators.calculateRSI(candles, rsiState);
            const atr = Indicators.calculateATR(candles);

            const isTrending = candles.length >= 20
                ? MomentumStrategy._isTrending(candles, atr)
                : null;
            const marketCondition = isTrending === null ? '—'
                : isTrending ? 'TRENDING' : 'RANGING';

            UIManager.updateHUD(rsi, atr, marketCondition);
            checkSignalOutcome(bar);

            const currentStrategyType = document.getElementById('strategy').value;
            const currentSymbol       = document.getElementById('symbol').value;
            const analysisCandles     = currentStrategyType === 'orb' && orbHTFCandles.length > 0
                ? orbHTFCandles : candles;

            const signal = strategy.analyze(
                currentStrategyType,
                analysisCandles,
                h4Candles,
                rsiState,
                atr,
                currentSymbol
            );

            // ── Duplicate signal guard ──────────────────────────────────────
            // Uses Date.now() ms — blocks any second signal within 10 seconds
            // Prevents same-candle duplicates that caused BUY+SELL at 11:45
            const now = Date.now();
            if (signal && (now - lastFiredSignalTime) > 10000) {
                lastFiredSignalTime = now;
                fireSignal(signal.type || signal, bar, signal.label, atr, rsi, isTrending);
            }
        }
    }
}

function checkSignalOutcome(bar) {
    if (!openSignal) return;

    const closed = candles[candles.length - 2];
    if (!closed || closed.time === openSignal.lastCheckedTime) return;
    openSignal.lastCheckedTime = closed.time;

    const { type, sl, tp, entry } = openSignal;

    if (type === 'BUY') {
        if (closed.low <= sl) {
            UIManager.log("Signal hit SL — cooldown active (5 candles)", "text-red-400");
            UIManager.registerLoss(Math.abs(entry - sl));
            UIManager.addTradeHistory(type, entry, sl, tp, 'SL');
            DataLogger.logOutcome('SL', entry, sl, tp, closed.time);
            MomentumStrategy.registerLoss();
            chart.clearMarkers();
            chart.clearPriceLines();
            openSignal = null;
        } else if (closed.high >= tp) {
            UIManager.log("Signal hit TP ✓", "text-emerald-400");
            UIManager.registerWin(Math.abs(tp - entry));
            UIManager.addTradeHistory(type, entry, sl, tp, 'TP');
            DataLogger.logOutcome('TP', entry, sl, tp, closed.time);
            chart.clearMarkers();
            chart.clearPriceLines();
            openSignal = null;
        }
    }

    if (type === 'SELL') {
        if (closed.high >= sl) {
            UIManager.log("Signal hit SL — cooldown active (5 candles)", "text-red-400");
            UIManager.registerLoss(Math.abs(entry - sl));
            UIManager.addTradeHistory(type, entry, sl, tp, 'SL');
            DataLogger.logOutcome('SL', entry, sl, tp, closed.time);
            MomentumStrategy.registerLoss();
            chart.clearMarkers();
            chart.clearPriceLines();
            openSignal = null;
        } else if (closed.low <= tp) {
            UIManager.log("Signal hit TP ✓", "text-emerald-400");
            UIManager.registerWin(Math.abs(entry - tp));
            UIManager.addTradeHistory(type, entry, sl, tp, 'TP');
            DataLogger.logOutcome('TP', entry, sl, tp, closed.time);
            chart.clearMarkers();
            chart.clearPriceLines();
            openSignal = null;
        }
    }
}

function updateLocalData(bar, gran) {
    if (gran === 14400) {
        h4Candles.push(bar);
        if (h4Candles.length > 50) h4Candles.shift();
    } else if (
        gran === parseInt(document.getElementById('orb-htf').value) &&
        document.getElementById('strategy').value === 'orb' &&
        gran !== parseInt(document.getElementById('timeframe').value)
    ) {
        const last = orbHTFCandles[orbHTFCandles.length - 1];
        if (last && last.time === bar.time) orbHTFCandles[orbHTFCandles.length - 1] = bar;
        else orbHTFCandles.push(bar);
        if (orbHTFCandles.length > 500) orbHTFCandles.shift();
    } else {
        const last = candles[candles.length - 1];
        if (last && last.time === bar.time) candles[candles.length - 1] = bar;
        else candles.push(bar);
        if (candles.length > 1000) candles.shift();
        chart.update(bar);
    }
}

async function fireSignal(type, bar, label, atr, rsi, isTrending) {
    UIManager.log(
        `SIGNAL: ${type} @ ${bar.close} (${label})`,
        type === 'BUY' ? 'text-emerald-400' : 'text-red-400'
    );

    chart.addMarker(bar.time, type, label);

    if (atr) {
        const sl = type === 'BUY' ? bar.close - atr         : bar.close + atr;
        const tp = type === 'BUY' ? bar.close + (atr * 1.5) : bar.close - (atr * 1.5);
        chart.drawTradeLevels(sl, tp);

        openSignal = { type, sl, tp, entry: bar.close };

        const symbol    = document.getElementById('symbol').value;
        const timeframe = document.getElementById('timeframe').value;
        const ema8      = MomentumStrategy._ema(candles.slice(0, -1), 8);
        const ema21     = MomentumStrategy._ema(candles.slice(0, -1), 21);
        const isVol     = MomentumStrategy._isVolatileEnough(candles, atr);
        const c1        = candles[candles.length - 4];
        const c2        = candles[candles.length - 3];
        const c3        = candles[candles.length - 2];
        const { bullEngulf, bearEngulf } = MomentumStrategy._isEngulfing(c2, c3);
        const { allBull, allBear }       = MomentumStrategy._isThreeConsecutive(c1, c2, c3);
        const bigBull   = c3.close > c3.open && MomentumStrategy._isBigBody(c3, atr);
        const bigBear   = c3.close < c3.open && MomentumStrategy._isBigBody(c3, atr);
        const bullScore = (bullEngulf ? 1 : 0) + (allBull ? 1 : 0) + (bigBull ? 1 : 0);
        const bearScore = (bearEngulf ? 1 : 0) + (allBear ? 1 : 0) + (bigBear ? 1 : 0);

        DataLogger.logSignal(
            type, bar, atr, rsi, ema8, ema21,
            isTrending, isVol, bullScore, bearScore,
            symbol, timeframe
        );

        const mt5Symbol = symbolMap[symbol] || SYMBOL_MAP[symbol] || symbol;

        try {
            const res  = await fetch('/api/signal', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    action:    type.toLowerCase(),
                    symbol:    mt5Symbol,
                    price:     bar.close,
                    sl:        parseFloat(sl.toFixed(5)),
                    tp:        parseFloat(tp.toFixed(5)),
                    label,
                    timestamp: bar.time * 1000
                })
            });
            const json = await res.json();
            if (json.status !== 'ok') console.warn('Signal post skipped:', json);
        } catch(e) {
            UIManager.log("Failed to post signal to server.", "text-red-400");
        }
    }
}

function redrawOverlays() {
    const series = chart.getCandleSeries();
    OverlayManager.clearAll(series);
    if (document.getElementById('show-asian').checked)  OverlayManager.drawAsianRange(series, candles);
    if (document.getElementById('show-pdhpdl').checked) OverlayManager.drawPDHPDL(series, h4Candles);
    if (document.getElementById('show-fvg').checked)    OverlayManager.drawFVG(series, candles);
    if (document.getElementById('show-h4').checked)     OverlayManager.drawH4Kiss(series, h4Candles);
    if (document.getElementById('show-major').checked)  OverlayManager.drawMajorSR(series, candles);
    if (document.getElementById('show-orb').checked)    OverlayManager.drawORBRange(series, candles);
    if (document.getElementById('show-ob').checked)     OverlayManager.drawOrderBlocks(series, candles);
    if (document.getElementById('show-bos').checked)    OverlayManager.drawBreakOfStructure(series, candles);
}

document.addEventListener('DOMContentLoaded', init);