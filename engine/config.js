import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

function loadDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function loadConfig() {
  return {
    rootDir: ROOT_DIR,
    dataDir: path.join(ROOT_DIR, 'data'),
    appId: process.env.appId || '',
    token: process.env.TOKEN || process.env.DERIV_TOKEN || '',
    accountId: process.env.ACCOUNT_ID || '',
    engineHost: process.env.ENGINE_HOST || '0.0.0.0',
    enginePort: toNumber(process.env.ENGINE_PORT, 4000),
    dashboardSecret: process.env.DASHBOARD_SECRET || '',
    bridgeUrl: process.env.MT5_BRIDGE_URL || 'ws://127.0.0.1:3000/',
    storeFile: process.env.ENGINE_STORE_FILE || path.join(ROOT_DIR, 'data', 'engine-store.json'),
    autoMt5: process.env.AUTO_MT5 ? process.env.AUTO_MT5 !== 'false' : true,
  };
}
