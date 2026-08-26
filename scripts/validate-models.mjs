import assert from "node:assert/strict";
import { runBacktest, runLeveragedBacktest } from "../src/lib/backtest.js";
import { STRATEGIES, sma, ema, rsi } from "../src/lib/strategies.js";
import { classifyCrowding } from "../src/lib/derivatives.js";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../src/lib/risk.js";
import { monteCarlo, outcomeZones, tradeSetups, probabilityAboveAcrossWindows, probabilityPriceMap, SCENARIO_CONSENSUS_STEPS } from "../src/lib/forecast.js";
import { resolveTimeframe, TIMEFRAMES, normalizeMarketSource, coinIdFromPair, auditTimeframes, auditLookbackDays } from "../src/lib/coingecko.js";
import { optimizeStrategy, walkForwardValidate } from "../src/lib/optimize.js";
import { buildCustomStrategy, getAllStrategies } from "../src/lib/customStrategies.js";
import { classifyRegimes, currentRegime, REGIME, gateSignalsByRegime, breakdownTradesByRegime } from "../src/lib/regime.js";
import { kellyFraction, systemQualityNumber, maeMfeAnalysis, tradeSequenceMonteCarlo, deflatedSharpeRatio, enrichBacktest } from "../src/lib/edge.js";
import { runPortfolioBacktest, estimateVolatility } from "../src/lib/portfolio.js";
import { correlationMatrix, relativeStrength } from "../src/lib/correlation.js";
import { seasonalityAnalysis } from "../src/lib/seasonality.js";
import { applyStressScenario, monteCarloPortfolioStress } from "../src/lib/stress.js";
import { underwaterEquity } from "../src/lib/underwater.js";
import { encodeStrategyPayload, decodeStrategyPayload } from "../src/lib/strategyShare.js";
import { evaluateMultiTfConfluence } from "../src/lib/multitf.js";

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

const mcStrategy = STRATEGIES.monteCarloProbability;
assert.equal("horizon" in mcStrategy.params, false, "Monte Carlo strategy does not expose an exact candle horizon");
assert.deepEqual(
  mcStrategy.generateSignals(candles, { ...mcStrategy.params, horizon: 1 }),
  mcStrategy.generateSignals(candles, mcStrategy.params),
  "legacy candle-horizon values do not change the multi-window Monte Carlo signal",
);

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
const consensusMc = monteCarlo({
  closes,
  horizon: SCENARIO_CONSENSUS_STEPS.at(-1),
  sims: 1000,
  method: "bootstrap",
  driftMode: "zero",
  seed: 42,
});
const consensusProbability = probabilityAboveAcrossWindows(consensusMc);
assert.ok(consensusProbability >= 0 && consensusProbability <= 1, "multi-window probability is bounded");
assert.equal(probabilityAboveAcrossWindows(null), null, "multi-window probability handles unavailable simulations");
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
// Position sizing (leveraged): stop % is position P/L, so collateral is
// riskAmount / (stopLossPercent/100) with no extra leverage multiplier.
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

  const expectedCollateralFraction = (1 / 100) / (4 / 100); // riskPercent / position-stop = 0.25
  const allInDev = levAllIn.equityCurve[2].equity - 10000;
  const riskDev = levRiskSized.equityCurve[2].equity - 10000;
  assert.ok(
    Math.abs(riskDev - allInDev * expectedCollateralFraction) < 1e-6,
    "leveraged risk-based sizing uses position-level stop, not underlying * leverage"
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
  const liqCommon = { candles: liqCandles, signals: liqSignals, feePercent: 0, initialCapital: 10000, leverage: 10 };

  const liqAllIn = runLeveragedBacktest({ ...liqCommon, sizing: null });
  assert.equal(liqAllIn.wasLiquidated, true, "all-in: the crash still triggers a liquidation");
  assert.equal(liqAllIn.equityCurve.at(-1).equity, 0, "all-in: liquidation still permanently zeroes the account (unchanged from before)");
  assert.equal(liqAllIn.trades.length, 1, "all-in: no re-entry is possible after the whole account is gone");

  const liqRiskSized = runLeveragedBacktest({
    ...liqCommon,
    riskParams: { stopLossPercent: 50 },
    sizing: { mode: "riskPercent", riskPercent: 1 },
  });
  assert.ok(liqRiskSized.trades.length >= 1, "risk-sized: the stopped trade is recorded");
  assert.ok(
    liqRiskSized.equityCurve.at(-1).equity > 9800,
    "risk-sized: a 50% position stop at 10x is a 5% coin move — idle cash survives the crash"
  );
  const stopped = liqRiskSized.trades[0];
  assert.ok(stopped.pnlPercent > -55 && stopped.pnlPercent < -45, "position stop caps the loss near 50%, not a 10x wipe");
}

