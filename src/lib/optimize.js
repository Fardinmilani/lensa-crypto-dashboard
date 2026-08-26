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
import { runBacktest, runLeveragedBacktest, summarizeEquityCurve } from "./backtest.js";
import { runOptionsStrategy, OPTIONS_STRATEGIES } from "./options.js";

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
export function scoreResult(result) {
  if (!result || result.tradeCount < MIN_TRADES_FOR_SCORING) return -Infinity;
  const riskAdjusted = Number.isFinite(result.sharpe) ? result.sharpe : (result.totalReturnPercent || 0) / 50;
  const drawdownPenalty = (result.maxDrawdownPercent || 0) / 100;
  return riskAdjusted - drawdownPenalty * 1.5;
}

function runOne({ strategy, candles, params, direction, leverage, feePercent, riskParams, sizing = null, fillTiming = "close" }) {
  const signals = combineDirectionalSignals(strategy, candles, params, direction);
  return runOnSignals({ candles, signals, direction, leverage, feePercent, riskParams, sizing, fillTiming });
}

function runOnSignals({ candles, signals, direction, leverage, feePercent, riskParams, sizing = null, fillTiming = "close" }) {
  return leverage > 1 || direction !== "long"
    ? runLeveragedBacktest({ candles, signals, feePercent, leverage, riskParams, sizing, fillTiming })
    : runBacktest({ candles, signals, feePercent, riskParams, sizing, fillTiming });
}

// ---------------------------------------------------------------------------
// Walk-forward (out-of-sample) candidate selection
// ---------------------------------------------------------------------------
//
// A plain grid search — score every candidate over the WHOLE history, keep
// the highest score — just picks whichever combination best fits the noise
// of this exact history. That is the textbook overfitting failure mode
// this file already warns about above, and it's what optimizeStrategy()
// used to do.
//
// Fix: the first half of the candle history is reserved purely as context
// (never scored — this is when indicators warm up and a strategy's early,
// unreliable signals live), and the remaining, more-recent half is cut into
// several forward-rolling windows. Every candidate is scored ONLY on how it
// performs on these windows — data no candidate was chosen using — and its
// final ranking score is the WORST of its per-window scores, not the
// average. A parameter set that looks great across three stretches of
// history and collapses on a fourth is exactly the fragile, regime-specific
// result a robustness check needs to catch; requiring it to hold up on
// every window (not just on average) is what "doesn't overfit" cashes out
// to mathematically here.
//
// One further window — the most recent one — is never used for selection
// at all and is only scored afterwards, as a final untouched check on the
// winner (the same train/validation/test idea used to avoid tuning against
// your own test set).
//
// If there isn't enough history to form at least one selection window plus
// one holdout window, this returns null and optimizeStrategy() falls back
// to the old whole-history search (flagged via `robust: false` on the
// returned fit so the caller can surface that honestly rather than silently
// pretending every fit was validated).
const OOS_MIN_WINDOW = 20;
const OOS_MAX_SELECTION_WINDOWS = 4; // + 1 held-out final window
const OOS_CONTEXT_FRACTION = 0.5;

function buildOosWindows(candleCount) {
  const contextEnd = Math.floor(candleCount * OOS_CONTEXT_FRACTION);
  const oosCount = candleCount - contextEnd;
  const windowCount = Math.min(OOS_MAX_SELECTION_WINDOWS + 1, Math.floor(oosCount / OOS_MIN_WINDOW));
  if (windowCount < 2) return null; // need at least 1 selection window + 1 holdout
  const size = Math.floor(oosCount / windowCount);
  if (size < OOS_MIN_WINDOW) return null;

  const windows = [];
  for (let w = 0; w < windowCount; w++) {
    const testStart = contextEnd + w * size;
    const testEnd = w === windowCount - 1 ? candleCount : testStart + size; // last window absorbs any remainder
    windows.push({ testStart, testEnd });
  }
  return windows; // last entry = held-out final window; the rest = selection windows
}

