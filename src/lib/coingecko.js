// lib/coingecko.js
// Thin wrapper around the free CoinGecko public API.
// No API key needed; CORS is open on the public endpoints.

const BASE = "https://api.coingecko.com/api/v3";

// Simple in-memory cache to respect the free-tier rate limit (~10-30 calls/min).
const cache = new Map();
const CACHE_TTL_MS = 30_000;

async function cachedFetch(url, ttl = CACHE_TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("محدودیت نرخ CoinGecko (۴۲۹) — چند ثانیه صبر کنید و دوباره تلاش کنید.");
    }
    throw new Error(`درخواست CoinGecko ناموفق بود: ${res.status}`);
  }
  const data = await res.json();
  cache.set(url, { data, time: Date.now() });
  return data;
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
export async function getCoinDetail(id) {
  const url = `${BASE}/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const data = await cachedFetch(url, 60_000);
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

/**
 * Candle fetcher that works for ANY coin and ANY timeframe (in days).
 * - For the values CoinGecko's OHLC endpoint supports natively, we use true OHLC.
 * - For any other day count we fetch the fine-grained price series from
 *   market_chart and bucket it into real OHLC candles, so users can pick an
 *   arbitrary window (including short intraday windows).
 *
 * @param {string} id coin id, e.g. "bitcoin"
 * @param {number} days lookback window in days
 */
export async function getCandles(id, days = 90) {
  const d = Math.max(1, Math.round(days));
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
  return bucketCandles(prices, targetCandleCount(d));
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

function targetCandleCount(days) {
  if (days <= 2) return 96;
  if (days <= 30) return 120;
  if (days <= 120) return 120;
  return Math.min(365, days);
}

function bucketCandles(prices, targetCount) {
  if (!prices.length) return [];
  const size = Math.max(1, Math.floor(prices.length / targetCount));
  const candles = [];
  for (let i = 0; i < prices.length; i += size) {
    const slice = prices.slice(i, i + size);
    if (!slice.length) continue;
    let high = -Infinity;
    let low = Infinity;
    for (const p of slice) {
      if (p.price > high) high = p.price;
      if (p.price < low) low = p.price;
    }
    candles.push({
      time: Math.floor(slice[slice.length - 1].time / 1000),
      open: slice[0].price,
      high,
      low,
      close: slice[slice.length - 1].price,
    });
  }
  return candles;
}

export const DEFAULT_COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin", tvSymbol: "BINANCE:BTCUSDT" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum", tvSymbol: "BINANCE:ETHUSDT" },
  { id: "solana", symbol: "SOL", name: "Solana", tvSymbol: "BINANCE:SOLUSDT" },
  { id: "binancecoin", symbol: "BNB", name: "BNB", tvSymbol: "BINANCE:BNBUSDT" },
  { id: "ripple", symbol: "XRP", name: "XRP", tvSymbol: "BINANCE:XRPUSDT" },
];

// Timeframe presets used across Backtest + Forecast. `days` drives the API call.
export const TIMEFRAMES = [
  { id: "1d", label: "۱ روز (اینترادی)", days: 1, intraday: true },
  { id: "7d", label: "۷ روز", days: 7, intraday: true },
  { id: "14d", label: "۱۴ روز", days: 14, intraday: true },
  { id: "30d", label: "۳۰ روز", days: 30, intraday: true },
  { id: "90d", label: "۹۰ روز", days: 90 },
  { id: "180d", label: "۱۸۰ روز", days: 180 },
  { id: "365d", label: "۱ سال", days: 365 },
];
