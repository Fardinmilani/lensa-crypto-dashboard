import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, createChart, createSeriesMarkers } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";
import { formatUsd } from "../lib/priceFormat";

function barTime(t) {
  return Math.floor(t > 1e11 ? t / 1000 : t);
}

function normalizeCandles(candles) {
  if (!candles?.length) return [];
  const points = candles
    .filter((c) => c && Number.isFinite(c.time) && Number.isFinite(c.close))
    .map((c) => ({
      time: barTime(c.time),
      open: c.open ?? c.close,
      high: c.high ?? c.close,
      low: c.low ?? c.close,
      close: c.close,
    }))
    .sort((a, b) => a.time - b.time);

  const deduped = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === point.time) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return deduped;
}

function findBarIndex(candles, targetTime) {
  const t = barTime(targetTime);
  let idx = candles.findIndex((c) => c.time === t);
  if (idx >= 0) return idx;
  idx = candles.findIndex((c) => c.time >= t);
  if (idx >= 0) return idx;
  return candles.length - 1;
}

function snapToBarTime(candles, targetTime) {
  if (!candles.length) return barTime(targetTime);
  const idx = findBarIndex(candles, targetTime);
  return candles[idx].time;
}

function sliceTradeWindow(candles, trade, pad = 12) {
  if (!candles.length || !trade) return [];
  const i0 = Math.max(0, findBarIndex(candles, trade.entryTime) - pad);
  const i1 = Math.min(candles.length - 1, findBarIndex(candles, trade.exitTime) + pad);
  return candles.slice(i0, i1 + 1);
}

export default function TradeReplay({ trades, candles, precision }) {
  const { t } = useI18n();
  const list = trades || [];
  const [idx, setIdx] = useState(0);
  const listKey = list.length ? `${list.length}-${list[0]?.entryTime}-${list.at(-1)?.entryTime}` : "empty";
  const safeIdx = Math.min(idx, Math.max(0, list.length - 1));
  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const markersRef = useRef(null);
  const trade = list[safeIdx];

  const allCandles = useMemo(() => normalizeCandles(candles), [candles]);
  const windowCandles = useMemo(() => sliceTradeWindow(allCandles, trade), [allCandles, trade]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !windowCandles.length || !trade) return;

    const chart = createChart(container, {
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

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    series.setData(windowCandles);

    const entryT = snapToBarTime(windowCandles, trade.entryTime);
    const exitT = snapToBarTime(windowCandles, trade.exitTime);
    const isLong = (trade.side ?? 1) >= 0;
    const markers = createSeriesMarkers(series, [
      {
        time: entryT,
        position: isLong ? "belowBar" : "aboveBar",
        color: "#22c55e",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: t("bt.replay.entry"),
      },
      {
        time: exitT,
        position: isLong ? "aboveBar" : "belowBar",
        color: "#ef4444",
        shape: "circle",
        text: t("bt.replay.exit"),
      },
    ]);
    markersRef.current = markers;

    chart.timeScale().fitContent();

    return () => {
      markersRef.current?.detach?.();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
    };
  }, [windowCandles, trade, t]);

  if (!list.length || !allCandles.length) return null;

  return (
    <div className="glass-card replay-panel chart-card reveal" key={listKey}>
      <div className="panel-header">
        <h2>{t("bt.replay.title")}</h2>
        <span className="panel-subtitle">{t("bt.replay.hint")}</span>
      </div>
      <div className="replay-controls">
        <button type="button" className="run-btn run-btn--ghost" disabled={safeIdx <= 0} onClick={() => setIdx((i) => i - 1)}>
          {t("bt.replay.prev")}
        </button>
        <span className="replay-label">{t("bt.replay.trade", { n: safeIdx + 1, total: list.length })}</span>
        <button type="button" className="run-btn run-btn--ghost" disabled={safeIdx >= list.length - 1} onClick={() => setIdx((i) => i + 1)}>
          {t("bt.replay.next")}
        </button>
      </div>
      <div className="replay-chart-wrap equity-chart-container" ref={containerRef} />
      {trade && (
        <div className="replay-detail">
          <div>
            <strong>{t("bt.replay.entry")}</strong>
            <span className="num">{new Date(barTime(trade.entryTime) * 1000).toLocaleString()}</span>
            <span className="num"> @ {formatUsd(trade.entryPrice, precision, { mode: "trading" })}</span>
          </div>
          <div>
            <strong>{t("bt.replay.exit")}</strong>
            <span className="num">{new Date(barTime(trade.exitTime) * 1000).toLocaleString()}</span>
            <span className="num"> @ {formatUsd(trade.exitPrice, precision, { mode: "trading" })}</span>
          </div>
          <div className={`num pill ${trade.pnlPercent >= 0 ? "up" : "down"}`}>
            {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
          </div>
        </div>
      )}
    </div>
  );
}
