// lib/backtest.js
// Mechanical backtest engine. Takes a 0/1 long-flat signal array and historical
// candles, simulates equity including a fee/slippage assumption, and reports a
// full set of performance statistics.
//
// IMPORTANT: this measures how a *rule* would have performed on *past* data.
// Past performance of a rule is not a forecast of future performance.

export function runBacktest({ candles, signals, feePercent = 0.1, initialCapital = 10000 }) {
  if (candles.length !== signals.length) {
    throw new Error("candles و signals باید طول یکسان داشته باشند");
  }

  const equityCurve = [];
  const trades = [];
  let cash = initialCapital;
  let units = 0;
  let prevSignal = 0;
  let entryPrice = null;
  let entryTime = null;

  for (let i = 0; i < candles.length; i++) {
    const { time, close } = candles[i];
    const signal = signals[i];

    if (prevSignal === 0 && signal === 1) {
      const fee = cash * (feePercent / 100);
      const investable = cash - fee;
      units = investable / close;
      cash = 0;
      entryPrice = close;
      entryTime = time;
    } else if (prevSignal === 1 && signal === 0) {
      const proceeds = units * close;
      const fee = proceeds * (feePercent / 100);
      cash = proceeds - fee;
      const pnlPercent = ((close - entryPrice) / entryPrice) * 100;
      trades.push({ entryTime, exitTime: time, entryPrice, exitPrice: close, pnlPercent });
      units = 0;
      entryPrice = null;
      entryTime = null;
    }

    equityCurve.push({ time, equity: cash + units * close });
    prevSignal = signal;
  }

  if (units > 0) {
    const lastClose = candles[candles.length - 1].close;
    const pnlPercent = ((lastClose - entryPrice) / entryPrice) * 100;
    trades.push({
      entryTime,
      exitTime: candles[candles.length - 1].time,
      entryPrice,
      exitPrice: lastClose,
      pnlPercent,
      stillOpenAtEnd: true,
    });
    cash = units * lastClose;
  }

  const finalEquity = cash;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  // Max drawdown
  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  // Per-period returns of the equity curve → Sharpe / Sortino
  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  // Trade stats
  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : null;
  const avgWin = wins.length ? mean(wins.map((t) => t.pnlPercent)) : null;
  const avgLoss = losses.length ? mean(losses.map((t) => t.pnlPercent)) : null;
  const grossWin = wins.reduce((a, t) => a + t.pnlPercent, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null;
  const expectancy = trades.length ? mean(trades.map((t) => t.pnlPercent)) : null;
  const bestTrade = trades.length ? Math.max(...trades.map((t) => t.pnlPercent)) : null;
  const worstTrade = trades.length ? Math.min(...trades.map((t) => t.pnlPercent)) : null;

  const benchmarkReturnPercent =
    ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100;

  // Time exposed to the market (fraction of periods holding)
  const exposurePercent = (signals.filter((s) => s === 1).length / signals.length) * 100;

  return {
    equityCurve,
    trades,
    finalEquity,
    initialCapital,
    totalReturnPercent,
    maxDrawdownPercent,
    winRate,
    tradeCount: trades.length,
    benchmarkReturnPercent,
    sharpe,
    sortino,
    profitFactor,
    expectancy,
    avgWin,
    avgLoss,
    bestTrade,
    worstTrade,
    exposurePercent,
  };
}

// Run every non-benchmark strategy (with its default params) on the same
// candles and compare them against a single Buy & Hold benchmark. Returns the
// per-strategy rows plus a set of aggregate KPIs for a portfolio-level view.
export function runAllStrategies({ candles, strategies, feePercent = 0.1 }) {
  const benchmarkDef = strategies.buyAndHold;
  const benchmark = runBacktest({
    candles,
    signals: benchmarkDef.generateSignals(candles),
    feePercent,
  });

  const rows = Object.entries(strategies)
    .filter(([, s]) => s.category !== "benchmark")
    .map(([key, strategy]) => {
      const signals = strategy.generateSignals(candles, strategy.params);
      const result = runBacktest({ candles, signals, feePercent });
      return {
        key,
        label: strategy.label,
        category: strategy.category,
        params: strategy.params,
        result,
        excessReturn: result.totalReturnPercent - benchmark.totalReturnPercent,
        beatsBenchmark: result.totalReturnPercent > benchmark.totalReturnPercent,
      };
    })
    .sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);

  const returns = rows.map((r) => r.result.totalReturnPercent);
  const sharpeRows = rows.filter((r) => Number.isFinite(r.result.sharpe));
  const bestBySharpe = sharpeRows.length
    ? sharpeRows.reduce((best, r) => (r.result.sharpe > best.result.sharpe ? r : best))
    : null;

  const summary = {
    count: rows.length,
    benchmarkReturn: benchmark.totalReturnPercent,
    best: rows[0] || null,
    worst: rows[rows.length - 1] || null,
    bestBySharpe,
    beatsBenchmark: rows.filter((r) => r.beatsBenchmark).length,
    profitable: rows.filter((r) => r.result.totalReturnPercent > 0).length,
    avgReturn: mean(returns),
  };

  const aggregateEquityCurve = averageEquityCurves(rows);
  const aggregateResult = summarizeEquityCurve(aggregateEquityCurve, {
    initialCapital: benchmark.initialCapital,
    candles,
    benchmarkReturnPercent: benchmark.totalReturnPercent,
  });

  return { benchmark, rows, summary, aggregateEquityCurve, aggregate: { equityCurve: aggregateEquityCurve, result: aggregateResult } };
}

/** Equal-weight average of normalized equity curves (each starts at the same capital). */
export function averageEquityCurves(rows, initialCapital = 10000) {
  if (!rows?.length) return [];

  const times = [
    ...new Set(rows.flatMap((row) => row.result.equityCurve.map((point) => point.time))),
  ].sort((a, b) => a - b);

  function valueAt(curve, time) {
    if (!curve.length) return initialCapital;
    let value = curve[0].equity;
    for (const point of curve) {
      if (point.time > time) break;
      value = point.equity;
    }
    return value;
  }

  return times.map((time) => {
    const normalized = rows.map((row) => valueAt(row.result.equityCurve, time) / row.result.initialCapital);
    const avgNorm = mean(normalized);
    return { time, equity: avgNorm * initialCapital };
  });
}

export function summarizeEquityCurve(equityCurve, { initialCapital = 10000, candles = [], benchmarkReturnPercent = null } = {}) {
  if (!equityCurve?.length) {
    return {
      equityCurve: [],
      initialCapital,
      finalEquity: initialCapital,
      totalReturnPercent: 0,
      maxDrawdownPercent: 0,
      sharpe: null,
      sortino: null,
      benchmarkReturnPercent,
    };
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  return {
    equityCurve,
    initialCapital,
    finalEquity,
    totalReturnPercent,
    maxDrawdownPercent,
    sharpe,
    sortino,
    benchmarkReturnPercent,
  };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function estimatePeriodsPerYear(candles) {
  if (candles.length < 2) return 365;
  const dt = candles[1].time - candles[0].time; // seconds
  if (dt <= 0) return 365;
  return (365 * 24 * 3600) / dt;
}
