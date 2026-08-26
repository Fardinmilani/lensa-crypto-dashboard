// Rolling Sharpe proxy and drawdown from an equity curve.

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

export function rollingMetrics(equityCurve, window = 30) {
  if (!equityCurve?.length || equityCurve.length < window + 1) return [];
  const out = [];
  for (let i = window; i < equityCurve.length; i++) {
    const slice = equityCurve.slice(i - window, i + 1);
    const rets = [];
    for (let j = 1; j < slice.length; j++) {
      const prev = slice[j - 1].equity;
      if (prev > 0) rets.push(slice[j].equity / prev - 1);
    }
    const sharpe = std(rets) > 0 ? (mean(rets) / std(rets)) * Math.sqrt(252) : null;
    let peak = -Infinity;
    let maxDd = 0;
    for (const p of slice) {
      if (p.equity > peak) peak = p.equity;
      const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    out.push({ time: equityCurve[i].time, rollingSharpe: sharpe, rollingMaxDd: maxDd });
  }
  return out;
}
