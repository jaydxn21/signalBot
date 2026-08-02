import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

function loadDotEnv(dotEnvPath) {
    if (!fs.existsSync(dotEnvPath)) return;
    const raw = fs.readFileSync(dotEnvPath, 'utf8');
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

loadDotEnv(ENV_PATH);

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

export const config = {
    deriv: {
        appId: required('APP_ID'),
        token: required('TOKEN'),
        accountId: process.env.ACCOUNT_ID || null,
    },
    engine: {
        wsPort: Number(process.env.ENGINE_WS_PORT || 4000),
        wsSecret: process.env.ENGINE_WS_SECRET || '',
        storeFile: process.env.ENGINE_STORE_FILE || path.join(REPO_ROOT, 'data', 'engine-store.json'),
    },
    mt5: {
        bridgeUrl: process.env.MT5_BRIDGE_URL || 'ws://127.0.0.1:3000',
        enabled: process.env.MT5_ENABLED !== '0',
    },
};

