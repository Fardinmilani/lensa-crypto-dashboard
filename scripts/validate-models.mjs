import assert from "node:assert/strict";
import { runBacktest } from "../src/lib/backtest.js";
import { STRATEGIES } from "../src/lib/strategies.js";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../src/lib/risk.js";
import { monteCarlo, outcomeZones, tradeSetups, probabilityPriceMap } from "../src/lib/forecast.js";
import { resolveTimeframe, TIMEFRAMES } from "../src/lib/coingecko.js";

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

console.log("Model validation passed: strategies, backtest, risk tools, Monte Carlo, and timeframes.");
