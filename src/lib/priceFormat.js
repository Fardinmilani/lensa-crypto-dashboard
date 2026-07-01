const MAX_DECIMALS = 12;

export function decimalsFromStep(step) {
  const n = Number(step);
  if (!Number.isFinite(n) || n <= 0) return null;
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(MAX_DECIMALS, Number(text.split("e-")[1]) || 0);
  const [, fraction = ""] = text.split(".");
  return Math.min(MAX_DECIMALS, fraction.replace(/0+$/, "").length);
}

export function inferPriceDecimals(price, mode = "display") {
  const n = Math.abs(Number(price));
  const extra = mode === "futures" || mode === "trading" ? 1 : 0;
  if (!Number.isFinite(n) || n === 0) return 2 + extra;
  if (n >= 1000) return 2 + extra;
  if (n >= 100) return 3 + extra;
  if (n >= 10) return 4 + extra;
  if (n >= 1) return Math.min(6, 5 + extra);
  if (n >= 0.1) return Math.min(7, 6 + extra);
  if (n >= 0.01) return Math.min(8, 7 + extra);
  if (n >= 0.0001) return Math.min(10, 8 + extra);
  return MAX_DECIMALS;
}

// `meta.pricePrecision` is `null`/`undefined` whenever an exchange's
// precision endpoint hasn't resolved yet or failed (see the several
// `pricePrecision: null` fallbacks in coingecko.js, and forex's
// inferPrecisionFromCandles). `Number(null)` is `0` and `Number.isFinite(0)`
// is true, so a naive `Number.isFinite(Number(meta.pricePrecision))` check
// would treat "no precision known" as "exactly 0 decimals of precision",
// silently rounding every price to a whole number. hasExplicitPrecision()
// requires the value to actually be present (and a real number) before
// trusting it, so "we don't know" correctly falls through to the
// price-magnitude-based auto-detection in inferPriceDecimals() instead.
function hasExplicitPrecision(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

export function precisionFromMeta(meta = {}, price, mode = "display") {
  const tickDecimals = decimalsFromStep(meta.tickSize);
  if (tickDecimals != null) return tickDecimals;
  if (hasExplicitPrecision(meta.pricePrecision)) return Math.min(MAX_DECIMALS, Number(meta.pricePrecision));
  return inferPriceDecimals(price, mode);
}

export function formatPrice(value, meta = {}, options = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return options.fallback ?? "-";
  const mode = options.mode || "display";
  const decimals = Math.max(0, precisionFromMeta(meta, n, mode));
  // Always pad to the inferred/known decimal count, even when the trailing
  // digits are zero (e.g. EUR/USD at exactly 1.0000, or BTC at an exact
  // round price). A trimmed "1" instead of "1.0000" is misleading for
  // forex, where every pip matters, and inconsistent for crypto, where a
  // price's decimal count is part of reading its scale at a glance.
  const minimumFractionDigits = decimals;
  const maximumFractionDigits = decimals;
  const formatted = n.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
  return options.currency ? `$${formatted}` : formatted;
}

export function formatUsd(value, meta = {}, options = {}) {
  return formatPrice(value, meta, { ...options, currency: true });
}
