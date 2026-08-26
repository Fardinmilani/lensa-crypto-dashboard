// Options payoff at expiry — uses blackScholes intrinsic at T=0.

export function expiryPayoff({ legs, spotMin, spotMax, steps = 80 }) {
  if (!legs?.length || spotMax <= spotMin) return [];
  const step = (spotMax - spotMin) / steps;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const spot = spotMin + i * step;
    let pnl = 0;
    for (const leg of legs) {
      const mult = leg.side === "short" ? -1 : 1;
      const qty = leg.qty ?? 1;
      const k = leg.strike;
      const intrinsic = leg.type === "call" ? Math.max(spot - k, 0) : Math.max(k - spot, 0);
      pnl += mult * qty * (intrinsic - (leg.premium ?? 0));
    }
    points.push({ spot, pnl });
  }
  return points;
}

export function legsFromOptionStrategy(strategyKey, { spot, strike, premium }) {
  const s = strike ?? spot;
  const p = premium ?? spot * 0.03;
  const map = {
    coveredCall: [
      { type: "call", side: "short", strike: s, premium: p, qty: 1 },
    ],
    protectivePut: [
      { type: "put", side: "long", strike: s, premium: p, qty: 1 },
    ],
    cashSecuredPut: [
      { type: "put", side: "short", strike: s, premium: p, qty: 1 },
    ],
    longCall: [{ type: "call", side: "long", strike: s, premium: p, qty: 1 }],
    longPut: [{ type: "put", side: "long", strike: s, premium: p, qty: 1 }],
  };
  return map[strategyKey] || map.coveredCall;
}
