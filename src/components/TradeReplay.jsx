import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, createChart, createSeriesMarkers, LineSeries } from "lightweight-charts";
import { useI18n } from "../i18n/langStore";
import { formatUsd } from "../lib/priceFormat";
import {
  barTime,
  filterTrades,
  normalizeCandles,
  riskGuidePrices,
  sliceTradeWindow,
  snapToBarTime,
  tradeDurationBars,
} from "../lib/tradeReplay";

const FILTERS = ["all", "wins", "losses"];
const PAD_MIN = 4;
const PAD_MAX = 40;

function TradeReplaySession({
  trade,
  windowCandles,
  allCandles,
  slice,
  precision,
  riskParams,
  leverage,
  isFutures,
  locale,
  t,
}) {
  const [barIdx, setBarIdx] = useState(slice.entryIdx);
  const [playing, setPlaying] = useState(false);
  const containerRef = useRef(null);
  const markersRef = useRef(null);

  useEffect(() => {
    if (!playing || !windowCandles.length) return;
    const timer = setInterval(() => {
      setBarIdx((i) => {
        if (i >= windowCandles.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 450);
    return () => clearInterval(timer);
  }, [playing, windowCandles.length]);

  useEffect(() => {
    function onKey(e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "[") {
        e.preventDefault();
        setBarIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "]") {
        e.preventDefault();
        setBarIdx((i) => Math.min(windowCandles.length - 1, i + 1));
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [windowCandles.length]);

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
      timeScale: { borderColor: "#323b4a", timeVisible: true, secondsVisible: false },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    series.setData(windowCandles);

    const addLine = (price, color, title) => {
      if (!Number.isFinite(price)) return;
      series.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title,
      });
    };
    addLine(trade.entryPrice, "#22c55e", t("bt.replay.entry"));
    addLine(trade.exitPrice, "#ef4444", t("bt.replay.exit"));
    const guides = riskGuidePrices(trade, riskParams, leverage);
    if (guides?.stop != null) addLine(guides.stop, "#f97316", t("bt.replay.sl"));
    if (guides?.target != null) addLine(guides.target, "#38bdf8", t("bt.replay.tp"));

    const entryT = snapToBarTime(windowCandles, trade.entryTime);
    const exitT = snapToBarTime(windowCandles, trade.exitTime);
    const isLong = (trade.side ?? 1) >= 0;
    const markerList = [
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
    ];
    if (trade.partial) {
      markerList.push({
        time: exitT,
        position: "inBar",
        color: "#c9a66b",
        shape: "square",
        text: t("bt.replay.partial"),
      });
    }
    markersRef.current = createSeriesMarkers(series, markerList);

    const cursorBar = windowCandles[barIdx];
    if (cursorBar) {
      const highlight = chart.addSeries(LineSeries, {
        color: "#c9a66b",
        lineWidth: 0,
        crosshairMarkerVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      highlight.setData([{ time: cursorBar.time, value: cursorBar.close }]);
      chart.timeScale().setVisibleRange({
        from: windowCandles[Math.max(0, barIdx - 6)].time,
        to: windowCandles[Math.min(windowCandles.length - 1, barIdx + 6)].time,
      });
    } else {
      chart.timeScale().fitContent();
    }

    return () => {
      markersRef.current?.detach?.();
      markersRef.current = null;
      chart.remove();
    };
  }, [windowCandles, trade, barIdx, riskParams, leverage, t]);

  const durationBars = tradeDurationBars(trade, allCandles);
  const currentBar = windowCandles[barIdx];

  return (
    <>
      <div className="replay-playback">
        <button type="button" className="run-btn run-btn--ghost" disabled={barIdx <= 0} onClick={() => setBarIdx((i) => Math.max(0, i - 1))}>
          {t("bt.replay.barPrev")}
        </button>
        <button type="button" className={`run-btn ${playing ? "" : "run-btn--ghost"}`} onClick={() => setPlaying((p) => !p)}>
          {playing ? t("bt.replay.pause") : t("bt.replay.play")}
        </button>
        <button type="button" className="run-btn run-btn--ghost" disabled={barIdx >= windowCandles.length - 1} onClick={() => setBarIdx((i) => Math.min(windowCandles.length - 1, i + 1))}>
          {t("bt.replay.barNext")}
        </button>
        <button type="button" className="run-btn run-btn--ghost" onClick={() => { setPlaying(false); setBarIdx(slice.entryIdx); }}>
          {t("bt.replay.resetBar")}
        </button>
      </div>

      {windowCandles.length > 0 && (
        <label className="replay-scrubber">
          <span>{t("bt.replay.scrub")}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, windowCandles.length - 1)}
            value={barIdx}
            onChange={(e) => {
              setPlaying(false);
              setBarIdx(Number(e.target.value));
            }}
          />
          {currentBar && (
            <span className="num">{new Date(currentBar.time * 1000).toLocaleString(locale)}</span>
          )}
        </label>
      )}

      <div className="replay-chart-wrap equity-chart-container" ref={containerRef} />

      <div className="replay-detail">
        <div>
          <strong>{t("bt.replay.entry")}</strong>
          <span className="num">{new Date(barTime(trade.entryTime) * 1000).toLocaleString(locale)}</span>
          <span className="num"> @ {formatUsd(trade.entryPrice, precision, { mode: "trading" })}</span>
        </div>
        <div>
          <strong>{t("bt.replay.exit")}</strong>
          <span className="num">{new Date(barTime(trade.exitTime) * 1000).toLocaleString(locale)}</span>
          <span className="num"> @ {formatUsd(trade.exitPrice, precision, { mode: "trading" })}</span>
        </div>
        {isFutures && (
          <div>
            <strong>{t("bt.col.side")}</strong>
            <span className={`side-badge side-badge--${trade.side === -1 ? "short" : "long"}`}>
              {trade.side === -1 ? t("bt.direction.short") : t("bt.direction.long")}
            </span>
            {trade.liquidated && <span className="risk-badge risk-badge--liquidated">{t("bt.badgeLiquidated")}</span>}
          </div>
        )}
        {durationBars != null && (
          <div>
            <strong>{t("bt.replay.duration")}</strong>
            <span className="num">{t("bt.replay.durationBars", { n: durationBars })}</span>
          </div>
        )}
        {trade.mae != null && (
          <div>
            <strong>{t("bt.replay.mae")}</strong>
            <span className="num down">{trade.mae.toFixed(2)}%</span>
          </div>
        )}
        {trade.mfe != null && (
          <div>
            <strong>{t("bt.replay.mfe")}</strong>
            <span className="num up">{trade.mfe.toFixed(2)}%</span>
          </div>
        )}
        {trade.stillOpenAtEnd && <span className="pill">{t("bt.replay.openAtEnd")}</span>}
        <div className={`num pill ${trade.pnlPercent >= 0 ? "up" : "down"}`}>
          {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
        </div>
      </div>
    </>
  );
}

export default function TradeReplay({
  trades,
  candles,
  precision,
  riskParams = null,
  leverage = 1,
  isFutures = false,
  selectedIndex = 0,
  onSelectedIndexChange,
}) {
  const { t, lang } = useI18n();
  const locale = lang === "fa" ? "fa-IR" : "en-US";
  const list = useMemo(() => trades ?? [], [trades]);
  const [filter, setFilter] = useState("all");
  const [pad, setPad] = useState(12);

  const filtered = useMemo(() => filterTrades(list, filter), [list, filter]);
  const selectedTrade = list[Math.min(Math.max(0, selectedIndex), Math.max(0, list.length - 1))];
  const trade = filtered.includes(selectedTrade) ? selectedTrade : filtered[0] ?? selectedTrade;
  const filteredPos = trade ? filtered.indexOf(trade) : 0;

  const allCandles = useMemo(() => normalizeCandles(candles), [candles]);
  const slice = useMemo(() => sliceTradeWindow(allCandles, trade, pad), [allCandles, trade, pad]);
  const windowCandles = slice.window;
  const sessionKey = trade ? `${list.indexOf(trade)}-${pad}-${trade.entryTime}` : "none";

  const jumpToFiltered = useCallback(
    (pos) => {
      const tr = filtered[pos];
      if (tr) onSelectedIndexChange?.(list.indexOf(tr));
    },
    [filtered, list, onSelectedIndexChange]
  );

  useEffect(() => {
    function onKey(e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (filteredPos > 0) jumpToFiltered(filteredPos - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (filteredPos < filtered.length - 1) jumpToFiltered(filteredPos + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredPos, filtered.length, jumpToFiltered]);

  if (!list.length || !allCandles.length) return null;

  return (
    <div className="glass-card replay-panel chart-card reveal">
      <div className="panel-header panel-header--wrap">
        <div>
          <h2>{t("bt.replay.title")}</h2>
          <span className="panel-subtitle">{t("bt.replay.hint")}</span>
        </div>
        <div className="replay-filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`band-toggle__btn ${filter === f ? "active" : ""}`}
              onClick={() => {
                const next = filterTrades(list, f);
                setFilter(f);
                if (next.length && !next.includes(list[selectedIndex])) {
                  onSelectedIndexChange?.(list.indexOf(next[0]));
                }
              }}
            >
              {t(`bt.replay.filter.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {!filtered.length ? (
        <p className="section-note">{t("bt.replay.emptyFilter")}</p>
      ) : (
        <>
          <div className="replay-toolbar">
            <div className="replay-controls">
              <button type="button" className="run-btn run-btn--ghost" disabled={filteredPos <= 0} onClick={() => jumpToFiltered(0)} title={t("bt.replay.first")}>
                «
              </button>
              <button type="button" className="run-btn run-btn--ghost" disabled={filteredPos <= 0} onClick={() => jumpToFiltered(filteredPos - 1)}>
                {t("bt.replay.prev")}
              </button>
              <select className="replay-select" value={list.indexOf(trade)} onChange={(e) => onSelectedIndexChange?.(Number(e.target.value))}>
                {filtered.map((tr) => {
                  const origIdx = list.indexOf(tr);
                  return (
                    <option key={`${origIdx}-${tr.entryTime}`} value={origIdx}>
                      #{origIdx + 1} · {tr.pnlPercent >= 0 ? "+" : ""}{tr.pnlPercent.toFixed(2)}%
                    </option>
                  );
                })}
              </select>
              <button type="button" className="run-btn run-btn--ghost" disabled={filteredPos >= filtered.length - 1} onClick={() => jumpToFiltered(filteredPos + 1)}>
                {t("bt.replay.next")}
              </button>
              <button type="button" className="run-btn run-btn--ghost" disabled={filteredPos >= filtered.length - 1} onClick={() => jumpToFiltered(filtered.length - 1)} title={t("bt.replay.last")}>
                »
              </button>
            </div>
          </div>

          <label className="replay-pad">
            <span>{t("bt.replay.context")}</span>
            <input type="range" min={PAD_MIN} max={PAD_MAX} value={pad} onChange={(e) => setPad(Number(e.target.value))} />
            <span className="num">{pad}</span>
          </label>

          <TradeReplaySession
            key={sessionKey}
            trade={trade}
            windowCandles={windowCandles}
            allCandles={allCandles}
            slice={slice}
            precision={precision}
            riskParams={riskParams}
            leverage={leverage}
            isFutures={isFutures}
            locale={locale}
            t={t}
          />

          <p className="section-note">{t("bt.replay.keys")}</p>
        </>
      )}
    </div>
  );
}
