// lib/irrfx.js
// Foreign currency vs the Iranian rial (USD/IRR and a handful of other
// majors), sourced from TGJU (tgju.org) -- the site the Iranian public and
// most community tools actually reference for these rates. TGJU publishes
// no official API, but its own site embeds a TradingView-style chart widget
// backed by a UDF-shaped (Universal Data Feed) JSON endpoint at
// platform.tgju.org, which this module calls.
//
// IMPORTANT HONESTY NOTE #1 -- two very different "USD/IRR" numbers exist:
// the free-market rate (بازار آزاد, what bonbast.com/tgju's front page and
// everyday Iranians quote) and the official/NIMA rate the government uses
// for import allocations, which can differ from the free-market rate by a
// large margin (multiples, not percentage points, historically). Both are
// exposed here as distinct, separately-labeled pairs (see RATE_TYPES) rather
// than picked for the user, since conflating them would misrepresent one as
// the other.
//
// IMPORTANT HONESTY NOTE #2 -- the free-market slugs below (PRICE_DOLLAR_RL
// etc.) are attested across several independent community references to
// TGJU's chart widget. The USD *official/NIMA* slug (PRICE_DOLLAR_NIMA) is
// this module's one unverified guess: TGJU documents nothing, and this
// patch was written in a sandbox with no network route to tgju.org, so it
// could not be exercised end-to-end. If getIrrFxDailyCandles("USD",
// "official", ...) throws or returns implausible numbers, open
// platform.tgju.org in a browser, watch the Network tab for the
// `/fa/tvdata/history?symbol=...` request its own NIMA-rate chart makes,
// and correct the slug below.
//
// Like lib/forex.js, this only ever produces DAILY candles -- TGJU's widget
// itself is daily-resolution for these symbols, and intraday timeframes are
// disabled for IRR-FX pairs in the UI (see MarketContext.jsx).

import { fetchJsonViaProxy } from "./corsProxy.js";

export const IRRFX_SOURCE_ID = "tgju";
export const IRRFX_SOURCE_LABEL = "TGJU (Iran currency market)";

const TGJU_BASE = "https://platform.tgju.org/fa/tvdata";

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 5 * 60_000;

async function fetchTgju(url, ttl = CACHE_TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const promise = fetchJsonViaProxy(IRRFX_SOURCE_ID, url)
    .then((data) => {
      cache.set(url, { data, time: Date.now() });
      return data;
    })
    .finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

export const RATE_TYPES = {
  free: "Free market",
  official: "Official / NIMA",
};

/** currency code -> { name, slugs: { free, official? } } */
const CURRENCIES = {
  USD: { name: "US Dollar", slugs: { free: "PRICE_DOLLAR_RL", official: "PRICE_DOLLAR_NIMA" } },
  EUR: { name: "Euro", slugs: { free: "PRICE_EUR" } },
  GBP: { name: "British Pound", slugs: { free: "PRICE_GBP" } },
  AED: { name: "UAE Dirham", slugs: { free: "PRICE_AED" } },
  TRY: { name: "Turkish Lira", slugs: { free: "PRICE_TRY" } },
};

const IRRFX_ID_PREFIX = "irrfx:";

export function irrFxCoinId(currency, rateType) {
  return `${IRRFX_ID_PREFIX}${currency}:${rateType}`;
}

export function isIrrFxCoinId(id) {
  return typeof id === "string" && id.startsWith(IRRFX_ID_PREFIX);
}

/** "irrfx:USD:free" -> { currency: "USD", rateType: "free" } or null */
export function parseIrrFxCoinId(id) {
  if (!isIrrFxCoinId(id)) return null;
  const [currency, rateType] = id.slice(IRRFX_ID_PREFIX.length).split(":");
  if (!CURRENCIES[currency]?.slugs?.[rateType]) return null;
  return { currency, rateType };
}

export function irrFxPairLabel(currency, rateType) {
  return `${currency}/IRR (${RATE_TYPES[rateType] || rateType})`;
}

const FA_KEYWORDS = ["ریال", "تومان", "دلار", "ارز", "یورو"];

/**
 * Free-text search over the small fixed currency list above, in the same
 * result shape searchCoins() returns for CoinGecko coins (see
 * lib/forex.js's searchForexPairs doc) so callers can merge lists with no
 * special-casing. Unlike forex.js this doesn't need an async currency-list
 * fetch first (the list here is small and static), but stays an `async`
 * function so call sites (Promise.allSettled alongside crypto/forex/TSE
 * search) don't need to special-case it either.
 */
export async function searchIrrFxPairs(query) {
  const q = query.trim();
  if (!q) return [];
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();
  const isGenericMatch =
    qLower.includes("irr") || qLower.includes("rial") || qLower.includes("toman") || FA_KEYWORDS.some((k) => q.includes(k));

  const results = [];
  for (const [code, info] of Object.entries(CURRENCIES)) {
    const matches = isGenericMatch || code.includes(qUpper) || info.name.toLowerCase().includes(qLower);
    if (!matches) continue;
    for (const rateType of Object.keys(info.slugs)) {
      results.push({
        id: irrFxCoinId(code, rateType),
        symbol: `${code}IRR`,
        name: irrFxPairLabel(code, rateType),
        rank: null,
        thumb: null,
        large: null,
        isIrrFx: true,
        irrFxCurrency: code,
        irrFxRateType: rateType,
      });
    }
    if (results.length >= 10) break;
  }
  return results.slice(0, 10);
}

/**
 * Daily candle series for `currency`/IRR at the given `rateType` ("free" or
 * "official"), over `days` calendar days back from today. TGJU's UDF-shaped
 * response is `{ s: "ok" | "no_data" | "error", t: [...unix seconds],
 * o/h/l/c: [...numbers], v: [...] }` -- one row per trading day TGJU has a
 * published rate for, so no candle-shape guessing is needed here the way
 * forex.js has to build open/high/low from a single daily rate.
 */
export async function getIrrFxDailyCandles(currency, rateType, days = 365) {
  const slug = CURRENCIES[currency]?.slugs?.[rateType];
  if (!slug) throw new Error(`Unknown IRR-FX pair ${currency}/${rateType}`);

  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.max(7, Math.round(days)) * 86400;
  const url = `${TGJU_BASE}/history?symbol=${encodeURIComponent(slug)}&resolution=D&from=${from}&to=${to}`;
  const data = await fetchTgju(url);

  if (data?.s !== "ok" || !Array.isArray(data.t) || !data.t.length) {
    throw new Error(`No TGJU data for ${slug} (status: ${data?.s ?? "unknown"})`);
  }

  const candles = data.t
    .map((t, i) => ({
      time: Math.round(Number(t)),
      open: Number(data.o?.[i]),
      high: Number(data.h?.[i]),
      low: Number(data.l?.[i]),
      close: Number(data.c?.[i]),
    }))
    .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error(`No usable TGJU candles for ${slug}`);
  return candles;
}

/** Latest close + previous close for base/quote change-percent math. */
export async function getIrrFxLatest(currency, rateType) {
  const candles = await getIrrFxDailyCandles(currency, rateType, 7);
  const last = candles.at(-1);
  const prev = candles.at(-2) ?? last;
  return { last, prev, candles };
}
