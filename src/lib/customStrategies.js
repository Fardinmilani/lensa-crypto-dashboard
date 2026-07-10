// lib/customStrategies.js
//
// User-authored trading rules for the Backtest page's "Custom Strategy"
// builder. Deliberately NOT a code editor: every rule is a plain JSON
// condition tree, interpreted by the small evaluator below — never eval()'d
// and never passed to `new Function`. Two reasons that matters:
//
//   1. It matches this app's own stated philosophy (see README): every
//      built-in strategy is a small, readable, auditable function with no
//      hidden control flow. A rule built here is exactly as auditable — you
//      can read its JSON and know precisely what it checks.
//   2. It keeps Export/Import of strategies (a natural feature once you can
//      build your own) completely safe. A custom strategy is just data, so
//      sharing one with somebody else can never execute arbitrary code in
//      their browser — which matters because this app also keeps a private
//      journal/watchlist in localStorage that a malicious script could
//      otherwise read and exfiltrate. A rule builder has no such attack
//      surface at all.
//
// Each compiled custom strategy has exactly the same shape as an entry in
// lib/strategies.js's STRATEGIES map ({ label, category, params,
// generateSignals, [generateShortSignals] }), so it drops straight into
// runBacktest / runLeveragedBacktest / optimizeStrategy / runAllStrategies
// with zero changes to any of them. Custom strategies don't expose numeric
// params to the Auto-Fit optimizer in this version (their tunable numbers
// live inside each condition's indicator settings instead) — optimizeStrategy
// already handles that gracefully (it returns null for a strategy with no
// top-level numeric params, and the UI already shows "unavailable" for that).

import { sma, ema, rsi, macd, bollinger, roc, rollingMaxExclusive, rollingMinExclusive } from "./strategies.js";

const STORAGE_KEY = "lensa.strategies.custom";

/** Indicator registry: id -> the numeric fields its condition-row UI needs. */
export const INDICATOR_DEFS = {
  close: { fields: [] },
  sma: { fields: [{ key: "period", default: 20, min: 2, max: 400 }] },
  ema: { fields: [{ key: "period", default: 20, min: 2, max: 400 }] },
  rsi: { fields: [{ key: "period", default: 14, min: 2, max: 200 }] },
  macdLine: {
    fields: [
      { key: "fast", default: 12, min: 2, max: 200 },
      { key: "slow", default: 26, min: 2, max: 400 },
      { key: "signal", default: 9, min: 2, max: 100 },
    ],
  },
  macdSignal: {
    fields: [
      { key: "fast", default: 12, min: 2, max: 200 },
      { key: "slow", default: 26, min: 2, max: 400 },
      { key: "signal", default: 9, min: 2, max: 100 },
    ],
  },
  bbUpper: { fields: [{ key: "period", default: 20, min: 2, max: 400 }, { key: "mult", default: 2, min: 0.5, max: 6 }] },
  bbMid: { fields: [{ key: "period", default: 20, min: 2, max: 400 }, { key: "mult", default: 2, min: 0.5, max: 6 }] },
  bbLower: { fields: [{ key: "period", default: 20, min: 2, max: 400 }, { key: "mult", default: 2, min: 0.5, max: 6 }] },
  roc: { fields: [{ key: "period", default: 10, min: 1, max: 400 }] },
  highestHigh: { fields: [{ key: "period", default: 20, min: 2, max: 400 }] },
  lowestLow: { fields: [{ key: "period", default: 20, min: 2, max: 400 }] },
};

export const INDICATOR_KEYS = Object.keys(INDICATOR_DEFS);

export const OPERATORS = [">", "<", ">=", "<=", "crossesAbove", "crossesBelow"];

const OPERATOR_FLIP = {
  ">": "<",
  "<": ">",
  ">=": "<=",
  "<=": ">=",
  crossesAbove: "crossesBelow",
  crossesBelow: "crossesAbove",
};

export function makeIndicatorNode(type) {
  const def = INDICATOR_DEFS[type];
  const node = { type };
  for (const f of def?.fields || []) node[f.key] = f.default;
  return node;
}

export function makeCondition() {
  return { left: makeIndicatorNode("close"), op: ">", right: { type: "value", value: 0 } };
}

function seriesFor(candles, node) {
  if (!node) return null;
  const closes = candles.map((c) => c.close);
  switch (node.type) {
    case "close":
      return closes;
    case "sma":
      return sma(closes, node.period);
    case "ema":
      return ema(closes, node.period);
    case "rsi":
      return rsi(closes, node.period);
    case "macdLine":
      return macd(closes, node.fast, node.slow, node.signal).macdLine;
    case "macdSignal":
      return macd(closes, node.fast, node.slow, node.signal).signalLine;
    case "bbUpper":
      return bollinger(closes, node.period, node.mult).upper;
    case "bbMid":
      return bollinger(closes, node.period, node.mult).mid;
    case "bbLower":
      return bollinger(closes, node.period, node.mult).lower;
    case "roc":
      return roc(closes, node.period);
    case "highestHigh":
      return rollingMaxExclusive(candles.map((c) => c.high), node.period);
    case "lowestLow":
      return rollingMinExclusive(candles.map((c) => c.low), node.period);
    default:
      throw new Error(`اندیکاتور ناشناخته: ${node.type}`);
  }
}

function applyOp(op, l, r) {
  switch (op) {
    case ">": return l > r;
    case "<": return l < r;
    case ">=": return l >= r;
    case "<=": return l <= r;
    default: return false;
  }
}

