// Multi-timeframe confluence: run one strategy across several candle sets.

import { currentSignalState } from "./strategies.js";

export function evaluateMultiTfConfluence({ strategy, candleSets, params = {} }) {
  if (!strategy?.generateSignals) return { error: "no_strategy" };
  const rows = [];
  let longVotes = 0;
  let shortVotes = 0;
  let flatVotes = 0;
  for (const { id, label, candles } of candleSets) {
    if (!candles?.length) {
      rows.push({ id, label, signal: 0, state: "no_data" });
      flatVotes++;
      continue;
    }
    const signals = strategy.generateSignals(candles, { ...strategy.params, ...params });
    const state = currentSignalState(signals);
    const sig = signals.at(-1) ?? 0;
    rows.push({ id, label, signal: sig, state });
    if (sig > 0) longVotes++;
    else if (sig < 0) shortVotes++;
    else flatVotes++;
  }
  const total = rows.length || 1;
  let consensus = "mixed";
  if (longVotes / total >= 0.66) consensus = "long";
  else if (shortVotes / total >= 0.66) consensus = "short";
  else if (flatVotes === total) consensus = "flat";
  const score = Math.max(longVotes, shortVotes, flatVotes) / total;
  return { rows, consensus, score, longVotes, shortVotes, flatVotes };
}

export const DEFAULT_MTF_IDS = ["15m", "1h", "4h", "1d", "1w"];
