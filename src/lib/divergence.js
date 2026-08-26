// RSI / MACD divergence detection on price swings.

import { rsi, macd } from "./strategies.js";

function localExtrema(values, kind = "high", look = 3) {
  const idx = [];
  for (let i = look; i < values.length - look; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    let ok = true;
    for (let j = 1; j <= look; j++) {
      if (kind === "high") {
        if (values[i - j] >= v || values[i + j] >= v) ok = false;
      } else if (values[i - j] <= v || values[i + j] <= v) ok = false;
    }
    if (ok) idx.push(i);
  }
  return idx;
}

export function detectDivergences(candles, { type = "rsi", period = 14 } = {}) {
  if (!candles?.length || candles.length < period + 10) return [];
  const closes = candles.map((c) => c.close);
  const osc = type === "macd" ? macd(closes, 12, 26, 9).hist : rsi(closes, period);
  const lows = localExtrema(closes, "low");
  const highs = localExtrema(closes, "high");
  const signals = [];

  for (let i = 1; i < lows.length; i++) {
    const i0 = lows[i - 1];
    const i1 = lows[i];
    if (closes[i1] < closes[i0] && osc[i1] > osc[i0]) {
      signals.push({
        type: "bullish",
        indicator: type,
        barIndex: i1,
        time: candles[i1].time,
        price: closes[i1],
        strength: Math.abs(osc[i1] - osc[i0]),
      });
    }
  }
  for (let i = 1; i < highs.length; i++) {
    const i0 = highs[i - 1];
    const i1 = highs[i];
    if (closes[i1] > closes[i0] && osc[i1] < osc[i0]) {
      signals.push({
        type: "bearish",
        indicator: type,
        barIndex: i1,
        time: candles[i1].time,
        price: closes[i1],
        strength: Math.abs(osc[i0] - osc[i1]),
      });
    }
  }
  return signals.sort((a, b) => b.time - a.time);
}
