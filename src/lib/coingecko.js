// Browser-only market data client for static hosting.
// Every endpoint below is a public API called directly from the user's browser.
import { analyzeCandleQuality, fillCandleGaps } from "./dataQuality.js";

const API_BASES = {
  coingecko: "https://api.coingecko.com/api/v3",
  binance: "https://api.binance.com",
  binanceUsdFutures: "https://fapi.binance.com",
  binanceCoinFutures: "https://dapi.binance.com",
  bybit: "https://api.bybit.com",
  okx: "https://www.okx.com",
  coinbase: "https://api.exchange.coinbase.com",
};

export const SOURCE_STATUS = {
  HEALTHY: "Healthy",
  LIMITED: "Limited",
  FAILED: "Failed",
  CORS_BLOCKED: "CORS blocked",
  RATE_LIMITED: "Rate limited",
};

const SOURCE_LABELS = {
  coingecko: "CoinGecko composite",
  binance: "Binance spot",
  bybit: "Bybit spot",
  okx: "OKX spot",
  coinbase: "Coinbase spot",
  binanceUsdFutures: "Binance USD-M futures",
  binanceCoinFutures: "Binance Coin-M futures",
};

export const CHART_SOURCES = [
  { id: "coingecko", label: SOURCE_LABELS.coingecko },
  { id: "binance", label: SOURCE_LABELS.binance },
  { id: "bybit", label: SOURCE_LABELS.bybit },
  { id: "okx", label: SOURCE_LABELS.okx },
  { id: "coinbase", label: SOURCE_LABELS.coinbase },
];

const cache = new Map();
const inflight = new Map();
const sourceHealth = new Map(
  Object.keys(API_BASES).map((id) => [
    id,
    {
      id,
      label: SOURCE_LABELS[id],
      status: SOURCE_STATUS.LIMITED,
      message: "Not checked yet in this browser session.",
      checkedAt: null,
    },
  ])
);

const CACHE_TTL_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const publicPath = (...parts) => `/${parts.join("/")}`;

export function getSourceHealth(source) {
  if (source) return sourceHealth.get(source) || null;
  return Object.fromEntries(sourceHealth.entries());
}

function setSourceHealth(source, status, message = "") {
  const current = sourceHealth.get(source) || { id: source, label: SOURCE_LABELS[source] || source };
  const next = { ...current, status, message, checkedAt: new Date().toISOString() };
  sourceHealth.set(source, next);
  return next;
}

function classifyFetchError(err) {
  if (err?.status === 429) return SOURCE_STATUS.RATE_LIMITED;
  if (err?.status) return SOURCE_STATUS.FAILED;
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(err?.message || err))) {
    return SOURCE_STATUS.CORS_BLOCKED;
  }
  return SOURCE_STATUS.FAILED;
}

function friendlyMessage(source, status, err) {
  if (status === SOURCE_STATUS.CORS_BLOCKED) {
    return `${SOURCE_LABELS[source] || source} is blocked by browser CORS or network policy.`;
  }
  if (status === SOURCE_STATUS.RATE_LIMITED) {
    return `${SOURCE_LABELS[source] || source} is rate limited.`;
  }
  if (err?.status) return `${SOURCE_LABELS[source] || source} returned HTTP ${err.status}.`;
  return `${SOURCE_LABELS[source] || source} is unavailable.`;
}

