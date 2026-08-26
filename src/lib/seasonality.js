// Calendar / seasonality stats from daily (or any) candle history.

function barReturn(c) {
  if (!c?.open || !c?.close || c.open <= 0) return null;
  return ((c.close - c.open) / c.open) * 100;
}

function groupStats(groups) {
  return Object.entries(groups).map(([key, vals]) => {
    const clean = vals.filter((v) => Number.isFinite(v));
    if (!clean.length) return { key, count: 0, avg: null, winRate: null };
    const avg = clean.reduce((s, v) => s + v, 0) / clean.length;
    const wins = clean.filter((v) => v > 0).length;
    return { key, count: clean.length, avg, winRate: (wins / clean.length) * 100 };
  });
}

export function seasonalityAnalysis(candles) {
  if (!candles?.length) return { error: "no_data" };
  const byDow = {};
  const byMonth = {};
  for (const c of candles) {
    const ret = barReturn(c);
    if (ret == null) continue;
    const d = new Date(c.time * 1000);
    const dow = d.getUTCDay();
    const month = d.getUTCMonth();
    (byDow[dow] ??= []).push(ret);
    (byMonth[month] ??= []).push(ret);
  }
  return {
    dayOfWeek: groupStats(byDow).sort((a, b) => Number(a.key) - Number(b.key)),
    month: groupStats(byMonth).sort((a, b) => Number(a.key) - Number(b.key)),
    sampleSize: candles.length,
  };
}

export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
