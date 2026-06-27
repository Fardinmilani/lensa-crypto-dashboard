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

// ---------------------------------------------------------------------------
// Leveraged / futures backtest
// ---------------------------------------------------------------------------
//
// runBacktest() above models a simple all-in/all-out spot position (1x).
// runLeveragedBacktest() reuses the same long/flat signal convention but
// marks the position to market on every bar so a leveraged position can be
// liquidated mid-trade — something an entry-vs-exit-price-only calculation
// would miss entirely. The full account balance is committed as collateral
// on entry (isolated margin against the whole account, not a fraction of
// it), and the position's notional exposure — and therefore its P&L — is
// the underlying percentage move amplified by `leverage`. If mark-to-market
// losses would amplify to a -100% (or worse) move on that collateral before
// the exit signal fires, the trade is force-closed at the bar where it
// crosses that line ("liquidated") — mirroring how a real isolated-margin
// futures position behaves, instead of pretending the account can ride out
// an unbounded drawdown.
export function runLeveragedBacktest({ candles, signals, feePercent = 0.1, initialCapital = 10000, leverage = 1 }) {
  if (candles.length !== signals.length) {
    throw new Error("candles و signals باید طول یکسان داشته باشند");
  }
  const lev = Math.max(1, Number(leverage) || 1);
  if (lev === 1) return runBacktest({ candles, signals, feePercent, initialCapital });

  const equityCurve = [];
  const trades = [];
  let cash = initialCapital;
  // notional/margin of the currently open position. The position's notional
  // exposure is `leverage × the account equity committed to it`, so the
  // *entire* available cash backs the trade (as collateral) while only
  // `equity` is actually at risk — leverage amplifies the P&L on that same
  // committed equity, it does not shrink how much equity is committed.
  let positionEquity = 0; // collateral backing the open position (this account's "skin in the game")
  let entryPrice = null;
  let entryTime = null;
  let liquidated = false;
  let prevSignal = 0;

  function closePosition(exitPrice, exitTime, { isLiquidation = false } = {}) {
    const rawPnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100 * lev;
    // Collateral can't go below zero: a liquidation caps the loss at -100%
    // of the committed equity (the rest of the account, if any was held
    // back, is untouched — isolated margin, not cross margin).
    const pnlPercentOnEquity = isLiquidation ? -100 : Math.max(-100, rawPnlPercent);
    const grossProceeds = positionEquity * (1 + pnlPercentOnEquity / 100);
    const fee = grossProceeds * (feePercent / 100);
    cash += Math.max(0, grossProceeds - fee);
    trades.push({
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      pnlPercent: pnlPercentOnEquity,
      leverage: lev,
      liquidated: isLiquidation,
    });
    positionEquity = 0;
    entryPrice = null;
    entryTime = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const { time, close, low, high } = candles[i];
    const signal = liquidated ? 0 : signals[i];

    if (prevSignal === 0 && signal === 1 && !liquidated) {
      const fee = cash * (feePercent / 100);
      positionEquity = Math.max(0, cash - fee);
      cash -= positionEquity + fee;
      entryPrice = close;
      entryTime = time;
    } else if (entryPrice != null) {
      // Mark-to-market against the bar's worst excursion before checking the
      // exit signal, since a liquidation can happen intrabar even on the
      // same candle that would otherwise have produced a clean exit.
      const worstPrice = Number.isFinite(low) && Number.isFinite(high) ? low : close;
      const worstMovePercent = ((worstPrice - entryPrice) / entryPrice) * 100 * lev;
      if (worstMovePercent <= -100) {
        closePosition(worstPrice, time, { isLiquidation: true });
      } else if (prevSignal === 1 && signal === 0) {
        closePosition(close, time);
      }
    }

    const markPrice = close;
    const openEquity =
      entryPrice != null ? positionEquity * (1 + (((markPrice - entryPrice) / entryPrice) * 100 * lev) / 100) : 0;
    equityCurve.push({ time, equity: cash + Math.max(0, openEquity) });
    prevSignal = liquidated ? 0 : signal;
    if (entryPrice == null && positionEquity === 0 && cash <= 0) liquidated = true;
  }

  if (entryPrice != null) {
    const lastClose = candles[candles.length - 1].close;
    closePosition(lastClose, candles[candles.length - 1].time);
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = cash;
  }

  const finalEquity = cash;
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
  const liquidationCount = trades.filter((t) => t.liquidated).length;

  const benchmarkReturnPercent =
    ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100;
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
    leverage: lev,
    liquidationCount,
    wasLiquidated: liquidationCount > 0,
  };
}

