// lib/edge.js
// Professional post-backtest diagnostics. A high Sharpe on one path is not
// an edge — you need the distribution of paths, the path of each trade
// (MAE/MFE), a multiple-testing penalty, and a ruin probability at the
// size you actually intend to trade.
//
// None of this predicts the next candle. It answers: "if this rule's past
// trades are a reasonable sample of its live trades, what happens to
// capital?" That is the only honest way a client-side engine can talk
// about return.

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function std(a, m = mean(a)) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Acklam's inverse-normal approximation.
function inverseNormalCdf(p) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577509590705e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function consecutiveStreaks(trades) {
  let maxLoss = 0;
  let maxWin = 0;
  let curLoss = 0;
  let curWin = 0;
  for (const t of trades || []) {
    if ((t.pnlPercent || 0) > 0) {
      curWin += 1;
      curLoss = 0;
      if (curWin > maxWin) maxWin = curWin;
    } else {
      curLoss += 1;
      curWin = 0;
      if (curLoss > maxLoss) maxLoss = curLoss;
    }
  }
  return { maxConsecLosses: maxLoss, maxConsecWins: maxWin };
}

export function timeUnderwaterPercent(equityCurve) {
  if (!equityCurve?.length) return null;
  let peak = -Infinity;
  let underwater = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0 && p.equity < peak) underwater += 1;
  }
  return (underwater / equityCurve.length) * 100;
}

/**
 * Van Tharp System Quality Number: sqrt(N) * mean(trade%) / std(trade%).
 * <1 poor, 1–2 average, 2–3 good, 3–5 excellent, >5 usually overfit or too few trades.
 */
export function systemQualityNumber(trades) {
  const pnls = (trades || []).map((t) => Number(t.pnlPercent)).filter(Number.isFinite);
  if (pnls.length < 5) return null;
  const m = mean(pnls);
  const s = std(pnls, m);
  if (!(s > 0)) return null;
  return Math.sqrt(pnls.length) * (m / s);
}

export function marRatio({ totalReturnPercent, maxDrawdownPercent }) {
  if (!(maxDrawdownPercent > 0) || !Number.isFinite(totalReturnPercent)) return null;
  return totalReturnPercent / maxDrawdownPercent;
}

export function calmarRatio({ totalReturnPercent, maxDrawdownPercent, years }) {
  if (!(maxDrawdownPercent > 0) || !Number.isFinite(totalReturnPercent)) return null;
  const y = Number(years);
  const cagr = y > 0.15 ? (Math.pow(Math.max(0, 1 + totalReturnPercent / 100), 1 / y) - 1) * 100 : totalReturnPercent;
  return cagr / maxDrawdownPercent;
}

/**
 * Kelly fraction from win rate and payoff ratio. Capped half-Kelly is the
 * size professionals actually use; full Kelly is theoretically optimal and
 * practically too violent.
 */
export function kellyFraction({ winRatePercent, avgWin, avgLoss }) {
  const p = Number(winRatePercent) / 100;
  const win = Math.abs(Number(avgWin));
  const loss = Math.abs(Number(avgLoss));
  if (!(p > 0) || !(p < 1) || !(win > 0) || !(loss > 0)) {
    return { full: null, half: null, quarter: null, usable: null, payoff: null };
  }
  const b = win / loss;
  const full = p - (1 - p) / b;
  const half = full / 2;
  const quarter = full / 4;
  return {
    full,
    half,
    quarter,
    usable: Number.isFinite(full) ? Math.max(0, Math.min(0.25, half)) : null,
    payoff: b,
  };
}

/**
 * Harvey / Liu / Zhu (2016) Deflated Sharpe Ratio.
 * `nTrials` = how many strategies/param sets you peeked at before picking
 * this Sharpe. PSR/DSR below ~0.95 means the number is not distinguishable
 * from the best of luck.
 */