async function cachedJson(source, path, ttl = CACHE_TTL_MS) {
  const url = path.startsWith("http") ? path : `${API_BASES[source]}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          mode: "cors",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const data = await res.json();
          cache.set(url, { data, time: Date.now() });
          setSourceHealth(source, SOURCE_STATUS.HEALTHY, "Direct browser fetch succeeded.");
          return data;
        }
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        if (res.status === 429) {
          lastErr = err;
          setSourceHealth(source, SOURCE_STATUS.RATE_LIMITED, friendlyMessage(source, SOURCE_STATUS.RATE_LIMITED, err));
          await sleep(900 * (attempt + 1));
          continue;
        }
        throw err;
      } catch (err) {
        lastErr = err;
        const status = classifyFetchError(err);
        setSourceHealth(source, status, friendlyMessage(source, status, err));
        if (status !== SOURCE_STATUS.RATE_LIMITED) break;
      }
    }
    if (hit) {
      setSourceHealth(source, SOURCE_STATUS.LIMITED, "Serving cached data because the live request failed.");
      return hit.data;
    }
    throw lastErr || new Error(`${source} request failed`);
  })().finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

function withMeta(candles, meta) {
  Object.defineProperty(candles, "meta", {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return candles;
}

function inferPrecisionFromCandles(candles) {
  const last = candles?.at?.(-1)?.close;
  return { tickSize: null, stepSize: null, pricePrecision: null, referencePrice: last ?? null };
}

async function getPrecisionMetadata(source, pair, marketType = "Spot") {
  try {
    if (source === "binance" || source === "binanceUsdFutures" || source === "binanceCoinFutures") return getBinancePrecision(pair, marketType);
    if (source === "okx") return getOkxPrecision(pair);
    if (source === "bybit") return getBybitPrecision(pair);
    if (source === "coinbase") return getCoinbasePrecision(pair);
  } catch {
    return {};
  }
  return {};
}

function failureMeta(source, err) {
  const status = classifyFetchError(err);
  return {
    source,
    sourceLabel: SOURCE_LABELS[source] || source,
    status,
    message: friendlyMessage(source, status, err),
  };
}

/** Current price + 24h stats for a list of coin ids. */
export async function getMarketSnapshot(ids) {
  const idsParam = ids.join(",");
  const data = await cachedJson(
    "coingecko",
    `/coins/markets?vs_currency=usd&ids=${idsParam}&order=market_cap_desc&price_change_percentage=24h,7d`
  );
  return data;
}

/** Free-text coin search -> list of matches. */
export async function searchCoins(query) {
  const q = query.trim();
  if (!q) return [];
  const data = await cachedJson("coingecko", `/search?query=${encodeURIComponent(q)}`, 120_000);
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
  const data = await cachedJson(
    "coingecko",
    `/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
    ttl
  );
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

export function resolveLookbackDays(timeframe, lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  if (lookbackDays == null || lookbackDays === "") return tf.days;
  return Math.max(1, Math.round(Number(lookbackDays) || tf.days));
}

function candlesNeeded(intervalMinutes, days) {
  return Math.ceil((days * 24 * 60) / Math.max(1, intervalMinutes));
}

export function defaultPairForSymbol(symbol) {
  return `${String(symbol || "BTC").replace(/[^a-z0-9]/gi, "").toUpperCase()}USDT`;
}

export async function getCandles(id, days = 90) {
  const candles = await getCoinGeckoCandles(id, days);
  const tf = resolveTimeframe(days);
  const baseMeta = {
    source: "coingecko",
    sourceLabel: SOURCE_LABELS.coingecko,
    status: getSourceHealth("coingecko")?.status || SOURCE_STATUS.HEALTHY,
    warnings: [],
    precision: inferPrecisionFromCandles(candles),
  };
  const quality = analyzeCandleQuality({
    candles,
    intervalSeconds: tf.intervalMinutes * 60,
    sourceMeta: baseMeta,
  });
  return withMeta(candles, {
    ...baseMeta,
    quality,
    confidence: quality.confidenceFactor,
  });
}

async function getCoinGeckoCandles(id, timeframe = 90, lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  const d = lookbackDays != null ? resolveLookbackDays(timeframe, lookbackDays) : tf.days;

  if (tf.intervalMinutes < 1440) {
    const prices = await getPriceSeries(id, d);
    return bucketCandlesByInterval(prices, tf.intervalMinutes);
  }

  if (OHLC_ALLOWED.includes(d)) {
    const data = await cachedJson("coingecko", `/coins/${id}/ohlc?vs_currency=usd&days=${d}`);
    return data.map(([time, open, high, low, close]) => ({
      time: Math.floor(time / 1000),
      open,
      high,
      low,
      close,
    }));
  }

  const prices = await getPriceSeries(id, d);
  return bucketCandlesByInterval(prices, tf.intervalMinutes);
}