{
  // 5x leverage + 25% POSITION stop: a 10% coin drop would be -50% of
  // collateral without a stop. The stop must fire at 5% of price (−25% of
  // the position), which is what the user types as "25".
  const px = [100, 100, 90, 90];
  const slCandles = px.map((c, i) => {
    const prev = i === 0 ? c : px[i - 1];
    return { time: i, open: prev, close: c, high: Math.max(prev, c), low: Math.min(prev, c) };
  });
  const slSignals = [1, 1, 1, 1];
  const slResult = runLeveragedBacktest({
    candles: slCandles,
    signals: slSignals,
    feePercent: 0,
    initialCapital: 10000,
    leverage: 5,
    riskParams: { stopLossPercent: 25, takeProfitPercent: 100 },
  });
  assert.ok(slResult.trades.length >= 1, "25% position stop actually exits");
  assert.ok(
    slResult.trades[0].pnlPercent > -28 && slResult.trades[0].pnlPercent < -22,
    "5x + typed 25% stop loses ~25% of the position, not 5×25%"
  );
  assert.ok(!slResult.trades[0].liquidated, "a 25% stop is inside liquidation, so the trade is not wiped");
}

{
  // A candle that wicks through both the 25% position stop AND the 5x
  // liquidation price (20% coin) must still fill the stop, not wipe.
  const wick = [
    { time: 0, open: 100, close: 100, high: 101, low: 99 },
    { time: 1, open: 99, close: 70, high: 99, low: 70 },
  ];
  const wickResult = runLeveragedBacktest({
    candles: wick,
    signals: [1, 1],
    feePercent: 0,
    initialCapital: 10000,
    leverage: 5,
    riskParams: { stopLossPercent: 25 },
  });
  assert.ok(wickResult.trades.length >= 1, "wide candle still records a trade");
  assert.ok(!wickResult.trades[0].liquidated, "stop fills before a through-liquidation wick");
  assert.ok(
    wickResult.trades[0].pnlPercent > -28 && wickResult.trades[0].pnlPercent < -22,
    "wide candle stop is still ~25% of the position"
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
// nextOpen equity marking: a deferred fill must not leak the gap between the
// signal bar's close and the next bar's open into the signal bar's equity.
// A large gap-up entry used to appear as an instant ~50% "drawdown" on the
// entry bar (units bought at the high next open, marked against the old low
// close) even though no position existed yet at that close.
// ---------------------------------------------------------------------------
{
  const gapCandles = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 1, open: 100, high: 100, low: 100, close: 100 }, // signal fires here
    { time: 2, open: 200, high: 200, low: 200, close: 200 }, // fill at this huge gap-up open
    { time: 3, open: 200, high: 210, low: 200, close: 210 },
    { time: 4, open: 210, high: 210, low: 210, close: 210 },
  ];
  const gapSignals = [0, 1, 1, 1, 1];
  const gapResult = runBacktest({ candles: gapCandles, signals: gapSignals, feePercent: 0, initialCapital: 10000, fillTiming: "nextOpen" });
  assert.equal(gapResult.equityCurve[1].equity, 10000, "signal-bar equity is untouched until the deferred fill actually happens");
  assert.equal(gapResult.maxDrawdownPercent, 0, "a gap-up entry produces no phantom drawdown");
  assert.equal(gapResult.trades[0].entryPrice, 200, "the deferred fill price itself is unchanged");
}

