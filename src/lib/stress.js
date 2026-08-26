// Portfolio stress scenarios — deterministic shocks with optional correlation blend.

export function applyStressScenario({ weights, shocks, correlation = 0.5 }) {
  const keys = Object.keys(weights);
  if (!keys.length) return { error: "empty_portfolio" };
  const wSum = keys.reduce((s, k) => s + (weights[k] || 0), 0) || 1;
  const norm = {};
  for (const k of keys) norm[k] = (weights[k] || 0) / wSum;

  // If a market-wide shock is provided, blend idiosyncratic shock with common factor.
  const marketShock = shocks.__market__ ?? null;
  let portfolioReturn = 0;
  const assetReturns = {};
  for (const k of keys) {
    const idio = shocks[k] ?? 0;
    const blended = marketShock != null ? correlation * marketShock + (1 - correlation) * idio : idio;
    assetReturns[k] = blended;
    portfolioReturn += norm[k] * blended;
  }
  return { portfolioReturnPercent: portfolioReturn, assetReturns, weights: norm };
}

export const STRESS_PRESETS = [
  { id: "mild", label: "Mild risk-off", shocks: { __market__: -5 } },
  { id: "crash", label: "Flash crash", shocks: { __market__: -20 } },
  { id: "crypto_winter", label: "Crypto winter", shocks: { __market__: -35, correlation: 0.85 } },
  { id: "btc_only", label: "BTC -15%, alts -25%", shocks: { BTC: -15, __market__: -10 }, correlation: 0.4 },
  { id: "recovery", label: "Relief rally", shocks: { __market__: 12 } },
];

export function monteCarloPortfolioStress({ weights, meanReturns, vols, correlation = 0.4, sims = 500, seed = 42, horizon = 30 }) {
  const keys = Object.keys(weights);
  const wSum = keys.reduce((s, k) => s + (weights[k] || 0), 0) || 1;
  const w = keys.map((k) => (weights[k] || 0) / wSum);
  const mu = keys.map((k) => (meanReturns[k] ?? 0) / 100 / 252);
  const sig = keys.map((k) => (vols[k] ?? 20) / 100 / Math.sqrt(252));
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const randn = () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const finals = [];
  for (let s = 0; s < sims; s++) {
    const zM = randn();
    let logRet = 0;
    for (let i = 0; i < keys.length; i++) {
      const z = correlation * zM + Math.sqrt(1 - correlation * correlation) * randn();
      logRet += w[i] * (mu[i] * horizon + sig[i] * Math.sqrt(horizon) * z);
    }
    finals.push((Math.exp(logRet) - 1) * 100);
  }
  finals.sort((a, b) => a - b);
  const pct = (p) => finals[Math.floor(p * (finals.length - 1))];
  return {
    sims,
    horizon,
    p5: pct(0.05),
    p50: pct(0.5),
    p95: pct(0.95),
    probLoss: finals.filter((x) => x < 0).length / finals.length,
  };
}
