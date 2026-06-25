import { useEffect, useRef } from "react";
import { createChart, LineSeries, AreaSeries } from "lightweight-charts";
import { precisionFromMeta } from "../lib/priceFormat";

/**
 * Scenario cone for the Monte Carlo simulation.
 *
 * Design intent (trust > flash):
 *   - Historical price stays visually primary (bright, solid).
 *   - The simulated range is secondary: calm slate-blue bands, low opacity,
 *     so it never reads as a single confident prediction.
 *   - The median path is dashed to signal "simulated, not a target".
 *   - The cone is anchored to the last confirmed candle for continuity.
 *
 * `bands` controls progressive disclosure:
 *   - "median" → median path only
 *   - "inner"  → median + likely band (25–75%)   [default]
 *   - "full"   → median + likely band + wide band (5–95%)
 */
const COOL = "125, 168, 224"; // slate-blue, calmer than the old violet blob

export default function ConeChart({ history, cone, stepSeconds, precision, bands = "inner" }) {
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!wrapRef.current || !cone?.length || !history?.length) return;
    wrapRef.current.innerHTML = "";

    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#9aa6b8",
        fontFamily: "'Vazirmatn', 'Inter', -apple-system, 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: stepSeconds < 86400 },
      crosshair: { mode: 1 },
    });

    const pricePrecision = precisionFromMeta(precision, history.at(-1)?.value, "futures");
    const priceFormat = { type: "price", precision: pricePrecision, minMove: 10 ** -pricePrecision };

    const lastTime = history[history.length - 1].time;
    const lastPrice = history[history.length - 1].value;
    const anchor = { time: lastTime, value: lastPrice };

    const seriesFor = (key) => [anchor, ...cone.map((c) => ({ time: lastTime + c.step * stepSeconds, value: c[key] }))];

    const showInner = bands === "inner" || bands === "full";
    const showFull = bands === "full";

    // ---- Wide band (5–95%): the faint outer envelope ----
    if (showFull) {
      const wideArea = chart.addSeries(AreaSeries, {
        lineColor: `rgba(${COOL},0.22)`,
        topColor: `rgba(${COOL},0.10)`,
        bottomColor: `rgba(${COOL},0.0)`,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat,
      });
      wideArea.setData(seriesFor("p95"));

      const p5 = chart.addSeries(LineSeries, {
        color: `rgba(${COOL},0.28)`, lineWidth: 1, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false, priceFormat,
      });
      p5.setData(seriesFor("p5"));
    }

    // ---- Likely band (25–75%): the readable "where it usually lands" zone ----
    if (showInner) {
      const innerArea = chart.addSeries(AreaSeries, {
        lineColor: `rgba(${COOL},0.5)`,
        topColor: `rgba(${COOL},0.20)`,
        bottomColor: `rgba(${COOL},0.02)`,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat,
      });
      innerArea.setData(seriesFor("p75"));

      const p25 = chart.addSeries(LineSeries, {
        color: `rgba(${COOL},0.5)`, lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, priceFormat,
      });
      p25.setData(seriesFor("p25"));
    }

    // ---- Historical price: primary, bright, solid ----
    const histLine = chart.addSeries(LineSeries, {
      color: "#cdd6e6", lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
      priceFormat,
    });
    histLine.setData(history);

    // ---- Median scenario: dashed gold, secondary but legible ----
    const median = chart.addSeries(LineSeries, {
      color: "#f59e0b", lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: true,
      priceFormat,
    });
    median.setData(seriesFor("p50"));

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [history, cone, stepSeconds, precision, bands]);

  return <div className="cone-chart" ref={wrapRef} />;
}
