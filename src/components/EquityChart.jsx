import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";

export default function EquityChart({ equityCurve, benchmarkCurve }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

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
      title: "استراتژی",
    });
    equitySeries.setData(
      equityCurve.map((p) => ({ time: Math.floor(p.time / 1000), value: p.equity }))
    );

    if (benchmarkCurve) {
      const benchmarkSeries = chart.addSeries(LineSeries, {
        color: "#5a6472",
        lineWidth: 1,
        lineStyle: 2, // dashed
        title: "خرید و نگهداری",
      });
      benchmarkSeries.setData(
        benchmarkCurve.map((p) => ({ time: Math.floor(p.time / 1000), value: p.equity }))
      );
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
    };
  }, [equityCurve, benchmarkCurve]);

  return <div className="equity-chart-container" ref={containerRef} />;
}