export async function getChartCandles({ id, symbol, timeframe = "4h", lookbackDays, source = "coingecko", pair, marketType = "Spot" }) {
  const requested = source || "coingecko";
  const warnings = [];
  const tf = resolveTimeframe(timeframe);
  const effectiveDays = resolveLookbackDays(timeframe, lookbackDays);
  const candidates =
    marketType !== "Spot"
      ? ["binance"]
      : requested === "coingecko"
      ? [tf.intervalMinutes < 1440 ? "binance" : "coingecko", "coingecko"]
      : [requested, "binance", "coingecko"];

  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    const healthSource = candidate === "binance" ? binancePrecisionSource(marketType) : candidate;
    try {
      const rawCandles =
        candidate === "binance"
          ? await getBinanceCandles(pair || defaultPairForSymbol(symbol), timeframe, marketType, effectiveDays)
          : candidate === "bybit"
            ? await getBybitCandles(pair || defaultPairForSymbol(symbol), timeframe, effectiveDays)
            : candidate === "okx"
              ? await getOkxCandles(pair || defaultPairForSymbol(symbol), timeframe, effectiveDays)
              : candidate === "coinbase"
                ? await getCoinbaseCandles(pair || defaultPairForSymbol(symbol), timeframe, effectiveDays)
                : await getCoinGeckoCandles(id, timeframe, effectiveDays);

      const filled = fillCandleGaps(rawCandles, tf.intervalMinutes * 60);
      const candles = filled.candles;
      const precisionSource = healthSource;
      const precision = {
        ...inferPrecisionFromCandles(candles),
        ...(await getPrecisionMetadata(precisionSource, pair || defaultPairForSymbol(symbol), marketType)),
      };
      const baseMeta = {
        source: healthSource,
        sourceLabel: SOURCE_LABELS[healthSource],
        requestedSource: requested,
        status: getSourceHealth(healthSource)?.status || SOURCE_STATUS.HEALTHY,
        warnings,
        precision,
        syntheticCandles: filled.syntheticCount,
      };
      const quality = analyzeCandleQuality({
        candles,
        intervalSeconds: tf.intervalMinutes * 60,
        sourceMeta: baseMeta,
      });
      const confidence = Math.max(0.2, Math.max(0.55, 1 - warnings.length * 0.2) * quality.confidenceFactor);
      return withMeta(candles, { ...baseMeta, quality, confidence });
    } catch (err) {
      warnings.push(failureMeta(healthSource, err));
    }
  }

  const message = warnings.map((w) => `${w.sourceLabel}: ${w.status}`).join("; ");
  throw new Error(`No browser-accessible market source is available. ${message}`);
}

async function getBinancePrecision(pair, marketType = "Spot") {
  const source = binancePrecisionSource(marketType);
  const symbol = binanceSymbolForMarket(pair, marketType);
  if (!symbol) return {};
  const path = marketType === "Spot" ? publicPath("api", "v3", "exchangeInfo") : marketType === "Coin-M Futures" ? publicPath("dapi", "v1", "exchangeInfo") : publicPath("fapi", "v1", "exchangeInfo");
  const data = await cachedJson(source, `${path}?symbol=${symbol}`, 300_000);
  const info = data?.symbols?.[0];
  const priceFilter = info?.filters?.find((f) => f.filterType === "PRICE_FILTER");
  const lotFilter = info?.filters?.find((f) => f.filterType === "LOT_SIZE");
  return {
    tickSize: priceFilter?.tickSize,
    stepSize: lotFilter?.stepSize,
    pricePrecision: info?.quotePrecision ?? info?.pricePrecision ?? null,
  };
}

async function getBybitPrecision(pair) {
  const symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) return {};
  const data = await cachedJson("bybit", `/v5/market/instruments-info?category=spot&symbol=${symbol}`, 300_000);
  const info = data?.result?.list?.[0];
  return {
    tickSize: info?.priceFilter?.tickSize,
    stepSize: info?.lotSizeFilter?.basePrecision,
    pricePrecision: null,
  };
}

async function getOkxPrecision(pair) {
  const symbol = pairToDashSymbol(pair);
  if (!symbol) return {};
  const data = await cachedJson("okx", `${publicPath("api", "v5", "public", "instruments")}?instType=SPOT&instId=${symbol}`, 300_000);
  const info = data?.data?.[0];
  return {
    tickSize: info?.tickSz,
    stepSize: info?.lotSz,
    pricePrecision: null,
  };
}

async function getCoinbasePrecision(pair) {
  const symbol = pairToDashSymbol(pair, ["USDT", "USDC", "USD", "EUR", "BTC"]);
  if (!symbol) return {};
  const data = await cachedJson("coinbase", `/products/${symbol}`, 300_000);
  return {
    tickSize: data?.quote_increment,
    stepSize: data?.base_increment,
    pricePrecision: null,
  };
}

