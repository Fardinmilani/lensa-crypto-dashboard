import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { getCandles, resolveTimeframe } from "../lib/coingecko";
import { ema } from "../lib/strategies";
import { useI18n } from "../i18n/langStore";

/**
 * Native candlestick chart powered by CoinGecko OHLC — works for ANY coin and
 * ANY timeframe (in days), unlike a fixed TradingView symbol mapping.
 */
export default function PriceChart({ coinId, symbol, days }) {
  const { t } = useI18n();
  const wrapRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let chart;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const candles = await getCandles(coinId, days);
        if (cancelled || !wrapRef.current) return;
        if (!candles.length) throw new Error(t("chart.noData"));

        wrapRef.current.innerHTML = "";
        chart = createChart(wrapRef.current, {
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
          timeScale: {
            borderColor: "rgba(255,255,255,0.08)",
            timeVisible: resolveTimeframe(days).intervalMinutes < 1440,
          },
          crosshair: { mode: 1 },
        });

        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: "#22c55e",
          downColor: "#ef4444",
          borderUpColor: "#22c55e",
          borderDownColor: "#ef4444",
          wickUpColor: "#22c55e",
          wickDownColor: "#ef4444",
        });
        candleSeries.setData(candles);

        const closes = candles.map((c) => c.close);
        const emaVals = ema(closes, 21);
        const emaLine = chart.addSeries(LineSeries, {
          color: "#f59e0b",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        emaLine.setData(
          candles
            .map((c, i) => (emaVals[i] != null ? { time: c.time, value: emaVals[i] } : null))
            .filter(Boolean)
        );

        chart.timeScale().fitContent();
        setLast(candles[candles.length - 1].close);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (chart) chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinId, days]);

  return (
    <div className="price-chart">
      {error && <div className="chart-overlay chart-overlay--error">{t("chart.error", { e: error })}</div>}
      {loading && !error && <div className="chart-overlay">{t("chart.loading", { sym: symbol })}</div>}
      <div className="price-chart__canvas" ref={wrapRef} />
      <div className="price-chart__legend">
        <span><i className="dot dot--gold" /> EMA 21</span>
        {last != null && <span className="num">${last.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>}
      </div>
    </div>
  );
}
