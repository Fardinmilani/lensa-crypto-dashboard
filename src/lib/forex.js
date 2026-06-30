// lib/forex.js
// Forex (fiat currency pair) data, sourced from Frankfurter — a free,
// open-source, no-API-key currency rate API that explicitly supports CORS,
// so it can be called directly from the browser on static hosting (no
// backend proxy needed), the same constraint the rest of this app runs
// under. https://frankfurter.dev
//
// IMPORTANT HONESTY NOTE: Frankfurter (like every genuinely free, no-key
// forex source) only publishes ONE reference rate per working day (sourced
// from the ECB and other central banks, updated once around 16:00 CET). It
// is NOT an intraday tick/OHLC feed — there is no free, keyless API that
// provides real 1m/5m/1h forex candles with browser CORS. Every commercial
// alternative that does (FCS, TraderMade, Tiingo, FastForex, FXMarketAPI,
// ...) requires a paid API key, which this static, backend-less app can't
// hold securely client-side anyway.
//
// Rather than faking intraday granularity we don't have, this module is
// explicit about it: forex only ever produces DAILY candles, built directly
// from one real rate per day (open = previous day's rate, close = that
// day's rate, high/low = the wider of the two — i.e. the true daily range
// the published reference rate moved across). Intraday timeframes are
// disabled for forex symbols in the UI (see MarketContext / TimeframePicker
// usage) instead of silently degrading to misleading synthetic candles.

const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // currency list / metadata barely changes

async function fetchJson(url, ttl = CACHE_TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    const res = await fetch(url, { mode: "cors", headers: { Accept: "application/json" } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    cache.set(url, { data, time: Date.now() });
    return data;
  })().finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

let currencyListPromise = null;
/** { USD: "United States Dollar", EUR: "Euro", ... } */
export async function getForexCurrencies() {
  if (!currencyListPromise) {
    currencyListPromise = fetchJson(`${FRANKFURTER_BASE}/currencies`, 24 * 60 * 60 * 1000).catch((err) => {
      currencyListPromise = null;
      throw err;
    });
  }
  return currencyListPromise;
}

const FOREX_ID_PREFIX = "fx:";

/** "EURUSD" | "EUR/USD" | "eur-usd" -> { base: "EUR", quote: "USD" } or null */
export function parseForexPairText(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (clean.length !== 6) return null;
  return { base: clean.slice(0, 3), quote: clean.slice(3, 6) };
}

export function forexCoinId(base, quote) {
  return `${FOREX_ID_PREFIX}${base}${quote}`;
}

export function isForexCoinId(id) {
  return typeof id === "string" && id.startsWith(FOREX_ID_PREFIX);
}

/** "fx:EURUSD" -> { base: "EUR", quote: "USD" } */
export function parseForexCoinId(id) {
  if (!isForexCoinId(id)) return null;
  return parseForexPairText(id.slice(FOREX_ID_PREFIX.length));
}

export function forexPairLabel(base, quote) {
  return `${base}/${quote}`;
}

/**
 * Free-text forex search, mirroring the shape searchCoins() returns for
 * CoinGecko coins so callers (CoinSearch, SymbolSearch) can merge the two
 * lists with zero special-casing.
 *
 * Matches against both currency codes (EUR, USD, JPY...) and currency names
 * (Euro, "Japanese Yen"...), and recognizes a glued 6-letter pair typed
 * directly (EURUSD, GBPJPY) as a single high-priority result.
 */
export async function searchForexPairs(query) {
  const q = query.trim();
  if (!q) return [];
  let currencies;
  try {
    currencies = await getForexCurrencies();
  } catch {
    return [];
  }
  const codes = Object.keys(currencies);
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  const results = [];
  const seen = new Set();
  const push = (base, quote) => {
    if (base === quote || !currencies[base] || !currencies[quote]) return;
    const id = forexCoinId(base, quote);
    if (seen.has(id)) return;
    seen.add(id);
    results.push({
      id,
      symbol: `${base}${quote}`,
      name: `${currencies[base]} / ${currencies[quote]}`,
      rank: null,
      thumb: null,
      large: null,
      isForex: true,
      forexBase: base,
      forexQuote: quote,
    });
  };

  // 1) Direct 6-letter pair typed as one token (EURUSD, eur/usd, EUR-USD...)
  const directPair = parseForexPairText(q);
  if (directPair && codes.includes(directPair.base) && codes.includes(directPair.quote)) {
    push(directPair.base, directPair.quote);
  }

  // 2) Currency code or name match -> pair that code against USD first (the
  // most useful default), then against a short list of other majors.
  const MAJORS = ["USD", "EUR", "GBP", "JPY"];
  const matchedCodes = codes.filter(
    (code) => code.includes(qUpper) || (currencies[code] || "").toLowerCase().includes(qLower)
  );
  for (const code of matchedCodes) {
    for (const major of MAJORS) {
      if (results.length >= 10) break;
      if (code === major) continue;
      push(code, major);
    }
    if (results.length >= 10) break;
  }

  return results.slice(0, 10);
}

/** Latest single rate for base/quote, e.g. how many `quote` per 1 `base`. */
export async function getForexLatestRate(base, quote) {
  const data = await fetchJson(`${FRANKFURTER_BASE}/latest?base=${base}&symbols=${quote}`, 60_000);
  return { rate: data.rates?.[quote] ?? null, date: data.date };
}

/**
 * Daily candle series for a forex pair over `days` calendar days back from
 * today. Each candle is built from one real published rate per working day:
 *   close = that day's rate
 *   open  = previous available day's rate (carried forward across
 *           weekends/holidays, when Frankfurter has no fresh rate)
 *   high/low = max/min(open, close) — the true range the daily reference
 *           rate is known to have crossed, with no fabricated intrabar
 *           movement.
 * Returns the same { time, open, high, low, close } shape as crypto candles
 * so the rest of the app (chart, backtest, indicators) needs no special
 * casing for forex.
 */
export async function getForexDailyCandles(base, quote, days = 365) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(7, Math.round(days)));
  const fmt = (d) => d.toISOString().slice(0, 10);

  const data = await fetchJson(
    `${FRANKFURTER_BASE}/${fmt(start)}..${fmt(end)}?base=${base}&symbols=${quote}`,
    5 * 60_000
  );

  const entries = Object.entries(data.rates || {})
    .map(([date, rates]) => ({ date, time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), rate: rates[quote] }))
    .filter((e) => Number.isFinite(e.rate))
    .sort((a, b) => a.time - b.time);

  if (!entries.length) throw new Error("No Frankfurter rates in range");

  const candles = [];
  let prevClose = entries[0].rate;
  for (const entry of entries) {
    const open = prevClose;
    const close = entry.rate;
    candles.push({
      time: entry.time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    });
    prevClose = close;
  }
  return candles;
}

export const FOREX_SOURCE_ID = "frankfurter";
export const FOREX_SOURCE_LABEL = "Frankfurter (ECB daily reference rate)";
