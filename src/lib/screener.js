// Strategy heatmap row builder — one strategy evaluated per symbol.

import { runBacktest, runLeveragedBacktest } from "./backtest.js";
import { currentRegime, classifyRegimes } from "./regime.js";
import { combineDirectionalSignals, currentSignalState } from "./strategies.js";

export function evaluateSymbolStrategy({ candles, strategy, params, direction = "long", leverage = 1, feePercent = 0.1 }) {
  if (!candles?.length || !strategy) return { error: "no_data" };
  const p = { ...strategy.params, ...params };
  const signals = combineDirectionalSignals(strategy, candles, p, direction);
  const result =
    leverage > 1 || direction !== "long"
      ? runLeveragedBacktest({ candles, signals, feePercent, leverage, initialCapital: 10000 })
      : runBacktest({ candles, signals, feePercent, leverage, initialCapital: 10000 });
  const regimes = classifyRegimes(candles);
  const regime = currentRegime(regimes);
  const live = currentSignalState(strategy, candles, p, direction);
  return {
    returnPct: result.totalReturnPercent,
    sharpe: result.sharpe,
    winRate: result.winRate,
    trades: result.tradeCount,
    maxDd: result.maxDrawdownPercent,
    regime: regime?.regime ?? "unknown",
    signal: live?.state ?? "flat",
  };
}
