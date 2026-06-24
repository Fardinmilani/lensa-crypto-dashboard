// lib/coingecko.js
// Thin wrapper around the free CoinGecko public API.
// No API key needed; CORS is open on the public endpoints.

// Same-origin proxy (Vite dev proxy locally, Cloudflare Function in prod).
// This avoids browser CORS and lets the edge cache responses to reduce 429s.
const BASE = "/api/cg";
const BINANCE_BASE = "/api/binance";
const BYBIT_BASE = "/api/bybit";
const OKX_BASE = "/api/okx";
const COINBASE_BASE = "/api/coinbase";

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

export const CHART_SOURCES = [
  { id: "coingecko", label: "CoinGecko composite" },
  { id: "binance", label: "Binance spot" },
  { id: "bybit", label: "Bybit spot" },
  { id: "okx", label: "OKX spot" },
  { id: "coinbase", label: "Coinbase spot" },
];

export function defaultPairForSymbol(symbol) {
  return `${String(symbol || "BTC").replace(/[^a-z0-9]/gi, "").toUpperCase()}USDT`;
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

export async function getChartCandles({ id, symbol, timeframe = "4h", source = "coingecko", pair }) {
  if (source === "binance") {
    try {
      return await getBinanceCandles(pair || defaultPairForSymbol(symbol), timeframe);
    } catch {
      return getCandles(id, timeframe);
    }
  }
  if (source === "bybit") {
    try {
      return await getBybitCandles(pair || defaultPairForSymbol(symbol), timeframe);
    } catch {
      return getCandles(id, timeframe);
    }
  }
  if (source === "okx") {
    try {
      return await getOkxCandles(pair || defaultPairForSymbol(symbol), timeframe);
    } catch {
      return getCandles(id, timeframe);
    }
  }
  if (source === "coinbase") {
    try {
      return await getCoinbaseCandles(pair || defaultPairForSymbol(symbol), timeframe);
    } catch {
      return getCandles(id, timeframe);
    }
  }

  // For coingecko (composite): if timeframe is intraday (< 1D), to avoid gaps
  // we automatically fetch from Binance spot.
  const tf = resolveTimeframe(timeframe);
  if (tf.intervalMinutes < 1440) {
    try {
      return await getBinanceCandles(defaultPairForSymbol(symbol), timeframe);
    } catch {
      return getCandles(id, timeframe);
    }
  }

  return getCandles(id, timeframe);
}

async function getBybitCandles(pair, timeframe) {
  const tf = resolveTimeframe(timeframe);
  const interval = bybitInterval(tf.id);
  const symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) throw new Error("Missing Bybit symbol");
  const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=1000`;
  const resData = await cachedFetch(url, Math.min(CACHE_TTL_MS, 12_000));
  if (resData.retCode !== 0 || !resData.result || !Array.isArray(resData.result.list)) {
    throw new Error("Invalid Bybit response");
  }
  return [...resData.result.list].reverse().map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function bybitInterval(id) {
  const map = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "45m": "60",
    "1h": "60",
    "2h": "120",
    "3h": "240",
    "4h": "240",
    "1d": "D",
    "1w": "W",
    "1M": "M",
    "3M": "M",
    "6M": "M",
    "12M": "M",
  };
  return map[id] || "D";
}

async function getOkxCandles(pair, timeframe) {
  const tf = resolveTimeframe(timeframe);
  const bar = okxInterval(tf.id);
  let symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) throw new Error("Missing OKX symbol");
  if (!symbol.includes("-")) {
    const commonQuotes = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "USD", "EUR"];
    let mapped = false;
    for (const q of commonQuotes) {
      if (symbol.endsWith(q) && symbol.length > q.length) {
        symbol = `${symbol.slice(0, -q.length)}-${q}`;
        mapped = true;
        break;
      }
    }
    if (!mapped) {
      if (symbol.endsWith("USDT") || symbol.endsWith("USDC")) {
        symbol = `${symbol.slice(0, -4)}-${symbol.slice(-4)}`;
      } else {
        symbol = `${symbol.slice(0, 3)}-${symbol.slice(3)}`;
      }
    }
  }

  const url = `${OKX_BASE}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=1000`;
  const resData = await cachedFetch(url, Math.min(CACHE_TTL_MS, 12_000));
  if (resData.code !== "0" || !Array.isArray(resData.data)) {
    throw new Error("Invalid OKX response");
  }
  return [...resData.data].reverse().map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function okxInterval(id) {
  const map = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "45m": "1H",
    "1h": "1H",
    "2h": "2H",
    "3h": "4H",
    "4h": "4H",
    "1d": "1D",
    "1w": "1W",
    "1M": "1M",
    "3M": "1M",
    "6M": "1M",
    "12M": "1M",
  };
  return map[id] || "1D";
}

async function getCoinbaseCandles(pair, timeframe) {
  const tf = resolveTimeframe(timeframe);
  const granularity = coinbaseGranularity(tf.id);
  let symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) throw new Error("Missing Coinbase symbol");
  if (!symbol.includes("-")) {
    const commonQuotes = ["USDT", "USDC", "USD", "EUR", "BTC"];
    let mapped = false;
    for (const q of commonQuotes) {
      if (symbol.endsWith(q) && symbol.length > q.length) {
        symbol = `${symbol.slice(0, -q.length)}-${q}`;
        mapped = true;
        break;
      }
    }
    if (!mapped) {
      symbol = `${symbol.slice(0, 3)}-${symbol.slice(3)}`;
    }
  }

  const url = `${COINBASE_BASE}/products/${symbol}/candles?granularity=${granularity}`;
  const data = await cachedFetch(url, Math.min(CACHE_TTL_MS, 12_000));
  if (!Array.isArray(data)) {
    throw new Error("Invalid Coinbase response");
  }
  return [...data].reverse().map((k) => ({
    time: Number(k[0]),
    low: Number(k[1]),
    high: Number(k[2]),
    open: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function coinbaseGranularity(id) {
  const map = {
    "1m": 60,
    "3m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 900,
    "45m": 3600,
    "1h": 3600,
    "2h": 3600,
    "3h": 21600,
    "4h": 21600,
    "1d": 86400,
    "1w": 86400,
    "1M": 86400,
  };
  return map[id] || 86400;
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

async function getBinanceCandles(pair, timeframe) {
  const tf = resolveTimeframe(timeframe);
  const interval = binanceInterval(tf.id);
  const limit = binanceLimit(tf);
  const symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) throw new Error("Missing Binance symbol");
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await cachedFetch(url, Math.min(CACHE_TTL_MS, 12_000));
  if (!Array.isArray(data)) throw new Error("Invalid Binance response");
  return data.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function binanceInterval(id) {
  const map = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "45m": "1h",
    "1h": "1h",
    "2h": "2h",
    "3h": "4h",
    "4h": "4h",
    "1d": "1d",
    "1w": "1w",
    "1M": "1M",
    "3M": "1M",
    "6M": "1M",
    "12M": "1M",
  };
  return map[id] || "1d";
}

function binanceLimit(tf) {
  const approx = Math.ceil((tf.days * 24 * 60) / Math.max(1, tf.intervalMinutes));
  return Math.min(1000, Math.max(80, approx));
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
