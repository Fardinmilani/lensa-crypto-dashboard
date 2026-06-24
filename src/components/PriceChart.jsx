import { useEffect, useMemo, useRef, useState } from "react";
import { AreaSeries, BarSeries, createChart, CandlestickSeries, HistogramSeries, LineSeries } from "lightweight-charts";
import { getChartCandles, resolveTimeframe } from "../lib/coingecko";
import { formatPrice } from "../lib/priceFormat";
import { useMarket } from "../context/MarketContext";
import DataQualityGuard from "./DataQualityGuard";
import { qualityMetaFromError } from "../lib/dataQuality";
import { bollinger, ema, macd, roc, rsi, sma } from "../lib/strategies";
import { useI18n } from "../i18n/langStore";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const INDICATOR_TYPES = {
  ema: { label: "EMA", group: "Moving averages", color: "#f59e0b", width: 2, source: true, params: { period: 21 } },
  sma: { label: "SMA", group: "Moving averages", color: "#38bdf8", width: 2, source: true, params: { period: 50 } },
  wma: { label: "WMA", group: "Moving averages", color: "#22c55e", width: 2, source: true, params: { period: 34 } },
  hma: { label: "HMA", group: "Moving averages", color: "#fb7185", width: 2, source: true, params: { period: 55 } },
  bollinger: { label: "Bollinger Bands", group: "Bands", color: "#a78bfa", width: 1, source: true, params: { period: 20, mult: 2 } },
  donchian: { label: "Donchian Channel", group: "Bands", color: "#2dd4bf", width: 1, params: { period: 20 } },
  ichimoku: { label: "Ichimoku", group: "Trend", color: "#f97316", width: 1, params: { conversion: 9, base: 26, spanB: 52 } },
  supertrend: { label: "Supertrend", group: "Trend", color: "#22c55e", width: 2, params: { period: 10, mult: 3 } },
  rsi: { label: "RSI", group: "Oscillators", color: "#facc15", width: 2, source: true, params: { period: 14 } },
  stoch: { label: "Stochastic", group: "Oscillators", color: "#60a5fa", width: 2, params: { period: 14, smooth: 3 } },
  macd: { label: "MACD", group: "Oscillators", color: "#c084fc", width: 2, source: true, params: { fast: 12, slow: 26, signal: 9 } },
  roc: { label: "ROC", group: "Oscillators", color: "#34d399", width: 2, source: true, params: { period: 10 } },
};

const LINE_STYLES = {
  solid: { label: "Solid", value: 0 },
  dotted: { label: "Dotted", value: 1 },
  dashed: { label: "Dashed", value: 2 },
};
const SOURCES = ["close", "open", "high", "low", "hl2", "ohlc4"];
const DEFAULT_INDICATORS = [makeIndicator("ema", { id: "ema-21", params: { period: 21 } })];
const DRAWING_TOOLS = [
  { id: "select", icon: "S", label: "Select / move" },
  { id: "trendline", icon: "/", label: "Trendline" },
  { id: "horizontal", icon: "-", label: "Horizontal line" },
  { id: "vertical", icon: "|", label: "Vertical line" },
  { id: "ray", icon: "R", label: "Ray" },
  { id: "rectangle", icon: "[]", label: "Rectangle" },
  { id: "arrow", icon: "->", label: "Arrow" },
  { id: "text", icon: "T", label: "Text note" },
  { id: "fib", icon: "F", label: "Fibonacci retracement" },
  { id: "measure", icon: "M", label: "Measure" },
  { id: "long-position", icon: "L", label: "Long position" },
  { id: "short-position", icon: "Sh", label: "Short position" },
  { id: "risk-reward", icon: "RR", label: "Risk/reward box" },
];
const DRAWING_TOOL_GROUPS = [
  { id: "select", icon: "S", label: "Select", tools: ["select"] },
  { id: "lines", icon: "/", label: "Lines", tools: ["trendline", "horizontal", "vertical", "ray", "arrow"] },
  { id: "shapes", icon: "[]", label: "Shapes", tools: ["rectangle", "text", "fib"] },
  { id: "measure", icon: "M", label: "Measure", tools: ["measure"] },
  { id: "positions", icon: "RR", label: "Positions", tools: ["long-position", "short-position", "risk-reward"] },
];
const TWO_POINT_TOOLS = new Set(["trendline", "ray", "rectangle", "arrow", "fib", "measure", "long-position", "short-position", "risk-reward"]);
const SINGLE_POINT_TOOLS = new Set(["horizontal", "vertical", "text"]);

