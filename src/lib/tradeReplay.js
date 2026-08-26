export function barTime(t) {
  return Math.floor(t > 1e11 ? t / 1000 : t);
}

export function normalizeCandles(candles) {
  if (!candles?.length) return [];
  const points = candles
    .filter((c) => c && Number.isFinite(c.time) && Number.isFinite(c.close))
    .map((c) => ({
      time: barTime(c.time),
      open: c.open ?? c.close,
      high: c.high ?? c.close,
      low: c.low ?? c.close,
      close: c.close,
    }))
    .sort((a, b) => a.time - b.time);

  const deduped = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === point.time) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return deduped;
}

export function findBarIndex(candles, targetTime) {
  const t = barTime(targetTime);
  let idx = candles.findIndex((c) => c.time === t);
  if (idx >= 0) return idx;
  idx = candles.findIndex((c) => c.time >= t);
  if (idx >= 0) return idx;
  return candles.length - 1;
}

export function snapToBarTime(candles, targetTime) {
  if (!candles.length) return barTime(targetTime);
  return candles[findBarIndex(candles, targetTime)].time;
}

export function sliceTradeWindow(candles, trade, pad = 12) {
  if (!candles.length || !trade) return { window: [], entryIdx: 0, exitIdx: 0 };
  const entryIdx = findBarIndex(candles, trade.entryTime);
  const exitIdx = findBarIndex(candles, trade.exitTime);
  const i0 = Math.max(0, entryIdx - pad);
  const i1 = Math.min(candles.length - 1, exitIdx + pad);
  return {
    window: candles.slice(i0, i1 + 1),
    entryIdx: entryIdx - i0,
    exitIdx: exitIdx - i0,
  };
}

export function filterTrades(trades, filter) {
  if (filter === "wins") return trades.filter((t) => t.pnlPercent > 0);
  if (filter === "losses") return trades.filter((t) => t.pnlPercent <= 0);
  return trades;
}

export function tradeDurationBars(trade, candles) {
  if (!trade || !candles?.length) return null;
  const i0 = findBarIndex(candles, trade.entryTime);
  const i1 = findBarIndex(candles, trade.exitTime);
  if (i0 < 0 || i1 < i0) return null;
  return i1 - i0 + 1;
}

export function riskGuidePrices(trade, riskParams, leverage = 1) {
  if (!trade?.entryPrice || !riskParams) return null;
  const lev = Math.max(1, Number(leverage) || 1);
  const side = (trade.side ?? 1) >= 0 ? 1 : -1;
  const toUnderlying = (pct) => (pct == null ? null : Math.min(Number(pct), 100) / lev);
  const sl = toUnderlying(riskParams.stopLossPercent);
  const tp = toUnderlying(riskParams.takeProfitPercent);
  const out = {};
  if (sl != null) out.stop = trade.entryPrice * (1 - (sl / 100) * side);
  if (tp != null) out.target = trade.entryPrice * (1 + (tp / 100) * side);
  return out;
}
