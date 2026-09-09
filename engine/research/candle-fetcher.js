// engine/research/candle-fetcher.js
// Headless (Node) historical candle fetcher for the Auto-Researcher.
//
// This mirrors the chunked-fetch algorithm in js/backtest-core.js but uses
// the `ws` npm package instead of the browser's global `WebSocket`, so it
// can run unattended under pm2/Node without a DOM.
//
// Public API is intentionally shaped like js/backtest-core.js's
// `_fetchCandles` so the same walk-forward/optimizer logic can be reused
// unchanged on both the client and the server.

import WebSocket from 'ws';

const WS_URL = process.env.DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const CHUNK_SIZE = 1500;
const CHUNK_DELAY = 800;
const REQUEST_TIMEOUT = 25000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch a single chunk of candles (max 5000 per Deriv API, we cap at 1500
// to stay well under rate limits during long research sweeps).
export function fetchChunk(symbol, granularity, count, end = 'latest') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let resolved = false;
    const payload = {
      ticks_history: symbol,
      granularity,
      count,
      style: 'candles',
      adjust_start_time: 1,
      end: end === 'latest' ? 'latest' : end,
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        try { ws.terminate(); } catch (_) {}
        reject(new Error(`Timeout fetching ${symbol} @ ${granularity}s`));
      }
    }, REQUEST_TIMEOUT);

    ws.on('open', () => ws.send(JSON.stringify(payload)));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.error) {
        resolved = true;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        reject(new Error(msg.error.message || 'Deriv API error'));
        return;
      }

      if (msg.candles) {
        resolved = true;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        resolve(msg.candles.map((c) => ({
          time: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
        })));
      }
    });

    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('WebSocket error'));
      }
    });

    ws.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error('Connection closed before candles were received'));
      }
    });
  });
}

// Fetch `count` candles for `symbol`/`granularity`, transparently chunking
// requests larger than CHUNK_SIZE and de-duping/sorting the result.
export async function fetchCandles(symbol, granularity, count, onProgress) {
  if (count <= CHUNK_SIZE) {
    return fetchChunk(symbol, granularity, count, 'latest');
  }

  const chunks = [];
  let remaining = count;
  let endTime = 'latest';

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, CHUNK_SIZE);
    const batch = await fetchChunk(symbol, granularity, chunkSize, endTime);
    if (!batch.length) break;
    chunks.unshift(batch);
    remaining -= batch.length;
    endTime = batch[0].time - 1;
    if (onProgress) onProgress(count - remaining, count);
    if (remaining > 0) await sleep(CHUNK_DELAY);
  }

  const merged = chunks.flat();
  const seen = new Set();
  return merged
    .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}