// The full-range scoreResult() requires >= MIN_TRADES_FOR_SCORING trades to
// return anything but -Infinity. That floor makes sense over the whole
// backtest range, but each OOS *window* here only covers a slice of it —
// plenty of ordinary, low-frequency trend-following strategies place only
// a handful of trades across the ENTIRE history, so demanding 3+ trades in
// every individual window would disqualify nearly everything and defeat
// the point. A window with zero trades just means the strategy sat out
// that stretch, which is neutral, not bad — so it scores 0 rather than
// -Infinity. The statistical-sample concern this floor exists for is
// instead enforced once, in aggregate, across all selection windows
// combined (see MIN_TOTAL_OOS_TRADES below).
function scoreWindowResult(result) {
  if (!result || result.tradeCount === 0) return 0;
  const riskAdjusted = Number.isFinite(result.sharpe) ? result.sharpe : (result.totalReturnPercent || 0) / 50;
  const drawdownPenalty = (result.maxDrawdownPercent || 0) / 100;
  return riskAdjusted - drawdownPenalty * 1.5;
}

const MIN_TOTAL_OOS_TRADES = 3;

/**
 * Worst-case score of one candidate across the selection windows only
 * (never the holdout), plus its total trade count across those windows.
 * Computes the candidate's signal series ONCE over the FULL candle history
 * — so every indicator has its normal lookback context — then slices
 * candles+signals together per window for scoring. Slicing candles alone
 * and regenerating signals from just that short slice would throw away all
 * of that warm-up context and starve short windows of trades, which would
 * wrongly disqualify almost every candidate.
 */
function scoreCandidateOutOfSample({ strategy, candles, params, direction, leverage, feePercent, riskParams, sizing, fillTiming, selectionWindows }) {
  let fullSignals;
  try {
    fullSignals = combineDirectionalSignals(strategy, candles, params, direction);
  } catch {
    return { score: -Infinity, totalTrades: 0 };
  }
  let worst = Infinity;
  let totalTrades = 0;
  for (const w of selectionWindows) {
    let result;
    try {
      result = runOnSignals({
        candles: candles.slice(w.testStart, w.testEnd),
        signals: fullSignals.slice(w.testStart, w.testEnd),
        direction,
        leverage,
        feePercent,
        riskParams,
        sizing,
        fillTiming,
      });
    } catch {
      return { score: -Infinity, totalTrades: 0 };
    }
    totalTrades += result.tradeCount;
    const score = scoreWindowResult(result);
    if (score < worst) worst = score;
  }
  return { score: Number.isFinite(worst) ? worst : -Infinity, totalTrades };
}

