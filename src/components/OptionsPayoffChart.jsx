import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";

export default function OptionsPayoffChart({ points, spot }) {
  const { t } = useI18n();
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !points?.length) return;
    const chart = createChart(ref.current, {
      height: 260,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { visible: false },
    });
    const series = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2 });
    series.setData(points.map((p, i) => ({ time: i + 1, value: p.pnl })));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current.clientWidth }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [points]);

  if (!points?.length) return null;

  return (
    <div className="payoff-chart">
      <div className="panel-header"><h3>{t("bt.payoff.title")}</h3></div>
      <p className="section-note">{t("bt.payoff.hint")}</p>
      {spot != null && <p className="card-hint num">Spot ≈ {spot.toFixed(2)}</p>}
      <div ref={ref} className="chart-stage" />
    </div>
  );
}
