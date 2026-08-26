// Pearson correlation and relative-strength helpers for aligned return series.

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const xs = a.slice(-n);
  const ys = b.slice(-n);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = xs[i] - mx;
    const vy = ys[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

/** Align two candle arrays by timestamp; return overlapping closes. */
export function alignClosesByTime(candlesA, candlesB) {
  const mapB = new Map(candlesB.map((c) => [c.time, c.close]));
  const a = [];
  const b = [];
  for (const c of candlesA) {
    const other = mapB.get(c.time);
    if (other != null && c.close > 0 && other > 0) {
      a.push(c.close);
      b.push(other);
    }
  }
  return { a, b };
}

export function correlationMatrix(seriesByKey, window = null) {
  const keys = Object.keys(seriesByKey);
  const matrix = {};
  for (const k of keys) matrix[k] = {};
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      const ki = keys[i];
      const kj = keys[j];
      if (i === j) {
        matrix[ki][kj] = 1;
        continue;
      }
      let ra = logReturns(seriesByKey[ki]);
      let rb = logReturns(seriesByKey[kj]);
      if (window && window > 0) {
        ra = ra.slice(-window);
        rb = rb.slice(-window);
      }
      matrix[ki][kj] = pearson(ra, rb);
    }
  }
  return { keys, matrix };
}

/** Cumulative return ratio: asset A vs B over the last `window` bars. */
export function relativeStrength(closesA, closesB, window = 30) {
  if (!closesA?.length || !closesB?.length) return null;
  const n = Math.min(closesA.length, closesB.length, window);
  if (n < 2) return null;
  const startA = closesA[closesA.length - n];
  const endA = closesA[closesA.length - 1];
  const startB = closesB[closesB.length - n];
  const endB = closesB[closesB.length - 1];
  if (startA <= 0 || startB <= 0) return null;
  const retA = (endA / startA - 1) * 100;
  const retB = (endB / startB - 1) * 100;
  return { retA, retB, spread: retA - retB, ratio: endA / endB };
}

export function normalizeTo100(closes) {
  if (!closes?.length) return [];
  const base = closes.find((c) => c > 0) ?? closes[0];
  if (!base || base <= 0) return [];
  return closes.map((c) => (c / base) * 100);
}

export function ratioSeries(closesA, closesB) {
  const n = Math.min(closesA?.length ?? 0, closesB?.length ?? 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (closesB[i] > 0) out.push(closesA[i] / closesB[i]);
  }
  return out;
}
