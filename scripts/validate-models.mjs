import assert from "node:assert/strict";
import { runBacktest, runLeveragedBacktest } from "../src/lib/backtest.js";
import { STRATEGIES, sma } from "../src/lib/strategies.js";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../src/lib/risk.js";
import { monteCarlo, outcomeZones, tradeSetups, probabilityPriceMap } from "../src/lib/forecast.js";
import { resolveTimeframe, TIMEFRAMES } from "../src/lib/coingecko.js";
import { optimizeStrategy, walkForwardValidate } from "../src/lib/optimize.js";
import { buildCustomStrategy, getAllStrategies } from "../src/lib/customStrategies.js";

function makeCandles(length = 180) {
  const start = Date.UTC(2025, 0, 1) / 1000;
  const candles = [];
  let close = 100;
  for (let i = 0; i < length; i++) {
    const wave = Math.sin(i / 7) * 2;
    const drift = i * 0.08;
    const next = Math.max(1, 100 + drift + wave);
    candles.push({
      time: start + i * 86400,
      open: close,
      high: Math.max(close, next) + 1.5,
      low: Math.min(close, next) - 1.5,
      close: next,
    });
    close = next;
  }
  return candles;
}

const candles = makeCandles();
const closes = candles.map((c) => c.close);

for (const [key, strategy] of Object.entries(STRATEGIES)) {
  const signals = strategy.generateSignals(candles, strategy.params || {});
  assert.equal(signals.length, candles.length, `${key}: signal length`);
  assert.ok(signals.every((s) => s === 0 || s === 1), `${key}: binary signals`);
}

const buyHold = runBacktest({
  candles,
  signals: STRATEGIES.buyAndHold.generateSignals(candles),
  feePercent: 0,
});
const expectedBuyHoldReturn = ((candles.at(-1).close - candles[0].close) / candles[0].close) * 100;
assert.ok(Math.abs(buyHold.totalReturnPercent - expectedBuyHoldReturn) < 1e-9, "buy-hold return");
assert.ok(buyHold.finalEquity > buyHold.initialCapital, "buy-hold final equity");
assert.ok(buyHold.maxDrawdownPercent >= 0, "drawdown is non-negative");

const sizing = positionSize({ accountSize: 10000, riskPercent: 1, entryPrice: 100, stopPrice: 95 });
assert.equal(sizing.riskAmount, 100);
assert.equal(sizing.units, 20);
assert.equal(riskRewardRatio({ entryPrice: 100, stopPrice: 95, targetPrice: 115 }), 3);

const atr = calculateATR(candles, 14);
assert.ok(atr > 0, "ATR positive");
const stop = atrStopSuggestion({ entryPrice: 100, atr, multiplier: 2, direction: "long" });
assert.ok(stop.stopPrice < 100, "long ATR stop below entry");

const mc = monteCarlo({ closes, horizon: 30, sims: 1000, method: "bootstrap", driftMode: "zero", seed: 42 });
assert.equal(mc.error, undefined);
assert.equal(mc.finals.length, 1000);
assert.equal(mc.cone.length, 30);
assert.ok(mc.dist.p5 <= mc.dist.p25 && mc.dist.p25 <= mc.dist.p50, "lower percentiles sorted");
assert.ok(mc.dist.p50 <= mc.dist.p75 && mc.dist.p75 <= mc.dist.p95, "upper percentiles sorted");
assert.ok(mc.probProfit >= 0 && mc.probProfit <= 1, "profit probability bounded");
assert.equal(mc.probProfit, mc.probAboveCurrent, "probProfit alias matches probAboveCurrent");
assert.ok(
  Math.abs(mc.probAboveCurrent - mc.finals.filter((p) => p > mc.current).length / mc.finals.length) < 1e-12,
  "probAboveCurrent uses simulated path count as denominator",
);
const expectedMedianPct = (mc.dist.p50 / mc.current - 1) * 100;
assert.ok(Math.abs(mc.medianReturnPct - expectedMedianPct) < 1e-9, "median return derives from p50");

const zones = outcomeZones(mc, 7);
const zoneMass = zones.reduce((sum, z) => sum + z.probability, 0);
assert.ok(Math.abs(zoneMass - 1) < 0.02, "zone probabilities approximately sum to 100%");

const setups = tradeSetups(mc);
assert.equal(setups.length, 4);
assert.ok(setups.every((s) => s.target > mc.current && s.stop < mc.current), "setup levels bracket current price");

