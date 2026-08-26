import { useEffect, useRef } from "react";
import { createChart, HistogramSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";

export default function FundingHistoryChart({ history }) {
  const { t } = useI18n();
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !history?.length) return;
    const chart = createChart(ref.current, {
      height: 200,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(148,163,184,0.08)" } },
    });
    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(2)}%` },
    });
    series.setData(history.map((h) => ({ time: h.time, value: h.apr, color: h.apr >= 0 ? "#22c55e" : "#ef4444" })));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current.clientWidth }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [history]);

  if (!history?.length) return null;

  return (
    <div className="funding-history">
      <div className="panel-header"><h3>{t("edge.funding.title")}</h3></div>
      <p className="section-note">{t("edge.funding.hint")}</p>
      <div ref={ref} className="chart-stage" />
    </div>
  );
}
