import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";

export default function UnderwaterChart({ points }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !points?.length) return;
    const chart = createChart(ref.current, {
      height: 220,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const series = chart.addSeries(LineSeries, { color: "#f87171", lineWidth: 2, title: "DD %" });
    series.setData(points.map((p) => ({ time: p.time, value: p.underwater })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current.clientWidth }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [points]);

  if (!points?.length) return null;

  return (
    <div className="underwater-chart">
      <div className="panel-header"><h3>{t("bt.underwater.title")}</h3></div>
      <p className="section-note">{t("bt.underwater.hint")}</p>
      <div ref={ref} className="chart-stage" />
    </div>
  );
}
