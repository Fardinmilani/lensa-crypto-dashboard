import { useEffect, useRef } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import { getChartCandles, coinIdFromPair } from "../lib/coingecko";
import { normalizeTo100 } from "../lib/correlation";
import { useI18n } from "../i18n/langStore";

export default function CompareChart({ compareSymbol, market, coin }) {
  const { t } = useI18n();
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !compareSymbol) return;
    let cancelled = false;
    let chart;

    async function load() {
      const [primary, second] = await Promise.all([
        getChartCandles({
          id: coin.id,
          symbol: coin.symbol,
          timeframe: market.timeframe,
          lookbackDays: market.historicalRange || market.timeframe,
          source: market.exchange,
          pair: market.pair,
          marketType: market.marketType,
        }),
        getChartCandles({
          id: coinIdFromPair(compareSymbol, coin.id),
          symbol: compareSymbol.replace(/USDT$/i, ""),
          timeframe: market.timeframe,
          lookbackDays: market.historicalRange || market.timeframe,
          source: market.exchange,
          pair: compareSymbol,
          marketType: market.marketType,
        }),
      ]);
      if (cancelled || !ref.current || !primary.length || !second.length) return;

      const pCloses = primary.map((c) => c.close);
      const sCloses = second.map((c) => c.close);
      const n = Math.min(pCloses.length, sCloses.length);
      const pNorm = normalizeTo100(pCloses.slice(-n));
      const sNorm = normalizeTo100(sCloses.slice(-n));
      const times = primary.slice(-n).map((c) => c.time);

      chart = createChart(ref.current, {
        height: 200,
        layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
        grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      });
      const a = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, title: market.pair });
      const b = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, title: compareSymbol });
      a.setData(times.map((time, i) => ({ time, value: pNorm[i] })));
      b.setData(times.map((time, i) => ({ time, value: sNorm[i] })));
      chart.timeScale().fitContent();
    }

    load();
    return () => {
      cancelled = true;
      chart?.remove();
    };
  }, [compareSymbol, market, coin]);

  if (!compareSymbol) return null;

  return (
    <div className="glass-card compare-panel reveal">
      <div className="panel-header">
        <h2>{t("dash.compare.title")}</h2>
        <span className="panel-subtitle">{t("dash.compare.hint")}</span>
      </div>
      <div ref={ref} className="chart-stage" />
    </div>
  );
}
