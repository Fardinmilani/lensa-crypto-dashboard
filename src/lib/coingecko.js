// lib/coingecko.js
// Thin wrapper around the free CoinGecko public API.
// No API key needed; CORS is open on the public endpoints.

// Same-origin proxy (Vite dev proxy locally, Cloudflare Function in prod).
// This avoids browser CORS and lets the edge cache responses to reduce 429s.
const BASE = "/api/cg";

// In-memory cache + in-flight de-duplication to respect the free-tier limit.
const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cachedFetch(url, ttl = CACHE_TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    let lastErr;
    // Retry with backoff on transient rate-limits.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const data = await res.json();
        cache.set(url, { data, time: Date.now() });
        return data;
      }
      if (res.status === 429) {
        lastErr = new Error("rate-limit");
        await sleep(900 * (attempt + 1));
        continue;
      }
      throw new Error(`CoinGecko request failed: ${res.status}`);
    }
    // If we exhausted retries but have a stale cache entry, serve it.
    if (hit) return hit.data;
    throw lastErr || new Error("CoinGecko request failed");
  })().finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

/** Current price + 24h stats for a list of coin ids. */
export async function getMarketSnapshot(ids) {
  const idsParam = ids.join(",");
  const url = `${BASE}/coins/markets?vs_currency=usd&ids=${idsParam}&order=market_cap_desc&price_change_percentage=24h,7d`;
  return cachedFetch(url);
}

/** Free-text coin search → list of matches. */
export async function searchCoins(query) {
  const q = query.trim();
  if (!q) return [];
  const url = `${BASE}/search?query=${encodeURIComponent(q)}`;
  const data = await cachedFetch(url, 120_000);
  return (data.coins || []).map((c) => ({
    id: c.id,
    symbol: (c.symbol || "").toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank ?? null,
    thumb: c.thumb,
    large: c.large,
  }));
}

