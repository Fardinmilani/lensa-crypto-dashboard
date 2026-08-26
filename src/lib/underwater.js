// Drawdown underwater curve and recovery stats.

export function underwaterEquity(equityCurve) {
  if (!equityCurve?.length) return { points: [], recoveries: [] };
  let peak = -Infinity;
  const points = [];
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const underwater = peak > 0 ? ((p.equity - peak) / peak) * 100 : 0;
    points.push({ time: p.time, equity: p.equity, peak, underwater });
  }

  const recoveries = [];
  let inDd = false;
  let ddStart = null;
  let maxDd = 0;
  for (const p of points) {
    if (p.underwater < -0.01) {
      if (!inDd) {
        inDd = true;
        ddStart = p.time;
        maxDd = p.underwater;
      } else if (p.underwater < maxDd) maxDd = p.underwater;
    } else if (inDd) {
      recoveries.push({ start: ddStart, end: p.time, maxDrawdownPercent: Math.abs(maxDd) });
      inDd = false;
      maxDd = 0;
    }
  }
  if (inDd) recoveries.push({ start: ddStart, end: null, maxDrawdownPercent: Math.abs(maxDd), open: true });

  return { points, recoveries };
}