// ---------------------------------------------------------------------------
// SL/TP overlay entry anchoring under nextOpen: the stop distance must be
// measured from the price the engine actually fills at (the next bar's
// open), not from the signal bar's close. With a gap-up entry, a stop
// anchored to the stale close either fires at the wrong level or not at all.
// ---------------------------------------------------------------------------
{
  const slCandles = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 1, open: 100, high: 100, low: 100, close: 100 }, // signal fires here
    { time: 2, open: 110, high: 110, low: 110, close: 110 }, // entry fills at 110
    { time: 3, open: 110, high: 110, low: 103, close: 108 }, // dips 6.4% below the 110 fill
    { time: 4, open: 108, high: 108, low: 108, close: 108 },
    { time: 5, open: 108, high: 108, low: 108, close: 108 },
  ];
  const slSignals = [0, 1, 1, 1, 0, 0];
  const slResult = runBacktest({
    candles: slCandles,
    signals: slSignals,
    feePercent: 0,
    initialCapital: 10000,
    fillTiming: "nextOpen",
    riskParams: { stopLossPercent: 5 },
  });
  assert.equal(slResult.trades.length, 1, "the gap-adjusted stop produces exactly one trade");
  assert.equal(slResult.trades[0].entryPrice, 110, "entry books at the actual next-open fill");
  assert.ok(Math.abs(slResult.trades[0].exitPrice - 104.5) < 1e-9, "stop fills at exactly -5% from the REAL fill price (110), not from the stale signal close (100)");
  assert.ok(Math.abs(slResult.trades[0].pnlPercent - -5) < 1e-9, "realized loss is capped at the configured stop percentage");
}

// ---------------------------------------------------------------------------
// Liquidation exit price: a leveraged position that crosses -100% intrabar
// is closed at the theoretical liquidation level (entry × (1 − side/lev)),
// not at the bar's full extreme — the bar's low overstates the exit.
// ---------------------------------------------------------------------------
{
  const liqPriceCandles = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 1, open: 100, high: 100, low: 100, close: 100 }, // long opens at 100
    { time: 2, open: 100, high: 100, low: 80, close: 95 },   // low pierces far below the 90 liq level
    { time: 3, open: 95, high: 95, low: 95, close: 95 },
  ];
  const liqPriceResult = runLeveragedBacktest({
    candles: liqPriceCandles,
    signals: [0, 1, 1, 1],
    feePercent: 0,
    initialCapital: 10000,
    leverage: 10,
  });
  assert.equal(liqPriceResult.wasLiquidated, true, "the intrabar excursion triggers a liquidation");
  assert.ok(Math.abs(liqPriceResult.trades[0].exitPrice - 90) < 1e-9, "liquidation fills at the theoretical level (entry × (1 − 1/lev)), not the bar's low");
  assert.equal(liqPriceResult.trades[0].pnlPercent, -100, "liquidation loss is exactly -100% of collateral");
}

// ---------------------------------------------------------------------------
// Short-side RSI mirror: trendMomentumHybrid's short rule must mirror the
// long rule around 50 — long requires RSI > floor, so short requires
// RSI < (100 − floor). Using the floor directly is only coincidentally
// correct at the default floor of 50 and breaks for any tuned value.
// ---------------------------------------------------------------------------
{
  const p = { fastPeriod: 9, slowPeriod: 21, rsiPeriod: 14, rsiFloor: 60 };
  const shortSignals = STRATEGIES.trendMomentumHybrid.generateShortSignals(candles, p);
  const fast = ema(closes, p.fastPeriod);
  const slow = ema(closes, p.slowPeriod);
  const r = rsi(closes, p.rsiPeriod);
  const expectedShortSignals = closes.map((_, i) => {
    if (fast[i] == null || slow[i] == null || r[i] == null) return 0;
    return fast[i] < slow[i] && r[i] < 100 - p.rsiFloor ? 1 : 0;
  });
  assert.deepEqual(shortSignals, expectedShortSignals, "short RSI condition mirrors the long floor (uses 100 − rsiFloor)");
}

// ---------------------------------------------------------------------------
// Derivatives crowding sign: funding is paid BY the crowded side, so extreme
// negative funding marks crowded shorts. The old fallback branch labeled
// any |funding| > 40 as crowded_long — exactly backwards for negatives.
// ---------------------------------------------------------------------------
{
  assert.equal(classifyCrowding(60, null), "crowded_long", "extreme positive funding = crowded longs");
  assert.equal(classifyCrowding(-60, null), "crowded_short", "extreme NEGATIVE funding = crowded shorts (regression: was crowded_long)");
  assert.equal(classifyCrowding(30, 1.5), "crowded_long", "moderate positive funding + high L/S ratio = crowded longs");
  assert.equal(classifyCrowding(-20, 0.7), "crowded_short", "moderate negative funding + low L/S ratio = crowded shorts");
  assert.equal(classifyCrowding(5, 1.0), "neutral", "ordinary funding is neutral");
  assert.equal(classifyCrowding(null, 2), "neutral", "no funding data = no crowding call");
}

