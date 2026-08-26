// lib/regime.js
// Market-regime classifier. A strategy's backtest average is almost never
// what you get live — edges cluster in a few regimes and vanish in others.
// Classifying each bar (trend / range / shock) is how you decide whether
// today's tape even resembles the tape the strategy was measured on.
//
// This is a transparent 2-axis label, not a hidden Markov model:
//   - Direction from EMA structure + DI
//   - Energy from Wilder ADX and ATR percentile
// Shock (extreme realized range) overrides direction because both trend
// followers and mean-reverters typically bleed in a vol explosion.

import { ema, atr as wilderAtr } from "./strategies.js";

export const REGIME = Object.freeze({
  TREND_UP: "trend_up",
  TREND_DOWN: "trend_down",
  RANGE: "range",
  SHOCK: "shock",
});

export const REGIME_LABELS = Object.freeze({
  trend_up: { en: "Trend up", fa: "روند صعودی" },
  trend_down: { en: "Trend down", fa: "روند نزولی" },
  range: { en: "Range / chop", fa: "رنج / خنثی" },
  shock: { en: "Vol shock", fa: "شوک نوسان" },
});

const ADX_TREND = 20;
const SHOCK_PCT = 0.9;

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

/**
 * Wilder ADX / +DI / −DI. Returns arrays aligned with `candles` (leading
 * nulls until the smoother has enough history).
 */
export function adxSeries(candles, period = 14) {
  const n = candles.length;
  const plusDi = new Array(n).fill(null);
  const minusDi = new Array(n).fill(null);
  const adx = new Array(n).fill(null);
  if (n < period * 2 + 1) return { plusDi, minusDi, adx };

  const plusDM = [];
  const minusDM = [];
  const tr = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }

  let smTR = mean(tr.slice(0, period));
  let smP = mean(plusDM.slice(0, period));
  let smM = mean(minusDM.slice(0, period));
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    smTR = smTR - smTR / period + tr[i];
    smP = smP - smP / period + plusDM[i];
    smM = smM - smM / period + minusDM[i];
    const pdi = smTR > 0 ? (100 * smP) / smTR : 0;
    const mdi = smTR > 0 ? (100 * smM) / smTR : 0;
    const denom = pdi + mdi;
    dx.push(denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0);
    const candleIndex = i + 1;
    plusDi[candleIndex] = pdi;
    minusDi[candleIndex] = mdi;
  }

  if (dx.length < period) return { plusDi, minusDi, adx };
  let smAdx = mean(dx.slice(0, period));
  const adxStart = period * 2;
  adx[adxStart] = smAdx;
  for (let i = period; i < dx.length; i++) {
    smAdx = (smAdx * (period - 1) + dx[i]) / period;
    adx[period + 1 + i] = smAdx;
  }
  return { plusDi, minusDi, adx };
}

function percentileRank(sorted, value) {
  if (!sorted.length) return 0.5;
  let lo = 0;
  for (const x of sorted) if (x <= value) lo += 1;
  return lo / sorted.length;
}

/**
 * Per-bar regime labels. Early bars stay `null` until indicators warm up.
 */
export function classifyRegimes(candles, { adxPeriod = 14, atrPeriod = 14, emaFast = 21, emaSlow = 55 } = {}) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < emaSlow + 2) return out;

  const closes = candles.map((c) => c.close);
  const fast = ema(closes, emaFast);
  const slow = ema(closes, emaSlow);
  const atr = wilderAtr(candles, atrPeriod);
  const { plusDi, minusDi, adx } = adxSeries(candles, adxPeriod);

  const atrPct = candles.map((c, i) => (atr[i] != null && c.close > 0 ? atr[i] / c.close : null));
  const window = Math.min(100, n);
  for (let i = 0; i < n; i++) {
    if (fast[i] == null || slow[i] == null || adx[i] == null || atrPct[i] == null) continue;
    const sample = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      if (atrPct[j] != null) sample.push(atrPct[j]);
    }
    sample.sort((a, b) => a - b);
    const volRank = percentileRank(sample, atrPct[i]);
    let id = REGIME.RANGE;
    if (volRank >= SHOCK_PCT) {
      id = REGIME.SHOCK;
    } else if (adx[i] >= ADX_TREND) {
      if (fast[i] > slow[i] && (plusDi[i] ?? 0) >= (minusDi[i] ?? 0)) id = REGIME.TREND_UP;
      else if (fast[i] < slow[i] && (minusDi[i] ?? 0) >= (plusDi[i] ?? 0)) id = REGIME.TREND_DOWN;
      else id = REGIME.RANGE;
    }
    out[i] = {
      id,
      adx: adx[i],
      plusDi: plusDi[i],
      minusDi: minusDi[i],
      atrPct: atrPct[i],
      volRank,
      time: candles[i].time,
    };
  }
  return out;
}