export function deflatedSharpeRatio({ sharpe, nObs, nTrials = 1, skew = 0, kurtosis = 3 }) {
  const sr = Number(sharpe);
  const n = Number(nObs);
  const k = Math.max(1, Math.round(Number(nTrials) || 1));
  if (!Number.isFinite(sr) || !(n > 2)) return null;
  const euler = 0.5772156649;
  let sr0 = 0;
  if (k > 1) {
    const inv = 1 / k;
    const z1 = inverseNormalCdf(Math.min(0.999999, Math.max(1e-12, 1 - inv)));
    const z2 = inverseNormalCdf(Math.min(0.999999, Math.max(1e-12, 1 - inv / Math.E)));
    sr0 = Math.sqrt(1 / n) * ((1 - euler) * z1 + euler * z2);
  }
  const se = Math.sqrt(Math.max(1e-12, (1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr) / (n - 1)));
  const tstat = (sr - sr0) / se;
  const dsr = normalCdf(tstat);
  return { sr0, dsr, tstat, likelyOverfit: dsr < 0.95 };
}

function findCandleIndex(candles, time) {
  if (time == null || !candles?.length) return -1;
  let best = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= time) best = i;
    else break;
  }
  return best;
}

/**
 * Maximum Adverse / Favorable Excursion per trade. This is how you set
 * stops and targets from the tape instead of round numbers: if 75% of
 * winners never went more than X% against you, a stop at X% is tight
 * enough; if typical MFE is Y% and you realize much less, you are
 * leaving money on the table (or have no target discipline).
 */
export function maeMfeAnalysis(trades, candles) {
  const rows = [];
  for (const trade of trades || []) {
    if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;
    const i0 = findCandleIndex(candles, trade.entryTime);
    const i1 = findCandleIndex(candles, trade.exitTime);
    if (i0 < 0 || i1 < i0) continue;
    const side = trade.side === -1 ? -1 : 1;
    let mae = 0;
    let mfe = 0;
    for (let i = i0; i <= i1; i++) {
      const { high, low } = candles[i];
      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
      const adverse = side === 1
        ? ((trade.entryPrice - low) / trade.entryPrice) * 100
        : ((high - trade.entryPrice) / trade.entryPrice) * 100;
      const favorable = side === 1
        ? ((high - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - low) / trade.entryPrice) * 100;
      if (adverse > mae) mae = adverse;
      if (favorable > mfe) mfe = favorable;
    }
    const realized = Number(trade.pnlPercent) || 0;
    rows.push({
      ...trade,
      mae,
      mfe,
      giveback: mfe > 0 ? Math.max(0, (mfe - Math.max(0, realized)) / mfe) : null,
      captured: mfe > 0 ? Math.max(0, realized) / mfe : null,
    });
  }
  if (!rows.length) return { error: "no_trades", rows: [] };
  const maes = rows.map((r) => r.mae).sort((a, b) => a - b);
  const mfes = rows.map((r) => r.mfe).sort((a, b) => a - b);
  const avgMae = mean(rows.map((r) => r.mae));
  const avgMfe = mean(rows.map((r) => r.mfe));
  return {
    rows,
    avgMae,
    avgMfe,
    edgeRatio: avgMae > 0 ? avgMfe / avgMae : null,
    stopHint: percentile(maes, 0.75),
    targetHint: percentile(mfes, 0.5),
    avgGiveback: mean(rows.map((r) => r.giveback).filter((x) => x != null)),
    avgCaptured: mean(rows.map((r) => r.captured).filter((x) => x != null)),
  };
}

/**
 * Resample the *trade list* (not prices). This answers: given this
 * strategy's actual round-trips, how often does a shuffled sequence
 * draw down 20/30/40%? Price-path Monte Carlo cannot see clustering of
 * losses that a real rule produces.
 */
