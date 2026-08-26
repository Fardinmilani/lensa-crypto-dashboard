// Combined equity curve for a weighted basket of assets.

function alignReturnSeries(candleSets) {
  const byTime = new Map();
  for (const { key, candles } of candleSets) {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      if (prev.close <= 0 || cur.close <= 0) continue;
      const ret = cur.close / prev.close - 1;
      const row = byTime.get(cur.time) || { time: cur.time };
      row[key] = ret;
      byTime.set(cur.time, row);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function runPortfolioBacktest({
  candleSets,
  weights,
  initialCapital = 10000,
  rebalanceDays = null,
  feePercent = 0.05,
}) {
  const keys = candleSets.map((c) => c.key);
  const wSum = keys.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const w = {};
  for (const k of keys) w[k] = (weights[k] ?? 0) / wSum;

  const rows = alignReturnSeries(candleSets);
  if (!rows.length) return { error: "no_aligned_data" };

  const equityCurve = [];
  let equity = initialCapital;
  let dayCounter = 0;
  let currentW = { ...w };

  for (const row of rows) {
    dayCounter++;
    if (rebalanceDays && dayCounter >= rebalanceDays) {
      currentW = { ...w };
      dayCounter = 0;
      equity *= 1 - feePercent / 100;
    }
    let portRet = 0;
    for (const k of keys) {
      if (row[k] != null) portRet += (currentW[k] ?? 0) * row[k];
    }
    equity *= 1 + portRet;
    equityCurve.push({ time: row.time, equity });
  }

  const totalReturnPercent = ((equity - initialCapital) / initialCapital) * 100;
  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  return {
    equityCurve,
    initialCapital,
    finalEquity: equity,
    totalReturnPercent,
    maxDrawdownPercent,
    weights: w,
    barCount: equityCurve.length,
  };
}

export function estimateVolatility(closes, window = 30) {
  if (!closes || closes.length < window + 1) return null;
  const rets = [];
  for (let i = closes.length - window; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const var_ = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(var_) * Math.sqrt(252) * 100;
}
