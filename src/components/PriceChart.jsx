import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { getCandles } from "../lib/coingecko";
import { ema } from "../lib/strategies";

/**
 * Native candlestick chart powered by CoinGecko OHLC — works for ANY coin and
 * ANY timeframe (in days), unlike a fixed TradingView symbol mapping.
 */
export default function PriceChart({ coinId, symbol, days }) {
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
        if (!candles.length) throw new Error("داده‌ای دریافت نشد.");

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
          timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: days <= 30 },
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
  }, [coinId, days]);

  return (
    <div className="price-chart">
      {error && <div className="chart-overlay chart-overlay--error">خطا در دریافت چارت: {error}</div>}
      {loading && !error && <div className="chart-overlay">در حال بارگذاری چارت {symbol}…</div>}
      <div className="price-chart__canvas" ref={wrapRef} />
      <div className="price-chart__legend">
        <span><i className="dot dot--gold" /> EMA 21</span>
        {last != null && <span className="num">${last.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>}
      </div>
    </div>
  );
}