export function tradeSequenceMonteCarlo(trades, {
  sims = 2500,
  initialCapital = 10000,
  ruinDrawdownPercent = 40,
  seed = 7,
} = {}) {
  const pnls = (trades || []).map((t) => Number(t.pnlPercent) / 100).filter(Number.isFinite);
  if (pnls.length < 5) return { error: "need_trades" };
  const rng = mulberry32(seed);
  const terminals = [];
  const maxDDs = [];
  let ruinCount = 0;
  let dd20 = 0;
  let dd30 = 0;
  const n = pnls.length;
  for (let s = 0; s < sims; s++) {
    let eq = initialCapital;
    let peak = eq;
    let maxDD = 0;
    let ruined = false;
    for (let i = 0; i < n; i++) {
      eq = Math.max(0, eq * (1 + pnls[Math.floor(rng() * n)]));
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
      if (dd >= ruinDrawdownPercent) ruined = true;
    }
    terminals.push(eq);
    maxDDs.push(maxDD);
    if (ruined) ruinCount += 1;
    if (maxDD >= 20) dd20 += 1;
    if (maxDD >= 30) dd30 += 1;
  }
  terminals.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  return {
    sims,
    tradeCount: n,
    medianTerminal: percentile(terminals, 0.5),
    p5Terminal: percentile(terminals, 0.05),
    p95Terminal: percentile(terminals, 0.95),
    medianMaxDD: percentile(maxDDs, 0.5),
    pDD20: dd20 / sims,
    pDD30: dd30 / sims,
    pRuin: ruinCount / sims,
    ruinDrawdownPercent,
    initialCapital,
  };
}

/**
 * Scale historical all-in trade returns by a risk fraction and find the
 * largest fraction whose resampled P(ruin) stays under the tolerance.
 * Returns a recommended % of the all-in size, not a guarantee.
 */
export function recommendedRiskFraction(trades, {
  initialCapital = 10000,
  ruinDrawdownPercent = 40,
  maxRuinProb = 0.05,
  sims = 800,
  seed = 11,
} = {}) {
  const pnls = (trades || []).map((t) => Number(t.pnlPercent) / 100).filter(Number.isFinite);
  if (pnls.length < 5) return { error: "need_trades" };
  let lo = 0.02;
  let hi = 1;
  let best = lo;
  for (let step = 0; step < 10; step++) {
    const mid = (lo + hi) / 2;
    const scaled = pnls.map((r) => ({ pnlPercent: r * mid * 100 }));
    const mc = tradeSequenceMonteCarlo(scaled, { sims, initialCapital, ruinDrawdownPercent, seed });
    if (mc.error) return mc;
    if (mc.pRuin <= maxRuinProb) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return {
    fraction: best,
    percentOfAllIn: best * 100,
    maxRuinProb,
    ruinDrawdownPercent,
  };
}

export function volatilityTargetNotional({ candles, accountSize = 10000, targetAnnualVol = 0.15, periodsPerYear }) {
  const closes = (candles || []).map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 20) return { error: "need_candles" };
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const vol = std(rets) * Math.sqrt(periodsPerYear || 365);
  if (!(vol > 0)) return { error: "zero_vol" };
  const scaler = targetAnnualVol / vol;
  return {
    realizedVol: vol,
    targetAnnualVol,
    scaler,
    notional: accountSize * scaler,
    notionalPercent: scaler * 100,
  };
}

export function sampleYears(candles) {
  if (!candles || candles.length < 2) return null;
  const dt = candles[candles.length - 1].time - candles[0].time;
  if (!(dt > 0)) return null;
  return dt / (365.25 * 24 * 3600);
}

export function enrichBacktest(result, candles, { nTrials = 1 } = {}) {
  if (!result || result.error) return null;
  const trades = result.trades || [];
  const years = sampleYears(candles);
  const nObs = Math.max(2, (result.equityCurve?.length || 0) - 1);
  const kelly = kellyFraction({
    winRatePercent: result.winRate,
    avgWin: result.avgWin,
    avgLoss: result.avgLoss,
  });
  const sqn = systemQualityNumber(trades);
  return {
    sqn,
    mar: marRatio(result),
    calmar: calmarRatio({ ...result, years }),
    kelly,
    streaks: consecutiveStreaks(trades),
    underwater: timeUnderwaterPercent(result.equityCurve),
    dsr: Number.isFinite(result.sharpe) ? deflatedSharpeRatio({ sharpe: result.sharpe, nObs, nTrials }) : null,
    maeMfe: maeMfeAnalysis(trades, candles),
    tradeMc: tradeSequenceMonteCarlo(trades, { initialCapital: result.initialCapital || 10000 }),
    riskBudget: recommendedRiskFraction(trades, { initialCapital: result.initialCapital || 10000 }),
    years,
  };
}
