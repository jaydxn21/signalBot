export class Storage {
    static KEYS = {
        TOKEN: 'deriv_token',
        SETTINGS: 'bot_settings'
    };

    static saveSettings(settings) {
        localStorage.setItem(Storage.KEYS.SETTINGS, JSON.stringify(settings));
    }

    static loadSettings() {
        const defaultSettings = { symbol: 'cryBTCUSD', timeframe: '900', strategy: 'h4_kiss' };
        const settings = localStorage.getItem(Storage.KEYS.SETTINGS);
        return settings ? JSON.parse(settings) : defaultSettings;
    }

    static saveToken(token) {
        localStorage.setItem(Storage.KEYS.TOKEN, token);
    }

    static getToken() {
        return localStorage.getItem(Storage.KEYS.TOKEN);
    }

    static clearToken() {
        localStorage.removeItem(Storage.KEYS.TOKEN);
    }
}