const priceMap = probabilityPriceMap(mc);
assert.equal(priceMap.length, 5);
assert.ok(priceMap.every((p) => Number.isFinite(p.price)), "probability map prices");

assert.equal(resolveTimeframe("1m").intervalMinutes, 1);
assert.equal(resolveTimeframe("4h").intervalMinutes, 240);
assert.ok(TIMEFRAMES.some((tf) => tf.id === "1M"), "TradingView-style monthly timeframe exists");

// ---------------------------------------------------------------------------
// Position sizing (spot): risk-based sizing must commit less notional than
// all-in, scale the equity curve's swing proportionally, and carry idle cash
// forward correctly. Passing `sizing` with no stop-loss configured must
// silently fall back to byte-identical all-in behavior.
// ---------------------------------------------------------------------------
{
  const sizingCandles = makeCandles(40);
  const sizingSignals = new Array(sizingCandles.length).fill(0);
  sizingSignals[5] = 1;
  sizingSignals[6] = 1;
  sizingSignals[7] = 0;
  const common = { candles: sizingCandles, signals: sizingSignals, feePercent: 0, initialCapital: 10000, riskParams: { stopLossPercent: 5 } };
  const allInResult = runBacktest({ ...common, sizing: null });
  const riskSizedResult = runBacktest({ ...common, sizing: { mode: "riskPercent", riskPercent: 1 } });

  const expectedFraction = (1 / 100) / (5 / 100); // riskPercent / stopLossPercent = 0.2
  const allInDeviation = allInResult.equityCurve[6].equity - 10000;
  const riskSizedDeviation = riskSizedResult.equityCurve[6].equity - 10000;
  assert.ok(
    Math.abs(riskSizedDeviation - allInDeviation * expectedFraction) < 1e-6,
    "risk-based position sizing scales equity exposure by riskPercent/stopLossPercent"
  );

  const plainAllIn = runBacktest({ candles: sizingCandles, signals: sizingSignals, feePercent: 0, initialCapital: 10000 });
  const sizingWithoutStop = runBacktest({
    candles: sizingCandles,
    signals: sizingSignals,
    feePercent: 0,
    initialCapital: 10000,
    sizing: { mode: "riskPercent", riskPercent: 1 }, // no riskParams -> no stop distance -> falls back to all-in
  });
  assert.deepEqual(sizingWithoutStop.equityCurve, plainAllIn.equityCurve, "sizing with no configured stop-loss falls back to all-in exactly");
}

// ---------------------------------------------------------------------------
// Position sizing (leveraged): collateral scales down as leverage rises
// relative to the stop distance, capped at riskAmount once leverage makes
// the stop-implied loss exceed 100% of collateral.
// ---------------------------------------------------------------------------
{
  const levCandles = [];
  let px = 100;
  for (let i = 0; i < 8; i++) {
    const next = px * 1.01;
    levCandles.push({ time: i, open: px, close: next, high: next + 0.2, low: px - 0.2 });
    px = next;
  }
  const levSignals = [1, 1, 1, 1, 1, 0, 0, 0];
  const levCommon = { candles: levCandles, signals: levSignals, feePercent: 0, initialCapital: 10000, leverage: 5, riskParams: { stopLossPercent: 4 } };
  const levAllIn = runLeveragedBacktest({ ...levCommon, sizing: null });
  const levRiskSized = runLeveragedBacktest({ ...levCommon, sizing: { mode: "riskPercent", riskPercent: 1 } });

  const expectedCollateralFraction = (10000 * 0.01) / Math.min(1, (4 / 100) * 5) / 10000; // = 0.05
  const allInDev = levAllIn.equityCurve[2].equity - 10000;
  const riskDev = levRiskSized.equityCurve[2].equity - 10000;
  assert.ok(
    Math.abs(riskDev - allInDev * expectedCollateralFraction) < 1e-6,
    "leveraged risk-based sizing scales collateral by the leverage-amplified stop distance"
  );
}

