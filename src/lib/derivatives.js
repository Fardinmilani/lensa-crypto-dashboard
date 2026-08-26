// lib/derivatives.js
// Crypto-specific *positioning* tape from Binance USD-M public endpoints.
// Funding, open interest, and long/short account ratio are the closest
// thing retail gets to "who is crowded" without an order book.
//
// These are not directional oracles. Extreme positive funding + elevated
// long ratio is a crowded-long warning (squeeze risk), not a short signal
// by itself. All calls are optional: if Binance is geo-blocked in the
// browser they fail closed and the Edge Lab simply hides the crowd panel.

import { fetchMarketJson } from "./coingecko.js";

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function perpSymbol(pair) {
  const raw = String(pair || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!raw) return null;
  if (raw.endsWith("USD_PERP")) return raw.replace(/USD_PERP$/, "USDT");
  if (raw.endsWith("USDT") || raw.endsWith("USDC")) return raw;
  return `${raw}USDT`;
}

/**
 * Snapshot of crowding for a USD-M perpetual. Spot-only assets still get
 * a read on the corresponding USDT perp when one exists.
 */
export async function getCrowdSnapshot(pair) {
  const symbol = perpSymbol(pair);
  if (!symbol) return { error: "no_symbol" };
  try {
    const [premium, oi, ls, taker] = await Promise.all([
      fetchMarketJson("binanceUsdFutures", `/fapi/v1/premiumIndex?symbol=${symbol}`, 20_000),
      fetchMarketJson("binanceUsdFutures", `/fapi/v1/openInterest?symbol=${symbol}`, 20_000),
      fetchMarketJson("binanceUsdFutures", `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=4h&limit=24`, 30_000).catch(() => null),
      fetchMarketJson("binanceUsdFutures", `/futures/data/takerlongshortRatio?symbol=${symbol}&period=4h&limit=24`, 30_000).catch(() => null),
    ]);

    const lastFunding = num(premium?.lastFundingRate);
    const mark = num(premium?.markPrice);
    const index = num(premium?.indexPrice);
    const nextFunding = num(premium?.nextFundingTime);
    // 3 funding windows/day → annualize the last rate.
    const fundingApr = lastFunding != null ? lastFunding * 3 * 365 * 100 : null;
    const longShort = Array.isArray(ls) && ls.length ? ls[ls.length - 1] : null;
    const takerLast = Array.isArray(taker) && taker.length ? taker[taker.length - 1] : null;
    const longAccount = num(longShort?.longAccount ?? longShort?.longAccountRatio);
    const shortAccount = num(longShort?.shortAccount ?? longShort?.shortAccountRatio);
    const lsRatio = num(longShort?.longShortRatio) ?? (shortAccount > 0 && longAccount != null ? longAccount / shortAccount : null);
    const takerRatio = num(takerLast?.buySellRatio);

    let crowding = "neutral";
    if (fundingApr != null && fundingApr > 25 && (lsRatio == null || lsRatio > 1.2)) crowding = "crowded_long";
    else if (fundingApr != null && fundingApr < -15 && (lsRatio == null || lsRatio < 0.85)) crowding = "crowded_short";
    else if (fundingApr != null && Math.abs(fundingApr) > 40) crowding = "crowded_long";

    return {
      symbol,
      mark,
      index,
      basisPct: mark && index ? ((mark - index) / index) * 100 : null,
      lastFunding,
      fundingApr,
      nextFunding,
      openInterest: num(oi?.openInterest),
      lsRatio,
      longAccount,
      takerRatio,
      crowding,
    };
  } catch (err) {
    return { error: err?.message || "crowd_unavailable" };
  }
}

export function crowdingPermission(crowd, intendedSide) {
  if (!crowd || crowd.error) return null;
  const side = String(intendedSide || "").toLowerCase();
  if (crowd.crowding === "crowded_long" && (side === "long" || side === "buy")) {
    return { action: "reduce", reason: "crowded_long" };
  }
  if (crowd.crowding === "crowded_short" && (side === "short" || side === "sell")) {
    return { action: "reduce", reason: "crowded_short" };
  }
  return { action: "ok", reason: crowd.crowding };
}