/**
 * Fit the best-scoring parameter combination for a single strategy.
 * Returns null if the strategy has no numeric params to tune.
 *
 * Selection is walk-forward / out-of-sample whenever there's enough history
 * for it (see buildOosWindows above) — candidates are ranked purely by
 * worst-case performance on data they were never picked using, not by how
 * well they fit the whole range. bestResult/baselineResult are still
 * computed over the full candle range regardless, so the shape of what
 * gets displayed (equity curve, total return, etc.) is unchanged either way.
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

  const windows = buildOosWindows(candles.length);
  let best = null;
  let robust = false;
  let holdout = null;

  if (windows) {
    const selectionWindows = windows.slice(0, -1);
    const scoreArgs = { strategy, candles, direction, leverage, feePercent, riskParams, sizing, fillTiming, selectionWindows };

    let bestCombo = defaultParams;
    let bestEval = scoreCandidateOutOfSample({ ...scoreArgs, params: defaultParams });
    for (const combo of combos) {
      const evalResult = scoreCandidateOutOfSample({ ...scoreArgs, params: combo });
      if (evalResult.score > bestEval.score) {
        bestEval = evalResult;
        bestCombo = combo;
      }
    }

    // Trust the winner as walk-forward validated only if it actually
    // traded enough times, in total, across the selection windows to mean
    // something statistically — a "winner" that only ever saw one trade
    // isn't meaningfully validated, it just got lucky (or unlucky) once.
    // Otherwise fall through to the plain in-sample search below and say
    // so honestly via `robust: false`.
    if (Number.isFinite(bestEval.score) && bestEval.totalTrades >= MIN_TOTAL_OOS_TRADES) {
      robust = true;
      const bestResult = runOne({ strategy, candles, params: bestCombo, direction, leverage, feePercent, riskParams, sizing, fillTiming });
      best = { params: bestCombo, result: bestResult, score: scoreResult(bestResult) };

      const holdoutWindow = windows[windows.length - 1];
      const holdoutCandles = candles.slice(holdoutWindow.testStart, holdoutWindow.testEnd);
      const bestFullSignals = combineDirectionalSignals(strategy, candles, bestCombo, direction);
      const defaultFullSignals = combineDirectionalSignals(strategy, candles, defaultParams, direction);
      const fittedHoldout = runOnSignals({
        candles: holdoutCandles,
        signals: bestFullSignals.slice(holdoutWindow.testStart, holdoutWindow.testEnd),
        direction,
        leverage,
        feePercent,
        riskParams,
        sizing,
        fillTiming,
      });
      const defaultHoldout = runOnSignals({
        candles: holdoutCandles,
        signals: defaultFullSignals.slice(holdoutWindow.testStart, holdoutWindow.testEnd),
        direction,
        leverage,
        feePercent,
        riskParams,
        sizing,
        fillTiming,
      });
      holdout = {
        candleCount: holdoutCandles.length,
        fittedReturnPercent: fittedHoldout.totalReturnPercent,
        defaultReturnPercent: defaultHoldout.totalReturnPercent,
        fittedScore: scoreResult(fittedHoldout),
        defaultScore: scoreResult(defaultHoldout),
      };
    }
  }

  if (!robust) {
    // No usable walk-forward split for this call (too little history, or
    // every candidate was disqualified above) — same whole-history search
    // this function has always done, clearly flagged as unvalidated.
    best = { params: defaultParams, result: baselineResult, score: baselineScore };
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
  }

  return {
    bestParams: best.params,
    bestResult: best.result,
    baselineParams: defaultParams,
    baselineResult,
    testedCount: combos.length,
    improved: best.score > baselineScore,
    robust,
    holdout,
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

  // Score the test slice with WARM indicators: generate signals over the
  // full history, then slice candles+signals together — the same approach
  // scoreCandidateOutOfSample() uses and documents above. Regenerating
  // signals from the bare test slice would cold-start every indicator
  // (an SMA200 sees almost nothing in a 30% tail), starving the test
  // period of trades and making testScore incomparable to trainScore.
  const evalOnTestSlice = (params) => {
    const fullSignals = combineDirectionalSignals(strategy, candles, params, direction);
    return runOnSignals({
      candles: testCandles,
      signals: fullSignals.slice(splitIndex),
      direction,
      leverage,
      feePercent,
      riskParams,
      sizing,
      fillTiming,
    });
  };
  const testFittedResult = evalOnTestSlice(fit.bestParams);
  const testDefaultResult = evalOnTestSlice(strategy.params);

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

// ---------------------------------------------------------------------------
// Options-strategy fitting
// ---------------------------------------------------------------------------
//
// Mechanically the same idea as optimizeStrategy() above — build a bounded
// candidate grid around the strategy's default params, rank by worst-case
// out-of-sample score across several forward-rolling windows when there's
// enough history for it, validate the winner on a final untouched holdout
// window — just run through runOptionsStrategy()/summarizeEquityCurve()
// instead of the directional-signal backtest engine. Kept as separate
// functions rather than parameterizing optimizeStrategy() itself because
// the two "run one candidate" primitives (signals+backtest vs. option-leg
// roll simulation) don't share a signature worth forcing together.

const MIN_TOTAL_OOS_ROLLS = 3; // same idea as MIN_TOTAL_OOS_TRADES, counted in rolls instead of trades

function runOneOption({ kind, candles, params, initialCapital = 10000 }) {
  const sim = runOptionsStrategy({ candles, kind, params, initialCapital });
  const result = summarizeEquityCurve(sim.equityCurve, { initialCapital, candles });
  result.tradeCount = sim.rolls.length; // so scoreResult()'s trade-count floor applies to rolls too
  result.rolls = sim.rolls;
  result.isOptions = true;
  return result;
}

function scoreOptionsCandidateOutOfSample({ kind, candles, params, initialCapital, selectionWindows }) {
  let worst = Infinity;
  let totalRolls = 0;
  for (const w of selectionWindows) {
    const slice = candles.slice(w.testStart, w.testEnd);
    let result;
    try {
      result = runOneOption({ kind, candles: slice, params, initialCapital });
    } catch {
      return { score: -Infinity, totalRolls: 0 };
    }
    totalRolls += result.tradeCount;
    const score = scoreWindowResult(result);
    if (score < worst) worst = score;
  }
  return { score: Number.isFinite(worst) ? worst : -Infinity, totalRolls };
}

/**
 * Fit the best-scoring parameter combination for one OPTIONS_STRATEGIES
 * entry. Same walk-forward selection + holdout validation as
 * optimizeStrategy(); see the comments above buildOosWindows for the full
 * reasoning. Returns null for an unknown strategy key.
 */
