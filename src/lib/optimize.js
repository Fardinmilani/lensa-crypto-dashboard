// lib/optimize.js
// Lightweight parameter-fitting for the strategies in lib/strategies.js.
//
// This is deliberately NOT a machine-learning optimizer. It builds a small,
// bounded search space around each strategy's default parameters (scaling
// each numeric field up/down by a handful of multiples, respecting whether
// the field looks like an integer "period" or a float "threshold"), runs
// the exact same backtest engine used by the Backtest page against every
// combination, and keeps whichever combination scores best on a composite
// of risk-adjusted return, total return, and drawdown — while requiring a
// minimum number of trades so a single lucky trade can't "win" the search.
//
// IMPORTANT: this fits parameters to PAST data (in-sample optimization).
// A parameter set that looks best over the backtest window is not
// guaranteed to perform well going forward — this is the classic
// over-fitting risk of any parameter search, and the UI surfaces that
// caveat rather than hiding it.

import { combineDirectionalSignals } from "./strategies.js";
import { runBacktest, runLeveragedBacktest } from "./backtest.js";

const DEFAULT_MAX_COMBOS = 90;
const MIN_TRADES_FOR_SCORING = 3;

function isIntegerish(name, value) {
  return Number.isInteger(value) && (/period|Period|window|Window|length|Length/.test(name) || Number.isInteger(value));
}

function clampMin(value, min) {
  return Math.max(min, value);
}

/**
 * Build a small set of candidate values for a single parameter, centered on
 * its current/default value.
 */
function candidatesFor(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return [value];

  const lower = name.toLowerCase();
  const isBoundedPercent = lower.includes("oversold") || lower.includes("overbought") || lower.includes("floor") || lower.includes("cap");
  const integerLike = isIntegerish(name, value);

  let raw;
  if (isBoundedPercent) {
    raw = [value - 15, value - 8, value, value + 8, value + 15].map((v) => Math.round(Math.max(1, Math.min(99, v))));
  } else if (value === 0) {
    raw = [0, 0.5, 1, 2, 5];
  } else if (integerLike) {
    raw = [value * 0.5, value * 0.75, value, value * 1.5, value * 2].map((v) => clampMin(Math.round(v), 2));
  } else {
    raw = [value * 0.5, value * 0.75, value, value * 1.5, value * 2].map((v) => Math.round(v * 100) / 100);
  }
  // De-duplicate while preserving order, and always guarantee the original
  // default value is present so "no change" is always a candidate.
  const set = Array.from(new Set([value, ...raw]));
  return set;
}

/**
 * Cartesian product of per-parameter candidate arrays, expressed as an
 * array of {name: value} objects. If the full grid would exceed maxCombos,
 * falls back to random sampling (always including the exact default combo).
 */
function buildCombos(defaultParams, maxCombos = DEFAULT_MAX_COMBOS) {
  const keys = Object.keys(defaultParams);
  const space = keys.map((k) => candidatesFor(k, defaultParams[k]));
  const totalSize = space.reduce((a, arr) => a * arr.length, 1);

  const toCombo = (indices) => {
    const obj = {};
    keys.forEach((k, i) => { obj[k] = space[i][indices[i]]; });
    return obj;
  };

  if (totalSize <= maxCombos) {
    const combos = [];
    const indices = new Array(keys.length).fill(0);
    for (let n = 0; n < totalSize; n++) {
      combos.push(toCombo(indices));
      for (let i = 0; i < indices.length; i++) {
        indices[i]++;
        if (indices[i] < space[i].length) break;
        indices[i] = 0;
      }
    }
    return combos;
  }

  // Random sample without replacement (approximately), always including
  // the default combo first.
  const seen = new Set();
  const combos = [{ ...defaultParams }];
  seen.add(JSON.stringify(defaultParams));
  let guard = 0;
  while (combos.length < maxCombos && guard < maxCombos * 20) {
    guard++;
    const indices = keys.map((_, i) => Math.floor(Math.random() * space[i].length));
    const combo = toCombo(indices);
    const sig = JSON.stringify(combo);
    if (seen.has(sig)) continue;
    seen.add(sig);
    combos.push(combo);
  }
  return combos;
}

/**
 * Composite score used to rank a backtest result. Rewards risk-adjusted
 * return (Sharpe) when available, falls back to raw return when the
 * equity curve is too short/flat for a Sharpe figure, and subtracts a
 * drawdown penalty so a parameter set that merely got lucky on a huge,
 * volatile swing doesn't automatically win over a steadier one.
 */
function scoreResult(result) {
  if (!result || result.tradeCount < MIN_TRADES_FOR_SCORING) return -Infinity;
  const riskAdjusted = Number.isFinite(result.sharpe) ? result.sharpe : (result.totalReturnPercent || 0) / 50;
  const drawdownPenalty = (result.maxDrawdownPercent || 0) / 100;
  return riskAdjusted - drawdownPenalty * 1.5;
}