async function getBybitCandles(pair, timeframe, lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  const days = resolveLookbackDays(timeframe, lookbackDays);
  const needed = candlesNeeded(tf.intervalMinutes, days);
  const interval = bybitInterval(tf.id);
  const symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!symbol) throw new Error("Missing Bybit symbol");

  let all = [];
  let end;
  while (all.length < needed) {
    const limit = Math.min(1000, needed - all.length);
    let query = `/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (end) query += `&end=${end}`;
    const resData = await cachedJson("bybit", query, 12_000);
    if (resData.retCode !== 0 || !resData.result || !Array.isArray(resData.result.list) || !resData.result.list.length) {
      break;
    }
    const batch = [...resData.result.list].reverse().map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    all = [...batch, ...all];
    if (batch.length < limit) break;
    end = Number(resData.result.list[resData.result.list.length - 1][0]) - 1;
  }

  if (!all.length) throw new Error("Invalid Bybit response");
  return all.slice(-needed);
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

async function getOkxCandles(pair, timeframe, lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  const days = resolveLookbackDays(timeframe, lookbackDays);
  const needed = candlesNeeded(tf.intervalMinutes, days);
  const bar = okxInterval(tf.id);
  const symbol = pairToDashSymbol(pair);
  if (!symbol) throw new Error("Missing OKX symbol");

  let all = [];
  let before;
  while (all.length < needed) {
    const limit = Math.min(1000, needed - all.length);
    let query = `${publicPath("api", "v5", "market", "candles")}?instId=${symbol}&bar=${bar}&limit=${limit}`;
    if (before) query += `&before=${before}`;
    const resData = await cachedJson("okx", query, 12_000);
    if (resData.code !== "0" || !Array.isArray(resData.data) || !resData.data.length) break;
    const batch = [...resData.data].reverse().map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    all = [...batch, ...all];
    if (batch.length < limit) break;
    before = resData.data[resData.data.length - 1][0];
  }

  if (!all.length) throw new Error("Invalid OKX response");
  return all.slice(-needed);
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

async function getCoinbaseCandles(pair, timeframe, lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  const days = resolveLookbackDays(timeframe, lookbackDays);
  const needed = candlesNeeded(tf.intervalMinutes, days);
  const granularity = coinbaseGranularity(tf.id);
  const symbol = pairToDashSymbol(pair, ["USDT", "USDC", "USD", "EUR", "BTC"]);
  if (!symbol) throw new Error("Missing Coinbase symbol");
  const data = await cachedJson("coinbase", `/products/${symbol}/candles?granularity=${granularity}`, 12_000);
  if (!Array.isArray(data)) throw new Error("Invalid Coinbase response");
  const candles = [...data].reverse().map((k) => ({
    time: Number(k[0]),
    low: Number(k[1]),
    high: Number(k[2]),
    open: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
  return candles.slice(-needed);
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

export const getOHLC = getCandles;

/** Raw price series [{ time(ms), price }] from market_chart. */
export async function getPriceSeries(id, days = 90) {
  const data = await cachedJson("coingecko", `/coins/${id}/market_chart?vs_currency=usd&days=${Math.max(1, Math.round(days))}`);
  return (data.prices || []).map(([t, price]) => ({ time: t, price }));
}

/** Close-only series (seconds + value) for charts/forecasting. */
export async function getCloseSeries(id, days = 90) {
  const prices = await getPriceSeries(id, days);
  return prices.map((p) => ({ time: Math.floor(p.time / 1000), value: p.price }));
}

async function getBinanceCandles(pair, timeframe, marketType = "Spot", lookbackDays) {
  const tf = resolveTimeframe(timeframe);
  const days = resolveLookbackDays(timeframe, lookbackDays);
  const interval = binanceInterval(tf.id);
  const needed = candlesNeeded(tf.intervalMinutes, days);
  const source = binancePrecisionSource(marketType);
  const symbol = binanceSymbolForMarket(pair, marketType);
  if (!symbol) throw new Error("Missing Binance symbol");
  const path = marketType === "Spot" ? publicPath("api", "v3", "klines") : marketType === "Coin-M Futures" ? publicPath("dapi", "v1", "klines") : publicPath("fapi", "v1", "klines");

  let all = [];
  let endTime;
  while (all.length < needed) {
    const limit = Math.min(1000, needed - all.length);
    let query = `${path}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) query += `&endTime=${endTime}`;
    const data = await cachedJson(source, query, 12_000);
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    all = [...batch, ...all];
    if (batch.length < limit) break;
    endTime = data[0][0] - 1;
  }

  return all.slice(-needed);
}

function binancePrecisionSource(marketType) {
  if (marketType === "USD-M Futures") return "binanceUsdFutures";
  if (marketType === "Coin-M Futures") return "binanceCoinFutures";
  return "binance";
}

function binanceSymbolForMarket(pair, marketType) {
  const symbol = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (marketType === "Coin-M Futures") {
    const base = symbol.replace(/(USDT|USDC|BUSD|USD)$/, "");
    return base ? `${base}USD_PERP` : symbol;
  }
  return symbol;
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

function pairToDashSymbol(pair, quotes = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "USD", "EUR"]) {
  const raw = String(pair || "").toUpperCase();
  if (raw.includes("-")) return raw.replace(/[^A-Z0-9-]/g, "");
  const symbol = raw.replace(/[^A-Z0-9]/g, "");
  for (const q of quotes) {
    if (symbol.endsWith(q) && symbol.length > q.length) return `${symbol.slice(0, -q.length)}-${q}`;
  }
  return symbol.length > 3 ? `${symbol.slice(0, 3)}-${symbol.slice(3)}` : symbol;
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
