import { useEffect, useRef } from "react";
import { createChart, LineSeries, AreaSeries } from "lightweight-charts";
import { precisionFromMeta } from "../lib/priceFormat";

/**
 * Visualises the Monte Carlo projection as a fan of percentile lines extending
 * from recent price history. The p25–p75 band is shaded to read as the "likely"
 * region; p5 and p95 mark the wider plausible envelope.
 */
export default function ConeChart({ history, cone, stepSeconds, precision }) {
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!wrapRef.current || !cone?.length) return;
    wrapRef.current.innerHTML = "";

    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#9aa6b8",
        fontFamily: "'Fira Code', monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
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

    const mk = (offset) => cone.map((c) => ({ time: lastTime + c.step * stepSeconds, ...c, offset }));
    const anchor = { time: lastTime, value: lastPrice };
    const futP95 = [anchor, ...mk().map((c) => ({ time: c.time, value: c.p95 }))];
    const futP75 = [anchor, ...mk().map((c) => ({ time: c.time, value: c.p75 }))];
    const futP50 = [anchor, ...mk().map((c) => ({ time: c.time, value: c.p50 }))];
    const futP25 = [anchor, ...mk().map((c) => ({ time: c.time, value: c.p25 }))];
    const futP5 = [anchor, ...mk().map((c) => ({ time: c.time, value: c.p5 }))];

    // Shade the p25–p75 band: an area to p75 over a masking area to p25.
    const upper = chart.addSeries(AreaSeries, {
      lineColor: "rgba(139,92,246,0.55)",
      topColor: "rgba(139,92,246,0.28)",
      bottomColor: "rgba(139,92,246,0.02)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat,
    });
    upper.setData(futP75);

    const outerHi = chart.addSeries(LineSeries, {
      color: "rgba(139,92,246,0.35)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false,
      priceFormat,
    });
    outerHi.setData(futP95);
    const outerLo = chart.addSeries(LineSeries, {
      color: "rgba(139,92,246,0.35)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false,
      priceFormat,
    });
    outerLo.setData(futP5);
    const lo25 = chart.addSeries(LineSeries, {
      color: "rgba(139,92,246,0.5)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      priceFormat,
    });
    lo25.setData(futP25);

    // Historical price + median projection, joined for continuity.
    const histLine = chart.addSeries(LineSeries, {
      color: "#9aa6b8", lineWidth: 2, priceLineVisible: false,
      priceFormat,
    });
    histLine.setData(history);

    const median = chart.addSeries(LineSeries, {
      color: "#f59e0b", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      priceFormat,
    });
    median.setData(futP50);

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [history, cone, stepSeconds, precision]);

  return <div className="cone-chart" ref={wrapRef} />;
}
