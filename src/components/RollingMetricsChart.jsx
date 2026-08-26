import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";

function toTime(t) {
  return Math.floor(t > 1e11 ? t / 1000 : t);
}

export default function RollingMetricsChart({ points }) {
  const { t } = useI18n();
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !points?.length) return;

    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#8b96a5",
        fontFamily: "'Vazirmatn', 'Inter', -apple-system, 'Segoe UI', sans-serif",
      },
      grid: { vertLines: { color: "#232a36" }, horzLines: { color: "#232a36" } },
      rightPriceScale: { borderColor: "#323b4a" },
      timeScale: { borderColor: "#323b4a" },
    });

    const sharpeSeries = chart.addSeries(LineSeries, {
      color: "#c9a66b",
      lineWidth: 2,
      title: t("bt.rolling.sharpe"),
    });
    sharpeSeries.setData(
      points
        .filter((p) => Number.isFinite(p.rollingSharpe))
        .map((p) => ({ time: toTime(p.time), value: p.rollingSharpe }))
    );

    const ddSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      title: t("bt.rolling.dd"),
      priceScaleId: "dd",
    });
    chart.priceScale("dd").applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });
    ddSeries.setData(points.map((p) => ({ time: toTime(p.time), value: p.rollingMaxDd })));

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, t]);

  if (!points?.length) return null;

  return (
    <div className="glass-card chart-card">
      <div className="panel-header">
        <h2>{t("bt.rolling.title")}</h2>
        <span className="panel-subtitle">{t("bt.rolling.hint")}</span>
      </div>
      <div className="equity-chart-container" ref={ref} />
    </div>
  );
}