// ---------------------------------------------------------------------------
// Liquidation gating: all-in mode still permanently halts the account on
// liquidation (byte-identical to the original behavior); risk-sized mode
// only loses the risked slice and keeps trading with its untouched idle cash.
// ---------------------------------------------------------------------------
{
  const closesSeq = [100, 101, 102, 80, 90, 100, 115];
  const liqCandles = closesSeq.map((c, i) => {
    const prev = i === 0 ? c : closesSeq[i - 1];
    return { time: i, open: prev, close: c, high: Math.max(prev, c), low: Math.min(prev, c) };
  });
  const liqSignals = new Array(closesSeq.length).fill(1); // stays long throughout; only the crash matters
  const liqCommon = { candles: liqCandles, signals: liqSignals, feePercent: 0, initialCapital: 10000, leverage: 10, riskParams: { stopLossPercent: 50 } };

  const liqAllIn = runLeveragedBacktest({ ...liqCommon, sizing: null });
  assert.equal(liqAllIn.wasLiquidated, true, "all-in: the crash still triggers a liquidation");
  assert.equal(liqAllIn.equityCurve.at(-1).equity, 0, "all-in: liquidation still permanently zeroes the account (unchanged from before)");
  assert.equal(liqAllIn.trades.length, 1, "all-in: no re-entry is possible after the whole account is gone");

  const liqRiskSized = runLeveragedBacktest({ ...liqCommon, sizing: { mode: "riskPercent", riskPercent: 1 } });
  assert.equal(liqRiskSized.wasLiquidated, true, "risk-sized: the trade that got liquidated is still correctly flagged as such");
  assert.ok(liqRiskSized.trades.length > 1, "risk-sized: the account keeps trading on its untouched idle cash after a contained liquidation");
  assert.ok(
    liqRiskSized.equityCurve.at(-1).equity > 9900,
    "risk-sized: surviving idle cash lets the account participate in the subsequent recovery instead of being frozen"
  );
}

// ---------------------------------------------------------------------------
// Fill timing: "close" reproduces the original zero-latency fill; "nextOpen"
// fills at the following bar's open instead (falling back to that bar's own
// close only for a transition on the very last candle).
// ---------------------------------------------------------------------------
{
  const ftCandles = Array.from({ length: 10 }, (_, i) => ({
    time: i,
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: 105 + i,
  }));
  const ftSignals = [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]; // enter at i=2, exit at i=5
  const closeFill = runBacktest({ candles: ftCandles, signals: ftSignals, feePercent: 0, initialCapital: 10000, fillTiming: "close" });
  const nextOpenFill = runBacktest({ candles: ftCandles, signals: ftSignals, feePercent: 0, initialCapital: 10000, fillTiming: "nextOpen" });

  assert.equal(closeFill.trades[0].entryPrice, ftCandles[2].close, "close fill timing enters at the signal bar's own close");
  assert.equal(closeFill.trades[0].exitPrice, ftCandles[5].close, "close fill timing exits at the signal bar's own close");
  assert.equal(nextOpenFill.trades[0].entryPrice, ftCandles[3].open, "nextOpen fill timing enters at the following bar's open");
  assert.equal(nextOpenFill.trades[0].exitPrice, ftCandles[6].open, "nextOpen fill timing exits at the following bar's open");
}

// ---------------------------------------------------------------------------
// Monte Carlo: block bootstrap produces valid, reproducible output and
// gracefully clamps an oversized block length instead of crashing.
// ---------------------------------------------------------------------------
{
  const mcBlock = monteCarlo({ closes, horizon: 20, sims: 500, method: "blockBootstrap", blockSize: 5, seed: 7 });
  assert.equal(mcBlock.error, undefined);
  assert.equal(mcBlock.finals.length, 500);
  assert.equal(mcBlock.blockSize, 5);
  const mcBlockAgain = monteCarlo({ closes, horizon: 20, sims: 500, method: "blockBootstrap", blockSize: 5, seed: 7 });
  assert.deepEqual(mcBlock.finals, mcBlockAgain.finals, "blockBootstrap is reproducible for a fixed seed");

  const mcBlockOversized = monteCarlo({ closes, horizon: 10, sims: 200, method: "blockBootstrap", blockSize: 100000, seed: 1 });
  assert.equal(mcBlockOversized.error, undefined);
  assert.ok(mcBlockOversized.blockSize <= closes.length, "an oversized block length is clamped instead of crashing");
}