/** Rich metadata for a single coin (price, image, links). */
export async function getCoinDetail(id, ttl = 15_000) {
  const url = `${BASE}/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const data = await cachedFetch(url, ttl);
  return {
    id: data.id,
    symbol: (data.symbol || "").toUpperCase(),
    name: data.name,
    image: data.image?.small,
    price: data.market_data?.current_price?.usd ?? null,
    change24h: data.market_data?.price_change_percentage_24h ?? null,
    change7d: data.market_data?.price_change_percentage_7d ?? null,
    marketCap: data.market_data?.market_cap?.usd ?? null,
    volume24h: data.market_data?.total_volume?.usd ?? null,
    high24h: data.market_data?.high_24h?.usd ?? null,
    low24h: data.market_data?.low_24h?.usd ?? null,
    ath: data.market_data?.ath?.usd ?? null,
    atl: data.market_data?.atl?.usd ?? null,
    rank: data.market_cap_rank ?? null,
  };
}

// CoinGecko's OHLC endpoint only accepts these `days` values on the free tier.
const OHLC_ALLOWED = [1, 7, 14, 30, 90, 180, 365];

export const TIMEFRAMES = [
  { id: "1m", label: "1m", intervalMinutes: 1, days: 1, intraday: true },
  { id: "3m", label: "3m", intervalMinutes: 3, days: 1, intraday: true },
  { id: "5m", label: "5m", intervalMinutes: 5, days: 1, intraday: true },
  { id: "15m", label: "15m", intervalMinutes: 15, days: 2, intraday: true },
  { id: "30m", label: "30m", intervalMinutes: 30, days: 3, intraday: true },
  { id: "45m", label: "45m", intervalMinutes: 45, days: 5, intraday: true },
  { id: "1h", label: "1h", intervalMinutes: 60, days: 7, intraday: true },
  { id: "2h", label: "2h", intervalMinutes: 120, days: 14, intraday: true },
  { id: "3h", label: "3h", intervalMinutes: 180, days: 21, intraday: true },
  { id: "4h", label: "4h", intervalMinutes: 240, days: 30, intraday: true },
  { id: "1d", label: "1D", intervalMinutes: 1440, days: 180 },
  { id: "1w", label: "1W", intervalMinutes: 10080, days: 365 },
  { id: "1M", label: "1M", intervalMinutes: 43200, days: 365 },
  { id: "3M", label: "3M", intervalMinutes: 129600, days: 1095 },
  { id: "6M", label: "6M", intervalMinutes: 259200, days: 1825 },
  { id: "12M", label: "12M", intervalMinutes: 525600, days: 3650 },
];

export function resolveTimeframe(value) {
  if (typeof value === "string") {
    return TIMEFRAMES.find((tf) => tf.id === value) || TIMEFRAMES.find((tf) => tf.id === "1d");
  }
  const days = Math.max(1, Math.round(Number(value) || 90));
  return { id: `custom-${days}`, label: `${days}D`, intervalMinutes: 1440, days };
}

/**
 * Candle fetcher that works for any coin and preset/custom timeframe.
 * - For the values CoinGecko's OHLC endpoint supports natively, we use true OHLC.
 * - For TradingView-style intervals and custom day counts, we fetch the
 *   available price series and bucket it into OHLC candles at the requested
 *   interval. The source granularity is bounded by CoinGecko's public data.
 *
 * @param {string} id coin id, e.g. "bitcoin"
 * @param {string|number} days timeframe id or custom lookback window in days
 */
export async function getCandles(id, days = 90) {
  const tf = resolveTimeframe(days);
  const d = Math.max(1, Math.round(tf.days));

  if (tf.intervalMinutes < 1440) {
    const prices = await getPriceSeries(id, d);
    return bucketCandlesByInterval(prices, tf.intervalMinutes);
  }

  if (OHLC_ALLOWED.includes(d)) {
    const url = `${BASE}/coins/${id}/ohlc?vs_currency=usd&days=${d}`;
    const data = await cachedFetch(url);
    return data.map(([time, open, high, low, close]) => ({
      time: Math.floor(time / 1000),
      open,
      high,
      low,
      close,
    }));
  }
  // Arbitrary window → synthesize candles from the price series.
  const prices = await getPriceSeries(id, d);
  return bucketCandlesByInterval(prices, tf.intervalMinutes);
}

// Keep the old name as an alias so nothing breaks.
export const getOHLC = getCandles;

/** Raw price series [{ time(ms), price }] from market_chart. */
export async function getPriceSeries(id, days = 90) {
  const url = `${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${Math.max(1, Math.round(days))}`;
  const data = await cachedFetch(url);
  return (data.prices || []).map(([t, price]) => ({ time: t, price }));
}

/** Close-only series (seconds + value) — handy for charts/forecasting. */
export async function getCloseSeries(id, days = 90) {
  const prices = await getPriceSeries(id, days);
  return prices.map((p) => ({ time: Math.floor(p.time / 1000), value: p.price }));
}

function bucketCandlesByInterval(prices, intervalMinutes) {
  if (!prices.length) return [];
  const intervalMs = Math.max(60_000, intervalMinutes * 60_000);
  const buckets = new Map();
  for (const p of prices) {
    const key = Math.floor(p.time / intervalMs) * intervalMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  return [...buckets.entries()].map(([time, slice]) => {
    let high = -Infinity;
    let low = Infinity;
    for (const p of slice) {
      if (p.price > high) high = p.price;
      if (p.price < low) low = p.price;
    }
    return {
      time: Math.floor(time / 1000),
      open: slice[0].price,
      high,
      low,
      close: slice[slice.length - 1].price,
    };
  });
}

export const DEFAULT_COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin", thumb: "https://coin-images.coingecko.com/coins/images/1/thumb/bitcoin.png", tvSymbol: "BINANCE:BTCUSDT" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum", thumb: "https://coin-images.coingecko.com/coins/images/279/thumb/ethereum.png", tvSymbol: "BINANCE:ETHUSDT" },
  { id: "solana", symbol: "SOL", name: "Solana", thumb: "https://coin-images.coingecko.com/coins/images/4128/thumb/solana.png", tvSymbol: "BINANCE:SOLUSDT" },
  { id: "binancecoin", symbol: "BNB", name: "BNB", thumb: "https://coin-images.coingecko.com/coins/images/825/thumb/bnb-icon2_2x.png", tvSymbol: "BINANCE:BNBUSDT" },
  { id: "ripple", symbol: "XRP", name: "XRP", thumb: "https://coin-images.coingecko.com/coins/images/44/thumb/xrp-symbol-white-128.png", tvSymbol: "BINANCE:XRPUSDT" },
];