function runOne({ strategy, candles, params, direction, leverage, feePercent, riskParams, sizing = null, fillTiming = "close" }) {
  const signals = combineDirectionalSignals(strategy, candles, params, direction);
  const result = leverage > 1 || direction !== "long"
    ? runLeveragedBacktest({ candles, signals, feePercent, leverage, riskParams, sizing, fillTiming })
    : runBacktest({ candles, signals, feePercent, riskParams, sizing, fillTiming });
  return result;
}

/**
 * Fit the best-scoring parameter combination for a single strategy.
 * Returns null if the strategy has no numeric params to tune.
 */
export function optimizeStrategy({
  strategy,
  candles,
  direction = "long",
  leverage = 1,
  feePercent = 0.1,
  riskParams = null,
  sizing = null,
  fillTiming = "close",
  maxCombos = DEFAULT_MAX_COMBOS,
}) {
  const defaultParams = strategy.params || {};
  const numericKeys = Object.keys(defaultParams).filter((k) => typeof defaultParams[k] === "number");
  if (!numericKeys.length) return null;

  const combos = buildCombos(defaultParams, maxCombos);
  const baselineResult = runOne({ strategy, candles, params: defaultParams, direction, leverage, feePercent, riskParams, sizing, fillTiming });
  const baselineScore = scoreResult(baselineResult);

  let best = { params: defaultParams, result: baselineResult, score: baselineScore };
  for (const combo of combos) {
    let result;
    try {
      result = runOne({ strategy, candles, params: combo, direction, leverage, feePercent, riskParams, sizing, fillTiming });
    } catch {
      continue;
    }
    const score = scoreResult(result);
    if (score > best.score) best = { params: combo, result, score };
  }

  return {
    bestParams: best.params,
    bestResult: best.result,
    baselineParams: defaultParams,
    baselineResult,
    testedCount: combos.length,
    improved: best.score > baselineScore,
  };
}

/**
 * Fit best-scoring parameters across every strategy in a STRATEGIES-shaped
 * map. Uses a smaller per-strategy combo budget than optimizeStrategy alone
 * since this multiplies out across every strategy in the registry.
 */
export function optimizeAllStrategies({
  strategies,
  candles,
  direction = "long",
  leverage = 1,
  feePercent = 0.1,
  riskParams = null,
  sizing = null,
  fillTiming = "close",
  maxCombosPerStrategy = 30,
}) {
  const out = {};
  for (const [key, strategy] of Object.entries(strategies)) {
    if (!strategy.params || !Object.keys(strategy.params).some((k) => typeof strategy.params[k] === "number")) continue;
    try {
      const fit = optimizeStrategy({
        strategy,
        candles,
        direction,
        leverage,
        feePercent,
        riskParams,
        sizing,
        fillTiming,
        maxCombos: maxCombosPerStrategy,
      });
      if (fit) out[key] = fit;
    } catch {
      // Skip strategies that fail to fit (e.g. malformed params); the
      // caller falls back to that strategy's own default params.
    }
  }
  return out;
}

/**
 * Out-of-sample validation for optimizeStrategy(). Fits parameters using
 * only the first `trainRatio` share of the candle history, then evaluates
 * that fitted set — and, for direct comparison, the strategy's shipped
 * defaults — on the untouched remainder the search never saw.
 *
 * This is the standard guard against the in-sample overfitting risk
 * documented at the top of this file: a parameter set that only looks good
 * because the search saw the entire history, including the very data it's
 * later "predicting", tells you nothing about how it would have performed
 * on data it never saw. A large gap between trainScore and testScore is
 * the textbook signature of a parameter set that was fit to noise rather
 * than to a genuine, persistent edge.
 *
 * Returns null if there isn't enough history to form a meaningful train/
 * test split (mirrors the same "not enough data" guard used elsewhere).
 */
export function walkForwardValidate({
  strategy,
  candles,
  direction = "long",
  leverage = 1,
  feePercent = 0.1,
  riskParams = null,
  sizing = null,
  fillTiming = "close",
  trainRatio = 0.7,
  maxCombos = DEFAULT_MAX_COMBOS,
}) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const ratio = Math.min(0.9, Math.max(0.1, trainRatio));
  const splitIndex = Math.floor(candles.length * ratio);
  const trainCandles = candles.slice(0, splitIndex);
  const testCandles = candles.slice(splitIndex);
  if (trainCandles.length < 30 || testCandles.length < 15) return null;

  const fit = optimizeStrategy({ strategy, candles: trainCandles, direction, leverage, feePercent, riskParams, sizing, fillTiming, maxCombos });
  if (!fit) return null;

  const testFittedResult = runOne({ strategy, candles: testCandles, params: fit.bestParams, direction, leverage, feePercent, riskParams, sizing, fillTiming });
  const testDefaultResult = runOne({ strategy, candles: testCandles, params: strategy.params, direction, leverage, feePercent, riskParams, sizing, fillTiming });

  return {
    trainRatio: ratio,
    trainCandleCount: trainCandles.length,
    testCandleCount: testCandles.length,
    fittedParams: fit.bestParams,
    defaultParams: strategy.params,
    trainResult: fit.bestResult,
    testFittedResult,
    testDefaultResult,
    trainScore: scoreResult(fit.bestResult),
    testScore: scoreResult(testFittedResult),
  };
}