// ---------------------------------------------------------------------------
// Walk-forward validation: train/test candle counts add up to the full
// series, the split respects trainRatio, and it declines gracefully when
// there isn't enough history for a meaningful split.
// ---------------------------------------------------------------------------
{
  const directFit = optimizeStrategy({ strategy: STRATEGIES.smaCrossover, candles: makeCandles(150) });
  assert.ok(directFit && directFit.bestResult, "optimizeStrategy returns a best result for a strategy with numeric params");
  assert.ok(directFit.testedCount > 0, "optimizeStrategy tests at least one parameter combination");

  const wfCandles = makeCandles(200);
  const wf = walkForwardValidate({ strategy: STRATEGIES.smaCrossover, candles: wfCandles, trainRatio: 0.7 });
  assert.ok(wf, "walk-forward returns a result for a long-enough series");
  assert.equal(wf.trainCandleCount + wf.testCandleCount, wfCandles.length, "train + test candle counts add up to the full series");
  assert.ok(wf.trainCandleCount > wf.testCandleCount, "a 0.7 trainRatio favors the training slice");
  assert.ok(Number.isFinite(wf.testFittedResult.totalReturnPercent), "out-of-sample fitted result is well-formed");
  assert.ok(Number.isFinite(wf.testDefaultResult.totalReturnPercent), "out-of-sample default-params result is well-formed");

  const wfTooShort = walkForwardValidate({ strategy: STRATEGIES.smaCrossover, candles: makeCandles(20) });
  assert.equal(wfTooShort, null, "walk-forward declines gracefully when there isn't enough history for a meaningful split");
}

// ---------------------------------------------------------------------------
// Custom strategy builder: a compiled JSON rule must match a hand-computed
// reference for the same indicator math, mirror correctly for the short
// side, run cleanly through the real backtest engine, and never mutate the
// built-in STRATEGIES registry when merged via getAllStrategies().
// ---------------------------------------------------------------------------
{
  const customDef = {
    id: "custom-test",
    name: "Close above SMA20",
    sustain: "immediate",
    combine: "AND",
    conditions: [{ left: { type: "close" }, op: ">", right: { type: "sma", period: 20 } }],
    mirrorShort: true,
  };
  const compiled = buildCustomStrategy(customDef);
  const customSignals = compiled.generateSignals(candles);
  assert.equal(customSignals.length, candles.length, "custom strategy signal length matches candle length");
  assert.ok(customSignals.every((s) => s === 0 || s === 1), "custom strategy emits binary signals");

  const smaRef = sma(closes, 20);
  const expectedSignals = closes.map((c, i) => (smaRef[i] != null && c > smaRef[i] ? 1 : 0));
  assert.deepEqual(customSignals, expectedSignals, "compiled custom strategy matches a hand-computed close>SMA20 reference");

  const shortSignals = compiled.generateShortSignals(candles);
  const expectedShort = closes.map((c, i) => (smaRef[i] != null && c < smaRef[i] ? 1 : 0));
  assert.deepEqual(shortSignals, expectedShort, "mirrorShort flips the operator (> becomes <) as documented");

  const customBacktestResult = runBacktest({ candles, signals: customSignals, feePercent: 0.1 });
  assert.ok(Number.isFinite(customBacktestResult.totalReturnPercent), "a compiled custom strategy runs cleanly through the real backtest engine");

  const snapshotBefore = JSON.stringify(Object.keys(STRATEGIES));
  const merged = getAllStrategies(STRATEGIES);
  assert.ok(merged.smaCrossover, "getAllStrategies keeps every built-in strategy");
  assert.equal(JSON.stringify(Object.keys(STRATEGIES)), snapshotBefore, "getAllStrategies never mutates the built-in STRATEGIES registry");

  // "Hold" mode: independent entry/exit condition groups latch a position on
  // and off, and — deliberately, in this version — don't ship a short side.
  const holdDef = {
    id: "custom-hold-test",
    name: "RSI reversion",
    sustain: "hold",
    combine: "AND",
    conditions: [{ left: { type: "rsi", period: 14 }, op: "<", right: { type: "value", value: 30 } }],
    exitCombine: "AND",
    exitConditions: [{ left: { type: "rsi", period: 14 }, op: ">", right: { type: "value", value: 70 } }],
  };
  const holdCompiled = buildCustomStrategy(holdDef);
  const holdSignals = holdCompiled.generateSignals(candles);
  assert.equal(holdSignals.length, candles.length);
  assert.ok(holdSignals.every((s) => s === 0 || s === 1), "hold-mode custom strategy emits binary signals");
  assert.equal(holdCompiled.generateShortSignals, undefined, "hold-mode custom strategies are long-only in this version");
}

console.log(
  "Model validation passed: strategies, backtest, position sizing, fill timing, risk tools, Monte Carlo (incl. block bootstrap), walk-forward validation, custom strategies, and timeframes."
);