/** Evaluate one { left, op, right } condition across the whole series, returning a boolean array. */
function evalCondition(candles, cond, cache) {
  const key = JSON.stringify(cond);
  if (cache.has(key)) return cache.get(key);

  const left = seriesFor(candles, cond.left);
  const right =
    cond.right?.type === "value" ? candles.map(() => Number(cond.right.value)) : seriesFor(candles, cond.right);

  const out = new Array(candles.length).fill(false);
  const isCross = cond.op === "crossesAbove" || cond.op === "crossesBelow";
  for (let i = 0; i < candles.length; i++) {
    const l = left[i];
    const r = right[i];
    if (l == null || r == null) continue;
    if (isCross) {
      if (i === 0) continue;
      const pl = left[i - 1];
      const pr = right[i - 1];
      if (pl == null || pr == null) continue;
      out[i] = cond.op === "crossesAbove" ? pl <= pr && l > r : pl >= pr && l < r;
    } else {
      out[i] = applyOp(cond.op, l, r);
    }
  }
  cache.set(key, out);
  return out;
}

function evalGroup(candles, conditions, combine, cache) {
  if (!conditions?.length) return new Array(candles.length).fill(false);
  const evaluated = conditions.map((c) => evalCondition(candles, c, cache));
  const n = candles.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = combine === "OR" ? evaluated.some((arr) => arr[i]) : evaluated.every((arr) => arr[i]);
  }
  return out;
}

/** Flip every condition's operator (e.g. ">" -> "<") — used to mirror an "immediate" rule for the short side. */
function flipConditions(conditions) {
  return (conditions || []).map((c) => ({ ...c, op: OPERATOR_FLIP[c.op] || c.op }));
}

/**
 * Compile a user-authored definition into a STRATEGIES-shaped strategy
 * object. `def.sustain === "hold"` uses two independent groups (entryConditions
 * / exitConditions) and latches a position on between them — the same
 * pattern the built-in rsiThreshold/bollingerReversion/donchianBreakout
 * strategies use. Otherwise ("immediate") a single `conditions` group is
 * used directly as the 0/1 signal, stateless, like smaCrossover/macdCross.
 */
export function buildCustomStrategy(def) {
  return {
    label: { en: def.name, fa: def.name },
    description: {
      en: "User-defined rule built in the Strategy Builder.",
      fa: "قانونی که در سازنده‌ی استراتژی توسط کاربر ساخته شده است.",
    },
    category: "custom",
    isCustom: true,
    params: {},
    generateSignals(candles) {
      const cache = new Map();
      if (def.sustain === "hold") {
        const entryActive = evalGroup(candles, def.conditions, def.combine, cache);
        const exitActive = evalGroup(candles, def.exitConditions, def.exitCombine || def.combine, cache);
        const out = new Array(candles.length).fill(0);
        let inPos = false;
        for (let i = 0; i < candles.length; i++) {
          if (!inPos && entryActive[i]) inPos = true;
          else if (inPos && exitActive[i]) inPos = false;
          out[i] = inPos ? 1 : 0;
        }
        return out;
      }
      const active = evalGroup(candles, def.conditions, def.combine, cache);
      return active.map((a) => (a ? 1 : 0));
    },
    // Short support ships only for "immediate" rules in this version — the
    // operator-flip mirror below is a faithful short version of a level
    // condition (exactly how the built-in smaCrossover/emaCrossover
    // strategies define their own generateShortSignals). "hold" rules with
    // two independently-authored condition groups don't have a single,
    // always-correct mirror (e.g. a mean-reversion rule's short side needs
    // its own thresholds, not a mechanical flip), so they're long-only here
    // — the same graceful "no short rule for this strategy" state the
    // Backtest page already handles for several built-ins.
    ...(def.sustain !== "hold" && def.mirrorShort
      ? {
          generateShortSignals(candles) {
            const cache = new Map();
            const active = evalGroup(candles, flipConditions(def.conditions), def.combine, cache);
            return active.map((a) => (a ? 1 : 0));
          },
        }
      : {}),
  };
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Every saved custom strategy definition, in creation order. */
export function loadCustomDefs() {
  if (typeof window === "undefined") return [];
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY), []);
  } catch {
    return [];
  }
}

function persist(defs) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(defs));
  } catch {
    /* localStorage may be unavailable in private or locked-down contexts */
  }
}

export function saveCustomDef(def) {
  const defs = loadCustomDefs();
  const idx = defs.findIndex((d) => d.id === def.id);
  if (idx >= 0) defs[idx] = def;
  else defs.push(def);
  persist(defs);
  return defs;
}

export function deleteCustomDef(id) {
  const defs = loadCustomDefs().filter((d) => d.id !== id);
  persist(defs);
  return defs;
}

export function newCustomDefId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Every saved custom strategy, already compiled and keyed by id — ready to merge into STRATEGIES. */
export function loadCompiledCustomStrategies() {
  const out = {};
  for (const def of loadCustomDefs()) {
    try {
      out[def.id] = buildCustomStrategy(def);
    } catch {
      // Skip a corrupted definition rather than breaking the whole registry.
    }
  }
  return out;
}

/** Built-in STRATEGIES merged with whatever custom strategies are saved locally. */
export function getAllStrategies(builtins) {
  return { ...builtins, ...loadCompiledCustomStrategies() };
}
