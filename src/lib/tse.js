// lib/tse.js
// Tehran Stock Exchange (TSETMC) instrument search and daily OHLC candles,
// sourced from TSETMC's own JSON REST API at cdn.tsetmc.com/api/*.
//
// IMPORTANT HONESTY NOTE: TSETMC publishes no official API documentation.
// Every endpoint path and field name below comes from community
// reverse-engineering of the site (several independent write-ups and
// open-source TSE client libraries agree on the field-naming convention:
// pClosing/priceFirst/priceMax/priceMin/dEven for a day's OHLC, and
// lVal18AFC/lVal30/insCode for instrument identity), which gives reasonable
// -- not certain -- confidence. This patch was written in a sandbox with no
// outbound network route to tsetmc.com, so none of this could be exercised
// against the live service. Please smoke-test after deploying; if a search
// or candle request comes back empty, the response-shape guards below
// (the `?? []` / multi-key fallbacks) are the first place to adjust once
// you can see the actual JSON in a browser Network tab.
//
// Like lib/forex.js, this only ever produces DAILY candles. TSETMC's
// intraday tick feed lives behind a different, even-less-documented
// endpoint, and mixing an unverified intraday source into a financial
// chart felt like the wrong trade-off here. Intraday timeframes are
// disabled for TSE symbols in the UI (see MarketContext.jsx), same as
// forex and IRR-FX.

import { fetchJsonViaProxy } from "./corsProxy.js";

export const TSE_SOURCE_ID = "tsetmc"; // must match cloudflare-proxy/worker.js UPSTREAMS key
export const TSE_SOURCE_LABEL = "Tehran Stock Exchange (TSETMC)";

const TSETMC_BASE = "https://cdn.tsetmc.com/api";

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 60_000;

async function fetchTsetmc(url, ttl = CACHE_TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const promise = fetchJsonViaProxy(TSE_SOURCE_ID, url)
    .then((data) => {
      cache.set(url, { data, time: Date.now() });
      return data;
    })
    .finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

const TSE_ID_PREFIX = "tse:";

export function tseCoinId(insCode, symbol) {
  return `${TSE_ID_PREFIX}${insCode}:${symbol}`;
}

export function isTseCoinId(id) {
  return typeof id === "string" && id.startsWith(TSE_ID_PREFIX);
}

/** "tse:12345:فملی" -> { insCode: "12345", symbol: "فملی" } or null */
export function parseTseCoinId(id) {
  if (!isTseCoinId(id)) return null;
  const rest = id.slice(TSE_ID_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const insCode = rest.slice(0, sep);
  const symbol = rest.slice(sep + 1);
  if (!insCode || !symbol) return null;
  return { insCode, symbol };
}

let instrumentListPromise = null;

/**
 * The full list of currently-listed TSETMC instruments (InsCode + symbol +
 * company name), fetched once per session and cached in memory -- the same
 * "load the reference list once, search it locally" approach lib/forex.js
 * uses for currency codes. This uses `GetMarketWatch` (the same bulk feed
 * TSETMC's own market-watch page loads) rather than a per-keystroke search
 * endpoint, since `GetMarketWatch`'s shape is comparatively well attested
 * in community write-ups, while TSETMC's dedicated instrument-search
 * endpoint takes an undocumented parameter this module can't confirm
 * without live access.
 */
async function getInstrumentList() {
  if (!instrumentListPromise) {
    instrumentListPromise = fetchTsetmc(`${TSETMC_BASE}/ClosingPrice/GetMarketWatch`, 10 * 60_000)
      .then((data) => {
        const rows = data?.marketwatch ?? data?.instrumentList ?? data?.data ?? (Array.isArray(data) ? data : []);
        return rows
          .map((r) => ({
            insCode: String(r.insCode ?? r.InsCode ?? r.instrumentID ?? ""),
            symbol: r.lVal18AFC ?? r.symbol ?? "",
            name: r.lVal30 ?? r.name ?? "",
          }))
          .filter((r) => r.insCode && r.symbol);
      })
      .catch((err) => {
        instrumentListPromise = null;
        throw err;
      });
  }
  return instrumentListPromise;
}

/**
 * Free-text TSE symbol/company-name search (Persian or Latin transliteration
 * as typed by the user), in the same result shape searchCoins() returns for
 * CoinGecko coins so callers can merge lists with no special-casing.
 */
export async function searchTseSymbols(query) {
  const q = query.trim();
  if (!q) return [];
  let instruments;
  try {
    instruments = await getInstrumentList();
  } catch (err) {
    // Swallowed on purpose for the caller (an empty search result, not a
    // thrown error, is the right UX for "start typing" search-as-you-go) --
    // but NOT silently: log it so a real outage is visible in devtools
    // instead of just looking like "no matches".
    console.warn("[tse] instrument search unavailable:", err);
    return [];
  }
  const matches = instruments.filter((i) => i.symbol.includes(q) || i.name.includes(q));
  return matches.slice(0, 10).map((i) => ({
    id: tseCoinId(i.insCode, i.symbol),
    symbol: i.symbol,
    name: i.name || i.symbol,
    rank: null,
    thumb: null,
    large: null,
    isTse: true,
    tseInsCode: i.insCode,
  }));
}

/**
 * Daily OHLC candle series for a TSE instrument (`insCode`), over `days`
 * calendar days back from today, from TSETMC's per-day closing-price
 * history endpoint. `dEven` is an 8-digit **Gregorian** date (YYYYMMDD --
 * e.g. 20230524 for 2023-05-24), not a Jalali/Shamsi date, despite this
 * being an Iranian data source.
 */
export async function getTseDailyCandles(insCode, days = 365) {
  if (!insCode) throw new Error("getTseDailyCandles requires an insCode");
  // TSETMC's `:Top` path segment is reverse-engineered as "most recent N
  // daily rows"; padded a bit above the requested window and capped so a
  // very long lookback doesn't request an unbounded number of rows.
  const top = Math.min(5000, Math.max(90, Math.round(days) + 30));
  const data = await fetchTsetmc(`${TSETMC_BASE}/ClosingPrice/GetClosingPriceDailyList/${insCode}/${top}`, 5 * 60_000);
  const rows = data?.closingPriceDaily ?? data?.data ?? (Array.isArray(data) ? data : []);
  if (!rows.length) throw new Error(`No TSETMC daily history for InsCode ${insCode}`);

  const cutoffMs = Date.now() - Math.max(7, Math.round(days)) * 86_400_000;
  const candles = rows
    .map((r) => {
      const s = String(r.dEven ?? "");
      if (s.length !== 8) return null;
      const year = Number(s.slice(0, 4));
      const month = Number(s.slice(4, 6));
      const day = Number(s.slice(6, 8));
      const time = Math.floor(Date.UTC(year, month - 1, day) / 1000);
      return {
        time,
        open: Number(r.priceFirst),
        high: Number(r.priceMax),
        low: Number(r.priceMin),
        close: Number(r.pClosing),
      };
    })
    .filter((c) => c && Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .filter((c) => c.time * 1000 >= cutoffMs)
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error(`No usable TSETMC candles for InsCode ${insCode}`);
  return candles;
}

/** Latest and previous daily candle, for change-percent math. */
export async function getTseLatest(insCode) {
  const candles = await getTseDailyCandles(insCode, 14);
  const last = candles.at(-1);
  const prev = candles.at(-2) ?? last;
  return { last, prev, candles };
}