export function optimizeOptionsStrategy({ kind, candles, initialCapital = 10000, maxCombos = DEFAULT_MAX_COMBOS }) {
  const def = OPTIONS_STRATEGIES[kind];
  if (!def) return null;
  const defaultParams = def.params;

  const combos = buildCombos(defaultParams, maxCombos);
  const baselineResult = runOneOption({ kind, candles, params: defaultParams, initialCapital });
  const baselineScore = scoreResult(baselineResult);

  const windows = buildOosWindows(candles.length);
  let best = null;
  let robust = false;
  let holdout = null;

  if (windows) {
    const selectionWindows = windows.slice(0, -1);
    const scoreArgs = { kind, candles, initialCapital, selectionWindows };

    let bestCombo = defaultParams;
    let bestEval = scoreOptionsCandidateOutOfSample({ ...scoreArgs, params: defaultParams });
    for (const combo of combos) {
      const evalResult = scoreOptionsCandidateOutOfSample({ ...scoreArgs, params: combo });
      if (evalResult.score > bestEval.score) {
        bestEval = evalResult;
        bestCombo = combo;
      }
    }

    if (Number.isFinite(bestEval.score) && bestEval.totalRolls >= MIN_TOTAL_OOS_ROLLS) {
      robust = true;
      const bestResult = runOneOption({ kind, candles, params: bestCombo, initialCapital });
      best = { params: bestCombo, result: bestResult, score: scoreResult(bestResult) };

      const holdoutWindow = windows[windows.length - 1];
      const holdoutCandles = candles.slice(holdoutWindow.testStart, holdoutWindow.testEnd);
      const fittedHoldout = runOneOption({ kind, candles: holdoutCandles, params: bestCombo, initialCapital });
      const defaultHoldout = runOneOption({ kind, candles: holdoutCandles, params: defaultParams, initialCapital });
      holdout = {
        candleCount: holdoutCandles.length,
        fittedReturnPercent: fittedHoldout.totalReturnPercent,
        defaultReturnPercent: defaultHoldout.totalReturnPercent,
        fittedScore: scoreResult(fittedHoldout),
        defaultScore: scoreResult(defaultHoldout),
      };
    }
  }

  if (!robust) {
    // No usable walk-forward split (too little history, or every candidate
    // was disqualified above) — plain whole-history search, clearly
    // flagged as unvalidated via robust: false.
    best = { params: defaultParams, result: baselineResult, score: baselineScore };
    for (const combo of combos) {
      let result;
      try {
        result = runOneOption({ kind, candles, params: combo, initialCapital });
      } catch {
        continue;
      }
      const score = scoreResult(result);
      if (score > best.score) best = { params: combo, result, score };
    }
  }

  return {
    bestParams: best.params,
    bestResult: best.result,
    baselineParams: defaultParams,
    baselineResult,
    testedCount: combos.length,
    improved: best.score > baselineScore,
    robust,
    holdout,
  };
}

/**
 * Fit best-scoring parameters across every strategy in OPTIONS_STRATEGIES.
 * The options-side equivalent of optimizeAllStrategies().
 */
export function optimizeAllOptionsStrategies({ candles, initialCapital = 10000, maxCombosPerStrategy = 30 }) {
  const out = {};
  for (const key of Object.keys(OPTIONS_STRATEGIES)) {
    try {
      const fit = optimizeOptionsStrategy({ kind: key, candles, initialCapital, maxCombos: maxCombosPerStrategy });
      if (fit) out[key] = fit;
    } catch {
      // Skip strategies that fail to fit; the caller falls back to that
      // strategy's own default params.
    }
  }
  return out;
}