export default function PriceChart({ coinId, symbol, days, source = "coingecko", pair = "", marketType = "Spot", chartType = "candles" }) {
  const { t } = useI18n();
  const { market, updateFromCandles } = useMarket();
  const wrapRef = useRef(null);
  const overlayRef = useRef(null);
  const chartApiRef = useRef(null);
  const mainSeriesRef = useRef(null);
  const dragRef = useRef(null);
  const [indicators, setIndicators] = useLocalStorageState("lensa.chartIndicatorInstances", DEFAULT_INDICATORS);
  const [drawingsByChart, setDrawingsByChart] = useLocalStorageState("lensa.drawingsByChart", {});
  const [addType, setAddType] = useState("ema");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSettings, setActiveSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [last, setLast] = useState(null);
  const [candlesForDraw, setCandlesForDraw] = useState([]);
  const [projectionApi, setProjectionApi] = useState(null);
  const [drawTool, setDrawTool] = useState("select");
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);
  const [magnetMode, setMagnetMode] = useLocalStorageState("lensa.chartMagnetMode", false);
  const [objectPanelOpen, setObjectPanelOpen] = useLocalStorageState("lensa.chartObjectPanelOpen.v2", false);
  const [settingsOpen, setSettingsOpen] = useLocalStorageState("lensa.chartDrawingSettingsOpen.v2", false);
  const [renderTick, setRenderTick] = useState(0);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [drawStyle, setDrawStyle] = useLocalStorageState("lensa.chartDrawingStyle", {
    color: "#f59e0b",
    width: 2,
    style: "solid",
  });
  const [draftPoint, setDraftPoint] = useState(null);
  const normalizedIndicators = useMemo(() => normalizeIndicators(indicators), [indicators]);
  const drawingKey = `lensa.drawings.${source}.${marketType}.${pair || symbol}.${days}`;
  const drawingContext = useMemo(
    () => ({ exchange: source, market: marketType, symbol: pair || symbol, timeframe: days }),
    [source, marketType, pair, symbol, days]
  );
  const drawings = Array.isArray(drawingsByChart[drawingKey]) ? drawingsByChart[drawingKey] : [];
  const selectedDrawing = drawings.find((drawing) => drawing.id === selectedDrawingId) || null;
  const activeTool = DRAWING_TOOLS.find((tool) => tool.id === drawTool) || DRAWING_TOOLS[0];

  function setChartDrawings(updater, { trackHistory = true } = {}) {
    setDrawingsByChart((prev) => {
      const current = Array.isArray(prev[drawingKey]) ? prev[drawingKey] : [];
      const next = typeof updater === "function" ? updater(current) : updater;
      if (trackHistory) {
        setUndoStack((stack) => [...stack.slice(-24), current]);
        setRedoStack([]);
      }
      return { ...prev, [drawingKey]: next };
    });
  }

  function addIndicator() {
    const next = makeIndicator(addType);
    setIndicators((prev) => [...normalizeIndicators(prev), next]);
    setActiveSettings(next.id);
    setMenuOpen(false);
  }

  function updateIndicator(id, patch) {
    setIndicators((prev) => normalizeIndicators(prev).map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function updateParam(id, key, value) {
    setIndicators((prev) =>
      normalizeIndicators(prev).map((item) =>
        item.id === id ? { ...item, params: { ...item.params, [key]: Number(value) } } : item
      )
    );
  }

  function removeIndicator(id) {
    setIndicators((prev) => normalizeIndicators(prev).filter((item) => item.id !== id));
    if (activeSettings === id) setActiveSettings(null);
  }

  useEffect(() => {
    let cancelled = false;
    let chart;
    (async () => {
      setLoading(true);
      setError(null);
      setSourceMeta(null);
      try {
        const candles = await getChartCandles({ id: coinId, symbol, timeframe: days, source, pair, marketType });
        if (cancelled || !wrapRef.current) return;
        if (!candles.length) throw new Error(t("chart.noData"));
        setSourceMeta(candles.meta || null);
        setCandlesForDraw(candles);
        updateFromCandles(candles);

        wrapRef.current.innerHTML = "";
        chart = createChart(wrapRef.current, {
          autoSize: true,
          layout: { background: { color: "transparent" }, textColor: "#9aa6b8", fontFamily: "'Fira Code', monospace" },
          grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
          rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
          timeScale: {
            borderColor: "rgba(255,255,255,0.08)",
            timeVisible: resolveTimeframe(days).intervalMinutes < 1440,
            barSpacing: 8,
            minBarSpacing: 2,
          },
          crosshair: { mode: 1 },
        });

        const priceFormat = priceFormatFor(candles[candles.length - 1].close, candles.meta?.precision || market.precision);
        const mainSeries = addMainSeries(chart, chartType, priceFormat);
        mainSeries.setData(toMainSeriesData(candles, chartType));
        addVolumeSeries(chart, candles);
        chartApiRef.current = chart;
        mainSeriesRef.current = mainSeries;
        setProjectionApi({ chart, series: mainSeries });
        addIndicatorSeries(chart, candles, normalizedIndicators);
        chart.timeScale().fitContent();
        chart.timeScale().subscribeVisibleLogicalRangeChange(() => setRenderTick((tick) => tick + 1));
        setLast(candles[candles.length - 1].close);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setSourceMeta(qualityMetaFromError(err, source));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (chart) chart.remove();
      chartApiRef.current = null;
      mainSeriesRef.current = null;
      setProjectionApi(null);
    };
  // market.precision is a fallback before fetched symbol metadata arrives; including it would refetch after storing that metadata.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinId, symbol, days, source, pair, marketType, chartType, normalizedIndicators, t, updateFromCandles]);

  useEffect(() => {
    const bump = () => setRenderTick((tick) => tick + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);

  function anchorFromEvent(e) {
    if (!overlayRef.current || !chartApiRef.current || !mainSeriesRef.current) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const logical = chartApiRef.current.timeScale().coordinateToLogical?.(x);
    const rawTime = chartApiRef.current.timeScale().coordinateToTime(x);
    const price = mainSeriesRef.current.coordinateToPrice(y);
    const time = timeFromLogical(logical, candlesForDraw) ?? normalizeChartTime(rawTime) ?? closestCandleTime(candlesForDraw, x, chartApiRef.current);
    if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
    return magnetMode ? snapAnchorToOhlc({ time, price, logical }, candlesForDraw) : { time, price, logical };
  }

  function handleDrawingPointerDown(e) {
    const anchor = anchorFromEvent(e);
    if (!anchor) return;
    if (drawTool !== "select") {
      e.preventDefault();
      if (SINGLE_POINT_TOOLS.has(drawTool)) {
        const drawing = makeDrawing(drawTool, anchor, anchor, drawStyle, drawingContext);
        setChartDrawings((prev) => [...prev, drawing]);
        setSelectedDrawingId(drawing.id);
        return;
      }
      if (TWO_POINT_TOOLS.has(drawTool) && !draftPoint) {
        setDraftPoint(anchor);
        return;
      }
      if (TWO_POINT_TOOLS.has(drawTool) && draftPoint) {
        const drawing = makeDrawing(drawTool, draftPoint, anchor, drawStyle, drawingContext);
        setChartDrawings((prev) => [...prev, drawing]);
        setSelectedDrawingId(drawing.id);
        setDraftPoint(null);
      }
      return;
    }

    const rect = overlayRef.current.getBoundingClientRect();
    const hit = findHitDrawing({
      drawings,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      chart: chartApiRef.current,
      series: mainSeriesRef.current,
    });
    if (!hit) {
      setSelectedDrawingId(null);
      return;
    }
    setSelectedDrawingId(hit.id);
    const drawing = drawings.find((item) => item.id === hit.id);
    if (!drawing || drawing.locked) return;
    e.preventDefault();
    setUndoStack((stack) => [...stack.slice(-24), drawings]);
    setRedoStack([]);
    dragRef.current = { id: hit.id, mode: hit.handle || "move", start: anchor, original: drawing };
  }

  function handleDrawingPointerMove(e) {
    const drag = dragRef.current;
    if (!drag) return;
    const anchor = anchorFromEvent(e);
    if (!anchor) return;
    e.preventDefault();
    setChartDrawings((prev) =>
      prev.map((drawing) => (drawing.id === drag.id ? moveDrawingByDrag(drawing, drag, anchor) : drawing)),
      { trackHistory: false }
    );
  }

  function handleDrawingPointerUp() {
    dragRef.current = null;
  }

  function deleteSelectedDrawing() {
    if (!selectedDrawingId) return;
    setChartDrawings((prev) => prev.filter((drawing) => drawing.id !== selectedDrawingId));
    setSelectedDrawingId(null);
  }

  function patchSelectedDrawing(patch) {
    if (!selectedDrawingId) return;
    setChartDrawings((prev) => prev.map((drawing) => (drawing.id === selectedDrawingId ? { ...drawing, ...patch } : drawing)));
  }

  function patchDrawing(id, patch) {
    setChartDrawings((prev) => prev.map((drawing) => (drawing.id === id ? { ...drawing, ...patch } : drawing)));
  }

  function undoDrawings() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((stack) => [drawings, ...stack].slice(0, 25));
    setUndoStack((stack) => stack.slice(0, -1));
    setChartDrawings(previous, { trackHistory: false });
  }

  function redoDrawings() {
    const next = redoStack[0];
    if (!next) return;
    setUndoStack((stack) => [...stack.slice(-24), drawings]);
    setRedoStack((stack) => stack.slice(1));
    setChartDrawings(next, { trackHistory: false });
  }

  function exportDrawings() {
    const payload = { version: 1, context: drawingContext, exportedAt: new Date().toISOString(), drawings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lensa-drawings-${drawingContext.exchange}-${drawingContext.market}-${drawingContext.symbol}-${drawingContext.timeframe}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importDrawings(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const imported = Array.isArray(parsed.drawings) ? parsed.drawings : Array.isArray(parsed) ? parsed : [];
        setChartDrawings((prev) => [...prev, ...imported.map((drawing) => normalizeImportedDrawing(drawing, drawingContext))]);
      } catch {
        setError("Drawing import failed. The selected file is not valid Lensa drawing JSON.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="price-chart">
      {/* Top indicator panel */}
      <div className="indicator-panel no-print">
        <div className="indicator-add">
          <button type="button" className="indicator-add__trigger" onClick={() => setMenuOpen((open) => !open)}>
            <b>+</b>
            <span>{INDICATOR_TYPES[addType].label}</span>
          </button>
          {menuOpen && (
            <>
              <div className="indicator-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="indicator-menu">
                <div className="indicator-menu__header">
                  <span>{t("chart.addIndicator")}</span>
                  <button type="button" className="indicator-menu__close" onClick={() => setMenuOpen(false)}>✕</button>
                </div>
                <div className="indicator-menu__body">
                  {groupIndicatorTypes().map(([group, items]) => (
                    <div className="indicator-menu__group" key={group}>
                      <span>{group}</span>
                      {items.map(([key, meta]) => (
                        <button type="button" key={key} className={key === addType ? "is-selected" : ""} onClick={() => setAddType(key)}>
                          <i className="indicator-dot" style={{ background: INDICATOR_TYPES[key].color }} />
                          {meta.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="indicator-menu__footer">
                  <button type="button" className="indicator-menu__add" onClick={addIndicator}>
                    + {t("chart.addIndicator")}: {INDICATOR_TYPES[addType].label}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="indicator-list">
          {normalizedIndicators.map((item) => (
            <IndicatorEditor
              key={item.id}
              item={item}
              active={activeSettings === item.id}
              onToggleSettings={() => setActiveSettings((id) => (id === item.id ? null : item.id))}
              onChange={(patch) => updateIndicator(item.id, patch)}
              onParamChange={(key, value) => updateParam(item.id, key, value)}
              onRemove={() => removeIndicator(item.id)}
              t={t}
            />
          ))}
        </div>
      </div>

      {/* Chart area: drawing toolbar + canvas side by side */}
      <div className="price-chart__body">
        {/* TradingView-style vertical drawing toolbar */}
        <aside className="drawing-toolbar no-print">
          <div className="drawing-toolbar__tools">
            {DRAWING_TOOL_GROUPS.map((group) => (
              <div className="drawing-tool-group" key={group.id}>
                <button
                  type="button"
                  className={`drawing-tool-btn${group.tools.includes(drawTool) ? " is-active" : ""}`}
                  onClick={() => {
                    setDrawTool(group.tools[0]);
                    setDraftPoint(null);
                  }}
                  title={group.label}
                >
                  <span className="drawing-tool-icon">{group.tools.includes(drawTool) ? activeTool.icon : group.icon}</span>
                  <span className="drawing-tool-label">{group.tools.includes(drawTool) ? activeTool.label : group.label}</span>
                </button>
                {group.tools.length > 1 && (
                  <div className="drawing-tool-flyout">
                    {group.tools.map((toolId) => {
                      const tool = DRAWING_TOOLS.find((entry) => entry.id === toolId);
                      return (
                        <button
                          type="button"
                          key={tool.id}
                          className={`drawing-flyout-btn${drawTool === tool.id ? " is-active" : ""}`}
                          onClick={() => {
                            setDrawTool(tool.id);
                            setDraftPoint(null);
                          }}
                        >
                          <span>{tool.icon}</span>
                          <strong>{tool.label}</strong>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="drawing-toolbar__sep" />
          <div className="drawing-toolbar__style">
            <button type="button" className={`drawing-tool-btn drawing-tool-btn--mode${magnetMode ? " is-active" : ""}`} onClick={() => setMagnetMode((value) => !value)} title={magnetMode ? "Magnet: snap to OHLC" : "Free: exact time/price under cursor"}>
              <span className="drawing-tool-icon">{magnetMode ? "Mg" : "Fr"}</span>
              <span className="drawing-tool-label">{magnetMode ? "Magnet to OHLC" : "Free placement"}</span>
            </button>
            <label className="drawing-tool-btn" title={t("chart.color")}>
              <span className="drawing-color-dot" style={{ background: drawStyle.color }} />
              <input
                type="color"
                value={drawStyle.color}
                onChange={(e) => setDrawStyle((prev) => ({ ...prev, color: e.target.value }))}
              />
            </label>
            <div className="drawing-width-picker">
              {[1, 2, 3].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`drawing-width-btn${drawStyle.width === w ? " is-active" : ""}`}
                  onClick={() => setDrawStyle((prev) => ({ ...prev, width: w }))}
                  title={`${t("chart.width")} ${w}`}
                >
                  <span style={{ height: `${w + 1}px` }} />
                </button>
              ))}
            </div>
            <button type="button" className="drawing-tool-btn" onClick={undoDrawings} disabled={!undoStack.length} title="Undo">
              <span className="drawing-tool-icon">U</span>
            </button>
            <button type="button" className="drawing-tool-btn" onClick={redoDrawings} disabled={!redoStack.length} title="Redo">
              <span className="drawing-tool-icon">Re</span>
            </button>
            <button type="button" className={`drawing-tool-btn${objectPanelOpen ? " is-active" : ""}`} onClick={() => setObjectPanelOpen((open) => !open)} title="Object tree">
              <span className="drawing-tool-icon">Obj</span>
            </button>
            <button type="button" className={`drawing-tool-btn${settingsOpen ? " is-active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} title="Drawing settings">
              <span className="drawing-tool-icon">Set</span>
            </button>
            <button type="button" className="drawing-tool-btn" onClick={exportDrawings} title="Export drawings JSON">
              <span className="drawing-tool-icon">Ex</span>
            </button>
            <label className="drawing-tool-btn" title="Import drawings JSON">
              <span className="drawing-tool-icon">Im</span>
              <input type="file" accept="application/json,.json" onChange={(e) => importDrawings(e.target.files?.[0])} />
            </label>
            <button type="button" className="drawing-tool-btn drawing-tool-btn--danger" onClick={deleteSelectedDrawing} disabled={!selectedDrawingId} title="Delete selected drawing">
              <span className="drawing-tool-icon">Del</span>
            </button>
            <button type="button" className="drawing-tool-btn drawing-tool-btn--danger" onClick={() => setChartDrawings([])} title={t("chart.clearDrawings")}>
              <span className="drawing-tool-icon">Clr</span>
            </button>
          </div>
        </aside>

        {/* Canvas + SVG drawing layer */}
        {error && <div className="chart-overlay chart-overlay--error">{t("chart.error", { e: error })}</div>}
        {loading && !error && <div className="chart-overlay">{t("chart.loading", { sym: symbol })}</div>}
        <div className={`price-chart__stage${drawTool !== "select" ? " is-drawing" : ""}${drawTool === "select" ? " is-selecting" : ""}`}>
          <div className="price-chart__canvas" ref={wrapRef} />
          <svg
            className="drawing-layer"
            ref={overlayRef}
            onPointerDown={handleDrawingPointerDown}
            onPointerMove={handleDrawingPointerMove}
            onPointerUp={handleDrawingPointerUp}
            onPointerLeave={handleDrawingPointerUp}
          >
            <defs>
              <marker id="drawing-arrow-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#f59e0b" />
              </marker>
            </defs>
            {drawings.map((drawing) => (
              <DrawingShape
                key={drawing.id}
                drawing={drawing}
                chart={projectionApi?.chart}
                series={projectionApi?.series}
                selected={drawing.id === selectedDrawingId}
                context={drawingContext}
                precision={sourceMeta?.precision || market.precision}
                renderTick={renderTick}
              />
            ))}
            {draftPoint && (
              <DraftPoint anchor={draftPoint} chart={projectionApi?.chart} series={projectionApi?.series} />
            )}
          </svg>
        </div>
        {(objectPanelOpen || settingsOpen) && (
          <aside className="drawing-inspector no-print">
            {objectPanelOpen && (
              <DrawingObjectTree
                drawings={drawings}
                selectedId={selectedDrawingId}
                onSelect={setSelectedDrawingId}
                onPatch={patchDrawing}
                context={drawingContext}
              />
            )}
            {settingsOpen && (
              <DrawingSettingsPanel
                drawing={selectedDrawing}
                onPatch={patchSelectedDrawing}
                onDelete={deleteSelectedDrawing}
                precision={sourceMeta?.precision || market.precision}
              />
            )}
          </aside>
        )}
      </div>

      <div className="price-chart__legend">
        <span><i className="dot dot--gold" /> {t("chart.indicators")}: {normalizedIndicators.length}</span>
        {sourceMeta && (
          <span className={`source-health source-health--${statusClass(sourceMeta.status)}`}>
            {sourceMeta.sourceLabel}: {sourceMeta.status} · confidence {Math.round((sourceMeta.confidence ?? 1) * 100)}%
          </span>
        )}
        {last != null && <span className="num">{formatPrice(last, market.precision, { currency: true, mode: "trading" })}</span>}
      </div>
      {sourceMeta?.warnings?.length > 0 && (
        <div className="source-warning">
          {sourceMeta.warnings.map((warning) => `${warning.sourceLabel}: ${warning.status}`).join(" · ")}
          {sourceMeta.source && ` · using ${sourceMeta.sourceLabel} fallback`}
        </div>
      )}
      {sourceMeta && <DataQualityGuard module="Chart" meta={sourceMeta} expectedTimeframe={days} />}
    </div>
  );
}

function statusClass(status = "") {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function IndicatorEditor({ item, active, onToggleSettings, onChange, onParamChange, onRemove, t }) {
  const meta = INDICATOR_TYPES[item.type] || INDICATOR_TYPES.ema;
  return (
    <div className={`indicator-editor ${active ? "is-active" : ""}`}>
      <div className="indicator-editor__top">
        <span className="indicator-swatch" style={{ background: item.color }} />
        <strong>{meta.label}</strong>
        <small>{indicatorSummary(item)}</small>
        <button type="button" className="mini-icon-btn" onClick={onToggleSettings} title={t("chart.settings")}>⚙</button>
        <button type="button" className="mini-icon-btn mini-icon-btn--danger" onClick={onRemove} title={t("chart.removeIndicator")}>x</button>
      </div>
      {active && (
        <div className="indicator-editor__controls">
          <label>{t("chart.visible")}<select value={item.visible ? "yes" : "no"} onChange={(e) => onChange({ visible: e.target.value === "yes" })}><option value="yes">On</option><option value="no">Off</option></select></label>
          <label>{t("chart.color")}<input type="color" value={item.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
          <label>{t("chart.width")}<input type="number" min="1" max="6" value={item.width} onChange={(e) => onChange({ width: Number(e.target.value) })} /></label>
          <label>{t("chart.style")}<select value={item.style} onChange={(e) => onChange({ style: e.target.value })}>{Object.entries(LINE_STYLES).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}</select></label>
          {meta.source && <label>{t("chart.source")}<select value={item.source} onChange={(e) => onChange({ source: e.target.value })}>{SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>}
          {Object.entries(meta.params).map(([key]) => (
            <label key={key}>{key}<input type="number" min="1" step={key === "mult" ? "0.25" : "1"} value={item.params[key]} onChange={(e) => onParamChange(key, e.target.value)} /></label>
          ))}
        </div>
      )}
    </div>
  );
}

function DrawingShape({ drawing, chart, series, selected, context, precision, renderTick }) {
  void renderTick;
  if (drawing.visible === false) return null;
  const compatibility = drawingCompatibility(drawing, context);
  const p1 = projectAnchor(drawing.p1, chart, series);
  const p2 = projectAnchor(drawing.p2 || drawing.p1, chart, series);
  if (!p1 || !p2) return <InactiveDrawingBadge drawing={drawing} compatibility={compatibility} />;
  const common = drawingStroke(drawing, compatibility);
  const label = drawingLabel(drawing, precision);
  const handles = selected && !drawing.locked ? <DrawingHandles p1={p1} p2={p2} /> : null;
  const className = `drawing-shape${selected ? " is-selected" : ""}${compatibility.status !== "active" ? " is-inactive" : ""}`;

  if (drawing.type === "horizontal") {
    return <g className={className}><line x1="0" y1={p1.y} x2="100%" y2={p1.y} {...common} /><PriceTag x={6} y={p1.y - 6} text={formatPrice(drawing.p1.price, precision, { mode: "trading" })} color={drawing.color} />{handles}</g>;
  }
  if (drawing.type === "vertical") {
    return <g className={className}><line x1={p1.x} y1="0" x2={p1.x} y2="100%" {...common} /><text x={p1.x + 6} y="16" fill={drawing.color} fontSize="11">{formatTimeLabel(drawing.p1.time)}</text>{handles}</g>;
  }
  if (drawing.type === "rectangle") {
    const box = rectFromPoints(p1, p2);
    return <g className={className}><rect {...box} {...common} fill={`${drawing.color}18`} />{handles}</g>;
  }
  if (drawing.type === "fib") {
    return <FibonacciDrawing drawing={drawing} p1={p1} p2={p2} common={common} precision={precision} selected={selected} />;
  }
  if (["long-position", "short-position", "risk-reward"].includes(drawing.type)) {
    return <PositionDrawing drawing={drawing} p1={p1} p2={p2} common={common} precision={precision} selected={selected} chart={chart} series={series} />;
  }
  if (drawing.type === "text") {
    return <g className={className}><text x={p1.x} y={p1.y} fill={drawing.color} fontSize="13" fontWeight="700">{drawing.text || "Note"}</text>{handles}</g>;
  }
  const rayEnd = drawing.type === "ray" ? extendRay(p1, p2) : p2;
  return (
    <g className={className}>
      <line x1={p1.x} y1={p1.y} x2={rayEnd.x} y2={rayEnd.y} {...common} markerEnd={drawing.type === "arrow" ? "url(#drawing-arrow-head)" : undefined} />
      {label && <text x={(p1.x + p2.x) / 2 + 8} y={(p1.y + p2.y) / 2 - 8} fill={drawing.color} fontSize="12" fontWeight="700">{label}</text>}
      {handles}
    </g>
  );
}

function DraftPoint({ anchor, chart, series }) {
  const p = projectAnchor(anchor, chart, series);
  if (!p) return null;
  return <circle cx={p.x} cy={p.y} r="4" fill="#f59e0b" />;
}

function DrawingHandles({ p1, p2 }) {
  return <g className="drawing-handles"><circle data-handle="p1" cx={p1.x} cy={p1.y} r="5" /><circle data-handle="p2" cx={p2.x} cy={p2.y} r="5" /></g>;
}

function PriceTag({ x, y, text, color }) {
  return <text x={x} y={Math.max(12, y)} fill={color} fontSize="11" fontWeight="700">{text}</text>;
}

function InactiveDrawingBadge({ drawing, compatibility }) {
  return <text x="8" y="24" fill="#f59e0b" fontSize="11">{drawingLabelName(drawing.type)} inactive: {compatibility.message}</text>;
}

function FibonacciDrawing({ drawing, p1, p2, common, precision, selected }) {
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const x1 = Math.min(p1.x, p2.x);
  const x2 = Math.max(p1.x, p2.x);
  const priceDelta = drawing.p2.price - drawing.p1.price;
  return (
    <g className={`drawing-shape${selected ? " is-selected" : ""}`}>
      {levels.map((level) => {
        const price = drawing.p1.price + priceDelta * level;
        const y = p1.y + (p2.y - p1.y) * level;
        return <g key={level}><line x1={x1} x2={x2} y1={y} y2={y} {...common} strokeDasharray="4 4" /><text x={x2 + 6} y={y - 4} fill={drawing.color} fontSize="11">{Math.round(level * 1000) / 10}% {formatPrice(price, precision, { mode: "trading" })}</text></g>;
      })}
      {selected && <DrawingHandles p1={p1} p2={p2} />}
    </g>
  );
}

function PositionDrawing({ drawing, p1, p2, common, precision, selected, chart, series }) {
  const isShort = drawing.type === "short-position" || (drawing.type === "risk-reward" && drawing.p2.price < drawing.p1.price);
  const entry = drawing.p1.price;
  const target = drawing.p2.price;
  const riskDistance = Math.abs(target - entry) / 2 || entry * 0.01;
  const stop = isShort ? entry + riskDistance : entry - riskDistance;
  const stopAnchor = { time: drawing.p2.time, price: stop };
  const stopPoint = projectAnchor(stopAnchor, chart, series) || { x: p2.x, y: p1.y + (p1.y - p2.y) / 2 };
  const rewardBox = rectFromPoints(p1, p2);
  const riskBox = rectFromPoints(p1, stopPoint);
  const rr = Math.abs(target - entry) / Math.max(1e-12, Math.abs(entry - stop));
  return (
    <g className={`drawing-shape${selected ? " is-selected" : ""}`}>
      <rect {...rewardBox} fill="rgba(34,197,94,0.16)" stroke="#22c55e" strokeWidth={common.strokeWidth} />
      <rect {...riskBox} fill="rgba(239,68,68,0.16)" stroke="#ef4444" strokeWidth={common.strokeWidth} />
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} {...common} />
      <text x={Math.max(p1.x, p2.x) + 6} y={p1.y - 4} fill={drawing.color} fontSize="11">Entry {formatPrice(entry, precision, { mode: "trading" })}</text>
      <text x={Math.max(p1.x, p2.x) + 6} y={p2.y - 4} fill="#22c55e" fontSize="11">Target {formatPrice(target, precision, { mode: "trading" })}</text>
      <text x={Math.max(p1.x, p2.x) + 6} y={stopPoint.y - 4} fill="#ef4444" fontSize="11">Stop {formatPrice(stop, precision, { mode: "trading" })} RR 1:{rr.toFixed(2)}</text>
      {selected && <DrawingHandles p1={p1} p2={p2} />}
    </g>
  );
}

function DrawingObjectTree({ drawings, selectedId, onSelect, onPatch, context }) {
  return (
    <div className="drawing-panel">
      <div className="drawing-panel__header"><strong>Object tree</strong><span>{drawings.length}</span></div>
      <div className="drawing-context-chip">{context.exchange} / {context.market} / {context.symbol} / {context.timeframe}</div>
      <div className="drawing-object-list">
        {drawings.length === 0 && <p>No drawings saved for this chart context.</p>}
        {drawings.map((drawing) => {
          const compatibility = drawingCompatibility(drawing, context);
          return (
            <button type="button" key={drawing.id} className={`drawing-object${selectedId === drawing.id ? " is-selected" : ""}`} onClick={() => onSelect(drawing.id)}>
              <span><b>{drawingLabelName(drawing.type)}</b><small>{compatibility.message}</small></span>
              <i>{compatibility.status}</i>
              <em onClick={(e) => { e.stopPropagation(); onPatch(drawing.id, { visible: drawing.visible === false }); }}>{drawing.visible === false ? "Show" : "Hide"}</em>
              <em onClick={(e) => { e.stopPropagation(); onPatch(drawing.id, { locked: !drawing.locked }); }}>{drawing.locked ? "Unlock" : "Lock"}</em>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DrawingSettingsPanel({ drawing, onPatch, onDelete, precision }) {
  if (!drawing) return <div className="drawing-panel"><div className="drawing-panel__header"><strong>Settings</strong></div><p>Select a drawing to edit its settings.</p></div>;
  return (
    <div className="drawing-panel">
      <div className="drawing-panel__header"><strong>Settings</strong><span>{drawingLabelName(drawing.type)}</span></div>
      <label>Color<input type="color" value={drawing.color} onChange={(e) => onPatch({ color: e.target.value })} /></label>
      <label>Width<input type="number" min="1" max="6" value={drawing.width} onChange={(e) => onPatch({ width: cleanWidth(e.target.value) })} /></label>
      <label>Style<select value={drawing.style} onChange={(e) => onPatch({ style: e.target.value })}>{Object.entries(LINE_STYLES).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}</select></label>
      {drawing.type === "text" && <label>Text<input value={drawing.text || "Note"} onChange={(e) => onPatch({ text: e.target.value })} /></label>}
      <div className="drawing-settings-prices">
        <span>P1 {formatPrice(drawing.p1?.price, precision, { mode: "trading" })}</span>
        {drawing.p2 && <span>P2 {formatPrice(drawing.p2.price, precision, { mode: "trading" })}</span>}
      </div>
      <button type="button" className="ghost-btn" onClick={() => onPatch({ locked: !drawing.locked })}>{drawing.locked ? "Unlock" : "Lock"}</button>
      <button type="button" className="ghost-btn" onClick={() => onPatch({ visible: drawing.visible === false })}>{drawing.visible === false ? "Show" : "Hide"}</button>
      <button type="button" className="ghost-btn" onClick={onDelete}>Delete</button>
    </div>
  );
}

function makeDrawing(type, p1, p2, style, context) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    type,
    context,
    p1,
    p2,
    color: style.color,
    width: cleanWidth(style.width),
    style: style.style || "solid",
    visible: true,
    locked: false,
    text: type === "text" ? "Note" : undefined,
    createdAt: new Date().toISOString(),
  };
}

function drawingLabel(drawing, precision) {
  if (drawing.type !== "measure") return null;
  const diff = drawing.p2.price - drawing.p1.price;
  const pct = drawing.p1.price ? (diff / drawing.p1.price) * 100 : 0;
  const seconds = Math.abs(drawing.p2.time - drawing.p1.time);
  return `${formatDuration(seconds)} / ${formatPrice(diff, precision, { mode: "trading" })} / ${pct.toFixed(2)}%`;
}
function projectAnchor(anchor, chart, series) {
  if (!anchor || !chart || !series) return null;
  const x = chart.timeScale().timeToCoordinate(anchor.time) ?? chart.timeScale().logicalToCoordinate?.(anchor.logical);
  const y = series.priceToCoordinate(anchor.price);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function timeFromLogical(logical, candles) {
  if (!Number.isFinite(logical) || !candles?.length) return null;
  const lo = Math.max(0, Math.min(candles.length - 1, Math.floor(logical)));
  const hi = Math.max(0, Math.min(candles.length - 1, Math.ceil(logical)));
  if (lo === hi) return candles[lo]?.time ?? null;
  const a = candles[lo];
  const b = candles[hi];
  if (!a || !b) return null;
  const ratio = logical - lo;
  return a.time + (b.time - a.time) * ratio;
}

function normalizeChartTime(value) {
  if (Number.isFinite(value)) return Number(value);
  if (value && Number.isFinite(value.timestamp)) return Number(value.timestamp);
  return null;
}

function closestCandleTime(candles, x, chart) {
  let best = null;
  let bestDistance = Infinity;
  for (const candle of candles || []) {
    const cx = chart.timeScale().timeToCoordinate(candle.time);
    if (!Number.isFinite(cx)) continue;
    const distance = Math.abs(cx - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candle.time;
    }
  }
  return best;
}

function snapAnchorToOhlc(anchor, candles) {
  if (!candles?.length) return anchor;
  let candle = candles[0];
  let timeDistance = Math.abs(candle.time - anchor.time);
  for (const item of candles) {
    const nextDistance = Math.abs(item.time - anchor.time);
    if (nextDistance < timeDistance) {
      timeDistance = nextDistance;
      candle = item;
    }
  }
  const prices = [candle.open, candle.high, candle.low, candle.close].filter(Number.isFinite);
  const price = prices.reduce((best, value) => (Math.abs(value - anchor.price) < Math.abs(best - anchor.price) ? value : best), prices[0] ?? anchor.price);
  const logical = candles.indexOf(candle);
  return { time: candle.time, price, logical };
}

function drawingStroke(drawing, compatibility) {
  const dash = drawing.style === "dashed" ? "8 6" : drawing.style === "dotted" ? "2 6" : undefined;
  return {
    stroke: drawing.color,
    strokeWidth: cleanWidth(drawing.width),
    strokeDasharray: compatibility.status === "active" ? dash : "4 6",
    strokeLinecap: "round",
    fill: "none",
    opacity: compatibility.status === "inactive" ? 0.38 : compatibility.status === "partial" ? 0.68 : 1,
  };
}

function drawingCompatibility(drawing, context) {
  const item = drawing.context || {};
  if (!item.exchange && !item.symbol) return { status: "inactive", message: "legacy screen-coordinate drawing" };
  if (item.exchange !== context.exchange || item.market !== context.market || item.symbol !== context.symbol) {
    return { status: "inactive", message: "different market context" };
  }
  if (item.timeframe !== context.timeframe) return { status: "partial", message: `saved on ${item.timeframe}` };
  return { status: "active", message: "active" };
}

function drawingLabelName(type) {
  return DRAWING_TOOLS.find((tool) => tool.id === type)?.label || type;
}

function rectFromPoints(p1, p2) {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
}

function extendRay(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 0.001) return { x: p2.x, y: p2.y > p1.y ? 4000 : -4000 };
  const endX = 4000;
  return { x: endX, y: p1.y + (dy / dx) * (endX - p1.x) };
}

function formatTimeLabel(time) {
  return new Date(time * 1000).toLocaleString();
}

function formatDuration(seconds) {
  const total = Math.round(Math.abs(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

function moveDrawingByDrag(drawing, drag, anchor) {
  if (drag.mode === "p1") return { ...drawing, p1: anchor };
  if (drag.mode === "p2") return { ...drawing, p2: anchor };
  const deltaTime = anchor.time - drag.start.time;
  const deltaPrice = anchor.price - drag.start.price;
  const deltaLogical = Number.isFinite(anchor.logical) && Number.isFinite(drag.start.logical) ? anchor.logical - drag.start.logical : 0;
  const moveAnchor = (point) => ({
    time: point.time + deltaTime,
    price: point.price + deltaPrice,
    logical: Number.isFinite(point.logical) ? point.logical + deltaLogical : point.logical,
  });
  return { ...drawing, p1: moveAnchor(drag.original.p1), p2: moveAnchor(drag.original.p2 || drag.original.p1) };
}

function findHitDrawing({ drawings, x, y, chart, series }) {
  for (const drawing of [...drawings].reverse()) {
    if (drawing.visible === false) continue;
    const p1 = projectAnchor(drawing.p1, chart, series);
    const p2 = projectAnchor(drawing.p2 || drawing.p1, chart, series);
    if (!p1 || !p2) continue;
    if (distance({ x, y }, p1) < 9) return { id: drawing.id, handle: "p1" };
    if (distance({ x, y }, p2) < 9) return { id: drawing.id, handle: "p2" };
    if (drawing.type === "horizontal" && Math.abs(y - p1.y) < 7) return { id: drawing.id };
    if (drawing.type === "vertical" && Math.abs(x - p1.x) < 7) return { id: drawing.id };
    if (drawing.type === "rectangle" || ["long-position", "short-position", "risk-reward"].includes(drawing.type)) {
      const box = rectFromPoints(p1, p2);
      if (x >= box.x - 5 && x <= box.x + box.width + 5 && y >= box.y - 5 && y <= box.y + box.height + 5) return { id: drawing.id };
    }
    if (distanceToSegment({ x, y }, p1, drawing.type === "ray" ? extendRay(p1, p2) : p2) < 7) return { id: drawing.id };
  }
  return null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function normalizeImportedDrawing(drawing, context) {
  const fallback = { time: Math.floor(Date.now() / 1000), price: 0 };
  return {
    ...drawing,
    id: drawing.id || `imported-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    context: drawing.context || context,
    p1: drawing.p1?.time && Number.isFinite(drawing.p1?.price) ? drawing.p1 : fallback,
    p2: drawing.p2?.time && Number.isFinite(drawing.p2?.price) ? drawing.p2 : drawing.p1 || fallback,
    color: drawing.color || "#f59e0b",
    width: cleanWidth(drawing.width),
    style: drawing.style || "solid",
    visible: drawing.visible !== false,
    locked: Boolean(drawing.locked),
  };
}

function addIndicatorSeries(chart, candles, indicators) {
  const addLine = (data, item, color = item.color, width = item.width, priceScaleId) => {
    const series = chart.addSeries(LineSeries, {
      color,
      lineWidth: cleanWidth(width),
      lineStyle: LINE_STYLES[item.style]?.value ?? 0,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId,
    }, priceScaleId === "osc" ? 1 : 0);
    series.setData(toLineData(candles, data));
  };

  const oscillators = indicators.filter((item) => ["rsi", "stoch", "macd", "roc"].includes(item.type));
  if (oscillators.length && chart.priceScale) {
    try {
      chart.priceScale("osc", 1).applyOptions({ scaleMargins: { top: 0.72, bottom: 0.05 }, borderVisible: false });
    } catch {
      /* custom price scales are best-effort in embedded chart runtimes */
    }
  }

  for (const item of indicators.filter((entry) => entry.visible !== false)) {
    const p = item.params;
    const source = sourceValues(candles, item.source);
    const color = item.color;
    const width = item.width;
    if (item.type === "ema") addLine(ema(source, cleanPeriod(p.period, 21)), item);
    else if (item.type === "sma") addLine(sma(source, cleanPeriod(p.period, 50)), item);
    else if (item.type === "wma") addLine(wma(source, cleanPeriod(p.period, 34)), item);
    else if (item.type === "hma") addLine(hma(source, cleanPeriod(p.period, 55)), item);
    else if (item.type === "bollinger") {
      const b = bollinger(source, cleanPeriod(p.period, 20), cleanNumber(p.mult, 2));
      addLine(b.upper, item);
      addLine(b.mid, item, softenColor(color), Math.max(1, width - 1));
      addLine(b.lower, item);
    } else if (item.type === "donchian") {
      const d = donchian(candles, cleanPeriod(p.period, 20));
      addLine(d.upper, item);
      addLine(d.lower, item);
    } else if (item.type === "ichimoku") {
      const ichi = ichimoku(candles, p);
      addLine(ichi.conversion, item);
      addLine(ichi.base, item, softenColor(color), width);
      addLine(ichi.spanB, item, "#8b5cf6", Math.max(1, width - 1));
    } else if (item.type === "supertrend") {
      addLine(supertrend(candles, cleanPeriod(p.period, 10), cleanNumber(p.mult, 3)), item);
    } else if (item.type === "rsi") {
      addLine(rsi(source, cleanPeriod(p.period, 14)), item, color, width, "osc");
    } else if (item.type === "stoch") {
      const s = stochastic(candles, cleanPeriod(p.period, 14), cleanPeriod(p.smooth, 3));
      addLine(s.k, item, color, width, "osc");
      addLine(s.d, item, softenColor(color), Math.max(1, width - 1), "osc");
    } else if (item.type === "macd") {
      const m = macd(source, cleanPeriod(p.fast, 12), cleanPeriod(p.slow, 26), cleanPeriod(p.signal, 9));
      addLine(m.macdLine, item, color, width, "osc");
      addLine(m.signalLine, item, softenColor(color), Math.max(1, width - 1), "osc");
    } else if (item.type === "roc") {
      addLine(roc(source, cleanPeriod(p.period, 10)), item, color, width, "osc");
    }
  }
}

function addVolumeSeries(chart, candles) {
  if (!candles.some((c) => Number.isFinite(c.volume))) return;
  const volume = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
    priceLineVisible: false,
    lastValueVisible: false,
  });
  volume.setData(
    candles.map((c) => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? "rgba(34, 197, 94, 0.32)" : "rgba(239, 68, 68, 0.32)",
    }))
  );
  try {
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
  } catch {
    /* volume scale is optional for non-Binance fallback data */
  }
}

function addMainSeries(chart, chartType, priceFormat) {
  if (chartType === "line") {
    return chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      priceFormat,
    });
  }
  if (chartType === "area") {
    return chart.addSeries(AreaSeries, {
      lineColor: "#f59e0b",
      topColor: "rgba(245, 158, 11, 0.28)",
      bottomColor: "rgba(245, 158, 11, 0.02)",
      lineWidth: 2,
      priceFormat,
    });
  }
  if (chartType === "bars") {
    return chart.addSeries(BarSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      priceFormat,
    });
  }
  return chart.addSeries(CandlestickSeries, {
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444",
    priceFormat,
  });
}

function toMainSeriesData(candles, chartType) {
  if (chartType === "line" || chartType === "area") {
    return candles.map((c) => ({ time: c.time, value: c.close }));
  }
  return candles;
}

function priceFormatFor(price, precisionMeta) {
  const sample = formatPrice(price, precisionMeta, { mode: "trading" }).replace(/,/g, "");
  const precision = Math.min(12, Math.max(0, (sample.split(".")[1] || "").length));
  return { type: "price", precision, minMove: 10 ** -precision };
}

function normalizeIndicators(value) {
  if (!Array.isArray(value)) return DEFAULT_INDICATORS;
  return value.filter((item) => item && INDICATOR_TYPES[item.type]).map((item) => makeIndicator(item.type, item));
}

function makeIndicator(type, overrides = {}) {
  const meta = INDICATOR_TYPES[type] || INDICATOR_TYPES.ema;
  return {
    id: overrides.id || `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    color: overrides.color || meta.color,
    width: cleanWidth(overrides.width ?? meta.width),
    style: overrides.style || "solid",
    source: overrides.source || "close",
    visible: overrides.visible !== false,
    params: { ...meta.params, ...(overrides.params || {}) },
  };
}

function groupIndicatorTypes() {
  const groups = new Map();
  for (const entry of Object.entries(INDICATOR_TYPES)) {
    const group = entry[1].group || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  return [...groups.entries()];
}

function indicatorSummary(item) {
  const values = Object.values(item.params || {}).slice(0, 3).join(", ");
  return `${values}${item.visible === false ? " off" : ""}`;
}

function sourceValues(candles, source = "close") {
  return candles.map((c) => {
    if (source === "open") return c.open;
    if (source === "high") return c.high;
    if (source === "low") return c.low;
    if (source === "hl2") return (c.high + c.low) / 2;
    if (source === "ohlc4") return (c.open + c.high + c.low + c.close) / 4;
    return c.close;
  });
}

function toLineData(candles, values) {
  return candles.map((c, i) => (values[i] != null && Number.isFinite(values[i]) ? { time: c.time, value: values[i] } : null)).filter(Boolean);
}

function cleanPeriod(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function cleanNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cleanWidth(value) {
  const n = Math.round(Number(value));
  return Math.min(6, Math.max(1, Number.isFinite(n) ? n : 2));
}

function wma(values, period) {
  const out = new Array(values.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let total = 0;
    for (let j = 0; j < period; j++) total += values[i - j] * (period - j);
    out[i] = total / denom;
  }
  return out;
}

function hma(values, period) {
  const half = Math.max(1, Math.round(period / 2));
  const root = Math.max(1, Math.round(Math.sqrt(period)));
  const fast = wma(values, half);
  const slow = wma(values, period);
  const diff = values.map((_, i) => (fast[i] != null && slow[i] != null ? 2 * fast[i] - slow[i] : null));
  return wma(diff.map((v) => v ?? 0), root).map((v, i) => (diff[i] == null ? null : v));
}

function donchian(candles, period) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    upper[i] = Math.max(...slice.map((c) => c.high));
    lower[i] = Math.min(...slice.map((c) => c.low));
  }
  return { upper, lower };
}

function ichimoku(candles, params) {
  return {
    conversion: midpoint(candles, cleanPeriod(params.conversion, 9)),
    base: midpoint(candles, cleanPeriod(params.base, 26)),
    spanB: midpoint(candles, cleanPeriod(params.spanB, 52)),
  };
}

function midpoint(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    out[i] = (Math.max(...slice.map((c) => c.high)) + Math.min(...slice.map((c) => c.low))) / 2;
  }
  return out;
}

function supertrend(candles, period, mult) {
  const atr = atrSeries(candles, period);
  const out = new Array(candles.length).fill(null);
  let trendUp = true;
  for (let i = 1; i < candles.length; i++) {
    if (atr[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const upper = hl2 + mult * atr[i];
    const lower = hl2 - mult * atr[i];
    const prev = out[i - 1] ?? lower;
    trendUp = candles[i].close > prev ? true : candles[i].close < prev ? false : trendUp;
    out[i] = trendUp ? Math.max(lower, prev) : Math.min(upper, prev);
  }
  return out;
}

function atrSeries(candles, period) {
  const out = new Array(candles.length).fill(null);
  const trs = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    trs[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  for (let i = period; i < candles.length; i++) {
    if (i === period) out[i] = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    else out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function stochastic(candles, period, smooth) {
  const kRaw = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    kRaw[i] = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100;
  }
  const k = sma(kRaw.map((v) => v ?? 0), smooth).map((v, i) => (kRaw[i] == null ? null : v));
  return { k, d: sma(k.map((v) => v ?? 0), smooth).map((v, i) => (k[i] == null ? null : v)) };
}

function softenColor(color) {
  if (!color.startsWith("#") || color.length !== 7) return color;
  const n = Number.parseInt(color.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + 44);
  const g = Math.min(255, ((n >> 8) & 255) + 44);
  const b = Math.min(255, (n & 255) + 44);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}



