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
import ChartDrawingLayer from "./ChartDrawingLayer";
import InfoTip from "./InfoTip";

const INDICATOR_TYPES = {
  ema: { label: "EMA", group: "Moving averages", color: "#f59e0b", width: 2, source: true, params: { period: 21 }, glossaryKey: "glossary.chart.ema" },
  sma: { label: "SMA", group: "Moving averages", color: "#38bdf8", width: 2, source: true, params: { period: 50 }, glossaryKey: "glossary.chart.sma" },
  wma: { label: "WMA", group: "Moving averages", color: "#22c55e", width: 2, source: true, params: { period: 34 }, glossaryKey: "glossary.chart.wma" },
  hma: { label: "HMA", group: "Moving averages", color: "#fb7185", width: 2, source: true, params: { period: 55 }, glossaryKey: "glossary.chart.hma" },
  bollinger: { label: "Bollinger Bands", group: "Bands", color: "#a78bfa", width: 1, source: true, params: { period: 20, mult: 2 }, glossaryKey: "glossary.chart.bollinger" },
  donchian: { label: "Donchian Channel", group: "Bands", color: "#2dd4bf", width: 1, params: { period: 20 }, glossaryKey: "glossary.chart.donchian" },
  ichimoku: { label: "Ichimoku", group: "Trend", color: "#f97316", width: 1, params: { conversion: 9, base: 26, spanB: 52 }, glossaryKey: "glossary.chart.ichimoku" },
  supertrend: { label: "Supertrend", group: "Trend", color: "#22c55e", width: 2, params: { period: 10, mult: 3 }, glossaryKey: "glossary.chart.supertrend" },
  rsi: { label: "RSI", group: "Oscillators", color: "#facc15", width: 2, source: true, params: { period: 14 }, glossaryKey: "glossary.chart.rsi" },
  stoch: { label: "Stochastic", group: "Oscillators", color: "#60a5fa", width: 2, params: { period: 14, smooth: 3 }, glossaryKey: "glossary.chart.stoch" },
  macd: { label: "MACD", group: "Oscillators", color: "#c084fc", width: 2, source: true, params: { fast: 12, slow: 26, signal: 9 }, glossaryKey: "glossary.chart.macd" },
  roc: { label: "ROC", group: "Oscillators", color: "#34d399", width: 2, source: true, params: { period: 10 }, glossaryKey: "glossary.chart.roc" },
};

const LINE_STYLES = {
  solid: { label: "Solid", value: 0 },
  dotted: { label: "Dotted", value: 1 },
  dashed: { label: "Dashed", value: 2 },
};
const SOURCES = ["close", "open", "high", "low", "hl2", "ohlc4"];
const DEFAULT_INDICATORS = [makeIndicator("ema", { id: "ema-21", params: { period: 21 } })];

export default function PriceChart({ coinId, symbol, days, source = "coingecko", pair = "", marketType = "Spot", chartType = "candles" }) {
  const { t } = useI18n();
  const { market, updateFromCandles } = useMarket();
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const chartApiRef = useRef(null);
  const mainSeriesRef = useRef(null);
  const [indicators, setIndicators] = useLocalStorageState("lensa.chartIndicatorInstances", DEFAULT_INDICATORS);
  const [addType, setAddType] = useState("ema");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSettings, setActiveSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [last, setLast] = useState(null);
  const [candlesForDraw, setCandlesForDraw] = useState([]);
  const [projectionApi, setProjectionApi] = useState(null);
  const [renderTick, setRenderTick] = useState(0);
  const normalizedIndicators = useMemo(() => normalizeIndicators(indicators), [indicators]);
  const drawingContext = useMemo(
    () => ({ exchange: source, market: marketType, symbol: pair || symbol, timeframe: days }),
    [source, marketType, pair, symbol, days]
  );

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
          layout: { background: { color: "transparent" }, textColor: "#9aa6b8", fontFamily: "'Vazirmatn', 'Inter', -apple-system, 'Segoe UI', sans-serif" },
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
                          {meta.glossaryKey ? <InfoTip term={meta.glossaryKey} /> : null}
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
        {error && <div className="chart-overlay chart-overlay--error">{t("chart.error", { e: error })}</div>}
        {loading && !error && <div className="chart-overlay">{t("chart.loading", { sym: symbol })}</div>}
        <div className="price-chart__stage" ref={stageRef}>
          <div className="price-chart__canvas" ref={wrapRef} />
          {projectionApi && (
            <ChartDrawingLayer
              chart={projectionApi.chart}
              series={projectionApi.series}
              candles={candlesForDraw}
              context={drawingContext}
              renderTick={renderTick}
              stageRef={stageRef}
            />
          )}
        </div>
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
        <strong>
          {meta.label}
          {meta.glossaryKey ? <InfoTip term={meta.glossaryKey} /> : null}
        </strong>
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



