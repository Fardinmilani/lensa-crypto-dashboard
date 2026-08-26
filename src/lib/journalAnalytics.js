// Paper-trade journal analytics from Decision Center trades.

export function analyzePaperTrades(trades, { initialCapital = 10000 } = {}) {
  if (!trades?.length) {
    return { tradeCount: 0, winRate: null, equityCurve: [{ time: Date.now() / 1000, equity: initialCapital }] };
  }
  const sorted = [...trades].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let equity = initialCapital;
  const equityCurve = [{ time: sorted[0].createdAt || Date.now() / 1000, equity }];
  let wins = 0;
  let losses = 0;
  let open = 0;
  for (const t of sorted) {
    const status = String(t.status || t.outcome || "").toLowerCase();
    if (status === "win") {
      wins++;
      equity *= 1.01;
    } else if (status === "loss") {
      losses++;
      equity *= 0.99;
    } else open++;
    equityCurve.push({ time: t.updatedAt || t.createdAt || Date.now() / 1000, equity });
  }
  const closed = wins + losses;
  return {
    tradeCount: sorted.length,
    wins,
    losses,
    open,
    winRate: closed ? (wins / closed) * 100 : null,
    equityCurve,
    finalEquity: equity,
    totalReturnPercent: ((equity - initialCapital) / initialCapital) * 100,
  };
}