// ---------------------------------------------------------------------------
// Guard rails: invalid inputs return error codes (i18n keys), not NaN math.
// ---------------------------------------------------------------------------
{
  assert.equal(positionSize({ accountSize: 0, riskPercent: 1, entryPrice: 100, stopPrice: 95 }).error, "err.risk.account");
  assert.equal(positionSize({ accountSize: 10000, riskPercent: 1, entryPrice: 100, stopPrice: 100 }).error, "err.risk.prices");
  assert.equal(monteCarlo({ closes: [1, 2], horizon: 10, sims: 500 }).error, "err.mc.data");
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

{
  assert.equal(TIMEFRAMES.some((tf) => tf.id === "45m"), false, "45m is not offered (no venue has it)");
  assert.equal(TIMEFRAMES.some((tf) => tf.id === "3h"), false, "3h is not offered (mapped to 4h on every venue)");
  const cryptoTfs = auditTimeframes(false, "4h").map((tf) => tf.id);
  assert.ok(cryptoTfs.includes("15m") && cryptoTfs.includes("1w") && cryptoTfs.includes("4h"), "crypto audit sweeps 15m–1w");
  assert.equal(cryptoTfs.includes("1m"), false, "1m is too heavy for the audit sweep");
  const singleTfs = auditTimeframes(true).map((tf) => tf.id);
  assert.deepEqual(singleTfs, ["1d", "1w", "1M"]);
  const tf15 = TIMEFRAMES.find((tf) => tf.id === "15m");
  assert.ok(auditLookbackDays(tf15, 365) < 40, "a 365-day lookback does not pull a year of 15m candles");
  assert.equal(normalizeMarketSource("Binance USD-M Futures"), "binanceUsdFutures");
  assert.equal(normalizeMarketSource("binance", "USD-M Futures"), "binanceUsdFutures");
  assert.equal(normalizeMarketSource("Binance"), "binance");
  assert.equal(coinIdFromPair("ETHUSDT", "bitcoin"), "ethereum");
  assert.equal(coinIdFromPair("BTCUSDT"), "bitcoin");

  const kelly = kellyFraction({ winRatePercent: 60, avgWin: 2, avgLoss: 1 });
  assert.ok(Math.abs(kelly.full - 0.4) < 1e-9, "Kelly f* = p - (1-p)/b");
  assert.ok(Math.abs(kelly.half - 0.2) < 1e-9, "half-Kelly is f*/2");
  assert.ok(Math.abs(kelly.usable - 0.2) < 1e-9, "usable Kelly is half, already under the 25% cap");

  const winning = Array.from({ length: 20 }, (_, i) => ({ pnlPercent: i % 4 === 0 ? -1 : 2 }));
  const sqn = systemQualityNumber(winning);
  assert.ok(sqn > 1, "a positively-expectant sample has SQN > 1");

  const dsrLucky = deflatedSharpeRatio({ sharpe: 0.35, nObs: 40, nTrials: 21 });
  const dsrHonest = deflatedSharpeRatio({ sharpe: 1.2, nObs: 2000, nTrials: 1 });
  assert.ok(dsrLucky.dsr < dsrHonest.dsr, "multiple testing deflates Sharpe");
  assert.equal(dsrLucky.likelyOverfit, true, "a 0.35 Sharpe on 40 observations after 21 peeks is luck");

  const maeTrades = [{ entryTime: candles[10].time, exitTime: candles[20].time, entryPrice: candles[10].close, exitPrice: candles[20].close, pnlPercent: 5, side: 1 }];
  const mae = maeMfeAnalysis(maeTrades, candles);
  assert.ok(mae.avgMae >= 0 && mae.avgMfe >= 0, "MAE/MFE are non-negative percents");
  assert.ok(mae.stopHint >= 0 && mae.targetHint >= 0, "stop/target hints exist");

  const mcTrades = Array.from({ length: 30 }, (_, i) => ({ pnlPercent: i % 3 === 0 ? -2 : 1.5 }));
  const ruin = tradeSequenceMonteCarlo(mcTrades, { sims: 400, seed: 3, ruinDrawdownPercent: 40 });
  assert.ok(ruin.pRuin >= 0 && ruin.pRuin <= 1, "ruin probability is a probability");
  assert.ok(ruin.pDD20 >= ruin.pDD30, "P(DD≥20) ≥ P(DD≥30)");
  assert.ok(ruin.medianTerminal > 0, "median terminal wealth is positive");

  const regimes = classifyRegimes(candles);
  const labeled = regimes.filter(Boolean);
  assert.ok(labeled.length > 0, "regime classifier warms up on a trending synthetic series");
  const now = currentRegime(candles);
  assert.ok(now && Object.values(REGIME).includes(now.id), "current regime is a known id");
  const gated = gateSignalsByRegime(Array(candles.length).fill(1), regimes, [REGIME.TREND_UP]);
  assert.equal(gated.length, candles.length);
  assert.ok(gated.some((s) => s === 0) || gated.every((s) => s === 1), "regime gate returns a signal series");

  const mixedTrades = labeled.slice(0, 12).map((row, i) => ({
    entryTime: row.time,
    exitTime: row.time,
    pnlPercent: i % 2 === 0 ? 2 : -1,
  }));
  const buckets = breakdownTradesByRegime(mixedTrades, regimes);
  const assigned = Object.values(buckets).reduce((n, b) => n + b.n, 0);
  assert.equal(assigned, mixedTrades.length, "every trade lands in a regime bucket");

  const bt = runBacktest({
    candles,
    signals: STRATEGIES.buyAndHold.generateSignals(candles),
    feePercent: 0,
  });
  const enriched = enrichBacktest(bt, candles, { nTrials: 1 });
  assert.ok(enriched.maeMfe && !enriched.maeMfe.error, "buy-hold path produces MAE/MFE");
  assert.ok(enriched.kelly, "Kelly object is present even if unused");
}

{
  const sets = [
    { key: "A", candles: candles.map((c, i) => ({ ...c, close: c.close * (1 + i * 0.001) })) },
    { key: "B", candles },
  ];
  const port = runPortfolioBacktest({ candleSets: sets, weights: { A: 50, B: 50 } });
  assert.ok(port.equityCurve.length > 0, "portfolio equity");
  const { matrix } = correlationMatrix({ A: sets[0].candles.map((c) => c.close), B: sets[1].candles.map((c) => c.close) });
  assert.equal(matrix.A.A, 1);
  const rs = relativeStrength(sets[0].candles.map((c) => c.close), sets[1].candles.map((c) => c.close), 30);
  assert.ok(rs.spread != null);
  const season = seasonalityAnalysis(candles);
  assert.ok(season.dayOfWeek.length > 0);
  const stress = applyStressScenario({ weights: { A: 1 }, shocks: { __market__: -10 } });
  assert.ok(stress.portfolioReturnPercent < 0);
  const mcStress = monteCarloPortfolioStress({ weights: { A: 100 }, meanReturns: { A: 5 }, vols: { A: 20 }, sims: 100 });
  assert.ok(mcStress.p50 != null);
  const uw = underwaterEquity(port.equityCurve);
  assert.equal(uw.points.length, port.equityCurve.length);
  const token = encodeStrategyPayload({ strategyKey: "buyAndHold", params: {} });
  assert.deepEqual(decodeStrategyPayload(token), { strategyKey: "buyAndHold", params: {} });
  const mtf = evaluateMultiTfConfluence({
    strategy: STRATEGIES.buyAndHold,
    candleSets: [{ id: "1d", label: "1D", candles }],
  });
  assert.ok(mtf.rows.length === 1);
  assert.ok(estimateVolatility(candles.map((c) => c.close)) > 0);
}

console.log(
  "Model validation passed: strategies, backtest, position sizing, fill timing, risk tools, Monte Carlo (incl. block bootstrap), walk-forward validation, custom strategies, timeframes, regime, Kelly, MAE/MFE, trade-sequence Monte Carlo, deflated Sharpe, portfolio, correlation, seasonality, stress, underwater, strategy share, and multi-TF."
);
