// Iran macro snapshot — USD/EUR IRR (free market) via existing irrfx module.

import { getIrrFxDailyCandles, searchIrrFxPairs } from "./irrfx.js";

export async function fetchMacroSnapshot() {
  const pairs = searchIrrFxPairs("").filter((p) => p.rateType === "free").slice(0, 6);
  const rows = [];
  for (const p of pairs) {
    try {
      const candles = await getIrrFxDailyCandles(p.currency, p.rateType, 60);
      if (!candles?.length) continue;
      const last = candles.at(-1);
      const prev = candles.at(-2);
      const change = prev?.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null;
      const monthAgo = candles[Math.max(0, candles.length - 22)];
      const change30 = monthAgo?.close > 0 ? ((last.close - monthAgo.close) / monthAgo.close) * 100 : null;
      rows.push({
        id: p.id,
        label: p.label,
        currency: p.currency,
        price: last.close,
        change1d: change,
        change30d: change30,
      });
    } catch {
      /* skip failed pair */
    }
  }
  return { rows, updatedAt: Date.now() };
}