export function currentRegime(candles, options) {
  const series = classifyRegimes(candles, options);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i]) return series[i];
  }
  return null;
}

export function regimeAtTime(series, time) {
  if (!series?.length || time == null) return null;
  let best = null;
  for (const row of series) {
    if (!row) continue;
    if (row.time <= time) best = row;
    else break;
  }
  return best;
}

export function gateSignalsByRegime(signals, regimes, allowedIds) {
  const allow = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
  return signals.map((s, i) => {
    const id = regimes[i]?.id;
    if (!id || allow.has(id)) return s;
    return 0;
  });
}

export function breakdownTradesByRegime(trades, regimes) {
  const buckets = {};
  for (const id of Object.values(REGIME)) {
    buckets[id] = { id, trades: [], n: 0, wins: 0, grossWin: 0, grossLoss: 0, expectancy: null, profitFactor: null, winRate: null };
  }
  for (const trade of trades || []) {
    const row = regimeAtTime(regimes, trade.entryTime);
    const id = row?.id || REGIME.RANGE;
    const bucket = buckets[id];
    bucket.trades.push(trade);
    bucket.n += 1;
    const pnl = Number(trade.pnlPercent) || 0;
    if (pnl > 0) {
      bucket.wins += 1;
      bucket.grossWin += pnl;
    } else {
      bucket.grossLoss += Math.abs(pnl);
    }
  }
  for (const bucket of Object.values(buckets)) {
    if (!bucket.n) continue;
    bucket.winRate = (bucket.wins / bucket.n) * 100;
    bucket.expectancy = bucket.trades.reduce((a, t) => a + (Number(t.pnlPercent) || 0), 0) / bucket.n;
    bucket.profitFactor = bucket.grossLoss > 0 ? bucket.grossWin / bucket.grossLoss : bucket.wins ? Infinity : null;
  }
  return buckets;
}

/**
 * Whether the live tape currently resembles a tape this strategy family
 * historically had an edge in. This is a permission filter, not a signal.
 */
export function edgePermission({ current, breakdown, category = "hybrid", minTrades = 8 } = {}) {
  if (!current) {
    return { action: "wait", reason: "regime_unknown", score: 0 };
  }
  const here = breakdown?.[current.id];
  const cat = String(category || "hybrid");
  const trendFamily = cat === "trend" || cat === "momentum";
  const reversionFamily = cat === "reversion";

  let action = "trade";
  let reason = "regime_ok";
  if (current.id === REGIME.SHOCK) {
    action = "stand_down";
    reason = "vol_shock";
  } else if (trendFamily && current.id === REGIME.RANGE) {
    action = "stand_down";
    reason = "trend_in_range";
  } else if (reversionFamily && (current.id === REGIME.TREND_UP || current.id === REGIME.TREND_DOWN)) {
    action = "reduce";
    reason = "reversion_in_trend";
  }

  if (here && here.n >= minTrades && Number.isFinite(here.profitFactor) && here.profitFactor < 1) {
    action = "stand_down";
    reason = "no_edge_in_regime";
  } else if (here && here.n >= minTrades && here.profitFactor >= 1.25 && action === "trade") {
    reason = "historical_edge_here";
  }

  const score = action === "trade" ? 80 : action === "reduce" ? 45 : 15;
  return { action, reason, score, regimeId: current.id, sample: here?.n ?? 0, profitFactor: here?.profitFactor ?? null };
}
