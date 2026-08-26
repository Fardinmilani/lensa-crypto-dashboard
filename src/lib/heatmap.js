// 2D parameter heatmap for optimizer grid (in-sample score surface).

import { combineDirectionalSignals } from "./strategies.js";
import { runBacktest, runLeveragedBacktest } from "./backtest.js";
import { scoreResult } from "./optimize.js";

export function buildParamHeatmap({
  strategy,
  candles,
  paramX,
  paramY,
  xValues,
  yValues,
  direction = "long",
  leverage = 1,
  feePercent = 0.1,
  fillTiming = "close",
}) {
  const matrix = [];
  for (const yv of yValues) {
    const row = [];
    for (const xv of xValues) {
      const params = { ...strategy.params, [paramX]: xv, [paramY]: yv };
      const signals = combineDirectionalSignals(strategy, candles, params, direction);
      const result =
        leverage > 1 || direction !== "long"
          ? runLeveragedBacktest({ candles, signals, feePercent, leverage, fillTiming })
          : runBacktest({ candles, signals, feePercent, fillTiming });
      row.push(Number.isFinite(scoreResult(result)) ? scoreResult(result) : null);
    }
    matrix.push(row);
  }
  return { paramX, paramY, xValues, yValues, matrix };
}
