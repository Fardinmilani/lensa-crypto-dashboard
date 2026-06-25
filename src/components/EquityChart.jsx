import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";

// Curve times can arrive in seconds (like candles elsewhere) or milliseconds.
// lightweight-charts requires UNIX seconds, strictly ascending and unique.
function toSeriesData(curve) {
  if (!Array.isArray(curve)) return [];
  const points = curve
    .filter((p) => p && Number.isFinite(p.time) && Number.isFinite(p.equity))
    .map((p) => ({
      time: Math.floor(p.time > 1e11 ? p.time / 1000 : p.time),
      value: p.equity,
    }))
    .sort((a, b) => a.time - b.time);

  // Collapse duplicate timestamps, keeping the latest value for each second.
  const deduped = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === point.time) last.value = point.value;
    else deduped.push(point);
  }
  return deduped;
}

export default function EquityChart({ equityCurve, benchmarkCurve, strategyTitle, benchmarkTitle }) {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const equityLabel = strategyTitle ?? t("bt.equity.strategy");
  const benchmarkLabel = benchmarkTitle ?? t("bt.equity.benchmark");

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#8b96a5",
        fontFamily: "'Vazirmatn', 'Inter', -apple-system, 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: "#232a36" },
        horzLines: { color: "#232a36" },
      },
      rightPriceScale: { borderColor: "#323b4a" },
      timeScale: { borderColor: "#323b4a" },
    });
    chartRef.current = chart;

    const equitySeries = chart.addSeries(LineSeries, {
      color: "#c9a66b",
      lineWidth: 2,
      title: equityLabel,
    });
    equitySeries.setData(toSeriesData(equityCurve));

    if (benchmarkCurve) {
      const benchmarkSeries = chart.addSeries(LineSeries, {
        color: "#5a6472",
        lineWidth: 1,
        lineStyle: 2, // dashed
        title: benchmarkLabel,
      });
      benchmarkSeries.setData(toSeriesData(benchmarkCurve));
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
    };
  }, [equityCurve, benchmarkCurve, equityLabel, benchmarkLabel]);

  return <div className="equity-chart-container" ref={containerRef} />;
}
