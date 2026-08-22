import { Auth } from './auth.js';
import { UIManager } from './ui-manager.js';
import { API_BASE } from './auth.js';

export const SessionHydrator = {
    async init() {
        if (Auth.isGuest()) return;

        console.log('🔄 Rehydrating session state from backend & cloud...');

        // 1. Hydrate UI Session Stats (wins/losses/timer)
        UIManager.initSession();

        // 2. Hydrate Settings & Deriv API state
        const settings = await Auth.fetchSettings();
        if (settings) {
            this._applySettings(settings);
        }

        // 3. Hydrate Trades into Journal
        const trades = await Auth.fetchTrades();
        if (trades && Array.isArray(trades)) {
            this._populateTradeHistory(trades);
        }

        // 4. Hydrate Chart History
        const activeSymbol = settings?.symbol || 'R_75';
        await this._rehydrateChart(activeSymbol);
    },

    _applySettings(settings) {
        if (settings.derivToken && window.DerivAPI) {
            console.log('🔑 Auto-authenticating Deriv API from saved settings...');
            window.DerivAPI.connect({
                token: settings.derivToken,
                appId: settings.appId || '33XjcwFHStlck2fOZ3IND'
            });
        }
    },

    _populateTradeHistory(trades) {
        const tbody = document.getElementById('trade-history-body');
        if (!tbody) return;

        tbody.innerHTML = ''; // Clear empty state
        
        // Reverse so newest trades stay at the top
        trades.slice().reverse().forEach(trade => {
            UIManager.addTradeHistory(
                trade.type,
                trade.entry,
                trade.sl,
                trade.tp,
                trade.outcome,
                trade.symbol
            );
        });
    },

    async _rehydrateChart(symbol) {
        try {
            const res = await fetch(`${API_BASE}/api/candles/${symbol}`, {
                headers: Auth.headers()
            });
            if (!res.ok) return;

            const data = await res.json();
            if (data.candles && window.chartInstance) {
                window.chartInstance.setData(data.candles);
                console.log(`📈 Chart rehydrated with ${data.candles.length} candles`);
            }
        } catch (err) {
            console.warn('Chart history rehydration skipped or failed:', err);
        }
    }
};