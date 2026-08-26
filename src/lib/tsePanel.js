import { getTseDailyCandles, searchTseSymbols } from "./tse.js";

export async function fetchTseComparison(querySymbols, lookbackDays = 90) {
  const rows = [];
  for (const sym of querySymbols) {
    try {
      const hits = await searchTseSymbols(sym);
      const hit = hits.find((h) => h.symbol === sym) || hits[0];
      if (!hit?.tseInsCode) continue;
      const candles = await getTseDailyCandles(hit.tseInsCode, lookbackDays);
      if (!candles?.length) continue;
      const last = candles.at(-1);
      const first = candles[0];
      const ret = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : null;
      rows.push({ symbol: hit.symbol, label: hit.name, last: last.close, returnPct: ret, bars: candles.length });
    } catch {
      /* skip */
    }
  }
  return { rows };
}

export async function defaultTseWatchlist() {
  return searchTseSymbols("فملی").then((r) => r.slice(0, 5).map((x) => x.symbol));
}