// Run every non-benchmark strategy (with its default params) on the same
// candles and compare them against a single Buy & Hold benchmark. Returns the
// per-strategy rows plus a set of aggregate KPIs for a portfolio-level view.
// `leverage` defaults to 1 (spot, unleveraged) — passing >1 reuses the exact
// same strategy set against runLeveragedBacktest, which is what the futures
// sweep below builds on for each timeframe × leverage combination.
export function runAllStrategies({ candles, strategies, feePercent = 0.1, leverage = 1 }) {
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
      const result =
        leverage > 1
          ? runLeveragedBacktest({ candles, signals, feePercent, leverage })
          : runBacktest({ candles, signals, feePercent });
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

// ---------------------------------------------------------------------------
// Futures sweep: every strategy × every chosen timeframe × every chosen
// leverage level, all on futures candles. "Run All" only ever exercised the
// currently-selected market/timeframe at 1x; this sweep is what lets a
// USD-M/Coin-M Futures backtest actually exercise leverage and timeframe as
// first-class dimensions instead of fixed inputs.
// ---------------------------------------------------------------------------

/**
 * fetchCandlesForTimeframe(timeframeId) must return the candle array for
 * that timeframe (already scoped to the chosen symbol/exchange/market type
 * by the caller) — kept as an injected function so this module stays free
 * of any networking/data-source concerns.
 */
export async function runFuturesSweep({
  strategies,
  timeframes,
  leverageLevels,
  feePercent = 0.1,
  fetchCandlesForTimeframe,
  minCandles = 30,
}) {
  const strategyEntries = Object.entries(strategies).filter(([, s]) => s.category !== "benchmark");
  const rows = [];
  const errors = [];

  for (const timeframe of timeframes) {
    let candles;
    try {
      candles = await fetchCandlesForTimeframe(timeframe);
    } catch (err) {
      errors.push({ timeframe, message: err.message });
      continue;
    }
    if (!candles || candles.length < minCandles) {
      errors.push({ timeframe, message: "Not enough candles for this timeframe" });
      continue;
    }

    const benchmark = runBacktest({ candles, signals: strategies.buyAndHold.generateSignals(candles), feePercent });

    for (const leverage of leverageLevels) {
      for (const [key, strategy] of strategyEntries) {
        const signals = strategy.generateSignals(candles, strategy.params);
        const result =
          leverage > 1
            ? runLeveragedBacktest({ candles, signals, feePercent, leverage })
            : runBacktest({ candles, signals, feePercent });
        rows.push({
          key,
          label: strategy.label,
          category: strategy.category,
          timeframe,
          leverage,
          candleCount: candles.length,
          result,
          excessReturn: result.totalReturnPercent - benchmark.totalReturnPercent,
          beatsBenchmark: result.totalReturnPercent > benchmark.totalReturnPercent,
          // A leveraged max drawdown that reaches 100% of margin means the
          // position would have been liquidated at some point in this
          // window — flagged independently of whether the strategy's exit
          // signal happened to fire first, so risk is visible even on runs
          // that technically "survived" to the end of the backtest.
          liquidationRisk: leverage > 1 && result.maxDrawdownPercent >= 99.5,
        });
      }
    }
  }

  rows.sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);

  const sharpeRows = rows.filter((r) => Number.isFinite(r.result.sharpe));
  const bestBySharpe = sharpeRows.length
    ? sharpeRows.reduce((best, r) => (r.result.sharpe > best.result.sharpe ? r : best))
    : null;

  const summary = {
    count: rows.length,
    timeframeCount: timeframes.length,
    leverageCount: leverageLevels.length,
    best: rows[0] || null,
    bestBySharpe,
    profitable: rows.filter((r) => r.result.totalReturnPercent > 0).length,
    liquidated: rows.filter((r) => r.result.wasLiquidated).length,
    avgReturn: mean(rows.map((r) => r.result.totalReturnPercent)),
  };

  return { rows, summary, errors };
}

/** Equal-weight average of normalized equity curves (each starts at the same capital). */
export function averageEquityCurves(rows, initialCapital = 10000) {
  if (!rows?.length) return [];

  // Every equity curve produced by runBacktest has exactly one point per
  // input candle, built in the same left-to-right order — so all rows are
  // already index-aligned and share the same time axis. No per-timestamp
  // lookup is needed; we can average by position directly in one pass.
  const length = rows[0]?.result?.equityCurve?.length || 0;
  if (!length) return [];

  const out = new Array(length);
  const rowCount = rows.length;
  for (let i = 0; i < length; i++) {
    let sumNorm = 0;
    for (let r = 0; r < rowCount; r++) {
      sumNorm += rows[r].result.equityCurve[i].equity / rows[r].result.initialCapital;
    }
    out[i] = { time: rows[0].result.equityCurve[i].time, equity: (sumNorm / rowCount) * initialCapital };
  }
  return out;
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
