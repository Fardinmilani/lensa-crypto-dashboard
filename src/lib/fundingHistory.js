// Funding rate history from Binance USD-M public API.

import { fetchMarketJson } from "./coingecko.js";

function perpSymbol(pair) {
  const raw = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!raw) return null;
  if (raw.endsWith("USDT") || raw.endsWith("USDC")) return raw;
  return `${raw}USDT`;
}

export async function getFundingHistory(pair, limit = 100) {
  const symbol = perpSymbol(pair);
  if (!symbol) return { error: "no_symbol" };
  try {
    const rows = await fetchMarketJson(
      "binanceUsdFutures",
      `/fapi/v1/fundingRate?symbol=${symbol}&limit=${Math.min(limit, 1000)}`,
      30_000
    );
    if (!Array.isArray(rows)) return { error: "bad_response" };
    const history = rows.map((r) => ({
      time: Math.floor(Number(r.fundingTime) / 1000),
      rate: Number(r.fundingRate),
      apr: Number(r.fundingRate) * 3 * 365 * 100,
    }));
    return { symbol, history };
  } catch (err) {
    return { error: err?.message || "funding_unavailable" };
  }
}

export async function compareFundingVenues(pair) {
  const symbol = perpSymbol(pair);
  if (!symbol) return { error: "no_symbol" };
  const binance = await getFundingHistory(pair, 1);
  let bybit = null;
  try {
    const res = await fetch(
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`,
      { mode: "cors" }
    );
    if (res.ok) {
      const json = await res.json();
      const row = json?.result?.list?.[0];
      if (row) {
        const rate = Number(row.fundingRate);
        bybit = { rate, apr: rate * 3 * 365 * 100, time: Math.floor(Number(row.fundingRateTimestamp) / 1000) };
      }
    }
  } catch {
    /* optional */
  }
  const latest = binance.history?.at(-1);
  return {
    symbol,
    binance: latest ? { rate: latest.rate, apr: latest.apr } : null,
    bybit,
    spreadApr: latest && bybit ? (latest.apr - bybit.apr) : null,
  };
}
