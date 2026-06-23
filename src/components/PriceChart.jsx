import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { getCandles, resolveTimeframe } from "../lib/coingecko";
import { bollinger, ema, macd, roc, rsi, sma } from "../lib/strategies";
import { useI18n } from "../i18n/langStore";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const INDICATOR_TYPES = {
  ema: { label: "EMA", color: "#f59e0b", width: 2, params: { period: 21 } },
  sma: { label: "SMA", color: "#38bdf8", width: 2, params: { period: 50 } },
  wma: { label: "WMA", color: "#22c55e", width: 2, params: { period: 34 } },
  hma: { label: "HMA", color: "#fb7185", width: 2, params: { period: 55 } },
  bollinger: { label: "Bollinger Bands", color: "#a78bfa", width: 1, params: { period: 20, mult: 2 } },
  donchian: { label: "Donchian Channel", color: "#2dd4bf", width: 1, params: { period: 20 } },
  ichimoku: { label: "Ichimoku", color: "#f97316", width: 1, params: { conversion: 9, base: 26, spanB: 52 } },
  supertrend: { label: "Supertrend", color: "#22c55e", width: 2, params: { period: 10, mult: 3 } },
  rsi: { label: "RSI", color: "#facc15", width: 2, params: { period: 14 } },
  stoch: { label: "Stochastic", color: "#60a5fa", width: 2, params: { period: 14, smooth: 3 } },
  macd: { label: "MACD", color: "#c084fc", width: 2, params: { fast: 12, slow: 26, signal: 9 } },
  roc: { label: "ROC", color: "#34d399", width: 2, params: { period: 10 } },
};

const DEFAULT_INDICATORS = [
  makeIndicator("ema", { id: "ema-21", params: { period: 21 } }),
];

export default function PriceChart({ coinId, symbol, days }) {
  const { t } = useI18n();
  const wrapRef = useRef(null);
  const [indicators, setIndicators] = useLocalStorageState("lensa.chartIndicatorInstances", DEFAULT_INDICATORS);
  const [addType, setAddType] = useState("ema");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  function addIndicator() {
    setIndicators((prev) => [...normalizeIndicators(prev), makeIndicator(addType)]);
  }

  function updateIndicator(id, patch) {
    setIndicators((prev) =>
      normalizeIndicators(prev).map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
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
  }

  const normalizedIndicators = useMemo(() => normalizeIndicators(indicators), [indicators]);

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

        addIndicatorSeries(chart, candles, normalizedIndicators);

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
  }, [coinId, days, normalizedIndicators, t]);

  return (
    <div className="price-chart">
      <div className="indicator-panel no-print">
        <div className="indicator-add">
          <select value={addType} onChange={(e) => setAddType(e.target.value)} aria-label={t("chart.addIndicator")}>
            {Object.entries(INDICATOR_TYPES).map(([key, meta]) => (
              <option key={key} value={key}>{meta.label}</option>
            ))}
          </select>
          <button type="button" className="ghost-btn" onClick={addIndicator}>{t("chart.addIndicator")}</button>
        </div>

        <div className="indicator-list">
          {normalizedIndicators.map((item) => (
            <IndicatorEditor
              key={item.id}
              item={item}
              onChange={(patch) => updateIndicator(item.id, patch)}
              onParamChange={(key, value) => updateParam(item.id, key, value)}
              onRemove={() => removeIndicator(item.id)}
              t={t}
            />
          ))}
        </div>
      </div>

      {error && <div className="chart-overlay chart-overlay--error">{t("chart.error", { e: error })}</div>}
      {loading && !error && <div className="chart-overlay">{t("chart.loading", { sym: symbol })}</div>}
      <div className="price-chart__canvas" ref={wrapRef} />
      <div className="price-chart__legend">
        <span><i className="dot dot--gold" /> {t("chart.indicators")}: {normalizedIndicators.length}</span>
        {last != null && <span className="num">${last.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>}
      </div>
    </div>
  );
}

function IndicatorEditor({ item, onChange, onParamChange, onRemove, t }) {
  const meta = INDICATOR_TYPES[item.type] || INDICATOR_TYPES.ema;
  return (
    <div className="indicator-editor">
      <div className="indicator-editor__top">
        <strong>{meta.label}</strong>
        <button type="button" className="mini-icon-btn" onClick={onRemove} title={t("chart.removeIndicator")}>×</button>
      </div>
      <div className="indicator-editor__controls">
        <label>
          {t("chart.color")}
          <input type="color" value={item.color} onChange={(e) => onChange({ color: e.target.value })} />
        </label>
        <label>
          {t("chart.width")}
          <input
            type="number"
            min="1"
            max="6"
            value={item.width}
            onChange={(e) => onChange({ width: Number(e.target.value) })}
          />
        </label>
        {Object.entries(meta.params).map(([key]) => (
          <label key={key}>
            {key}
            <input
              type="number"
              min="1"
              step={key === "mult" ? "0.25" : "1"}
              value={item.params[key]}
              onChange={(e) => onParamChange(key, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function addIndicatorSeries(chart, candles, indicators) {
  const closes = candles.map((c) => c.close);
  const addLine = (data, color, width = 2, priceScaleId) => {
    const series = chart.addSeries(LineSeries, {
      color,
      lineWidth: cleanWidth(width),
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId,
    });
    series.setData(toLineData(candles, data));
  };

  const oscillators = indicators.filter((item) => ["rsi", "stoch", "macd", "roc"].includes(item.type));
  if (oscillators.length && chart.priceScale) {
    try {
      chart.priceScale("osc").applyOptions({ scaleMargins: { top: 0.72, bottom: 0.05 }, borderVisible: false });
    } catch {
      /* custom price scales are best-effort in embedded chart runtimes */
    }
  }

  for (const item of indicators) {
    const p = item.params;
    const color = item.color;
    const width = item.width;
    if (item.type === "ema") addLine(ema(closes, cleanPeriod(p.period, 21)), color, width);
    else if (item.type === "sma") addLine(sma(closes, cleanPeriod(p.period, 50)), color, width);
    else if (item.type === "wma") addLine(wma(closes, cleanPeriod(p.period, 34)), color, width);
    else if (item.type === "hma") addLine(hma(closes, cleanPeriod(p.period, 55)), color, width);
    else if (item.type === "bollinger") {
      const b = bollinger(closes, cleanPeriod(p.period, 20), cleanNumber(p.mult, 2));
      addLine(b.upper, color, width);
      addLine(b.mid, softenColor(color), Math.max(1, width - 1));
      addLine(b.lower, color, width);
    } else if (item.type === "donchian") {
      const d = donchian(candles, cleanPeriod(p.period, 20));
      addLine(d.upper, color, width);
      addLine(d.lower, color, width);
    } else if (item.type === "ichimoku") {
      const ichi = ichimoku(candles, p);
      addLine(ichi.conversion, color, width);
      addLine(ichi.base, softenColor(color), width);
      addLine(ichi.spanB, "#8b5cf6", Math.max(1, width - 1));
    } else if (item.type === "supertrend") {
      addLine(supertrend(candles, cleanPeriod(p.period, 10), cleanNumber(p.mult, 3)), color, width);
    } else if (item.type === "rsi") {
      addLine(rsi(closes, cleanPeriod(p.period, 14)), color, width, "osc");
    } else if (item.type === "stoch") {
      const s = stochastic(candles, cleanPeriod(p.period, 14), cleanPeriod(p.smooth, 3));
      addLine(s.k, color, width, "osc");
      addLine(s.d, softenColor(color), Math.max(1, width - 1), "osc");
    } else if (item.type === "macd") {
      const m = macd(closes, cleanPeriod(p.fast, 12), cleanPeriod(p.slow, 26), cleanPeriod(p.signal, 9));
      addLine(m.macdLine, color, width, "osc");
      addLine(m.signalLine, softenColor(color), Math.max(1, width - 1), "osc");
    } else if (item.type === "roc") {
      addLine(roc(closes, cleanPeriod(p.period, 10)), color, width, "osc");
    }
  }
}

function normalizeIndicators(value) {
  if (!Array.isArray(value)) return DEFAULT_INDICATORS;
  return value
    .filter((item) => item && INDICATOR_TYPES[item.type])
    .map((item) => makeIndicator(item.type, item));
}

function makeIndicator(type, overrides = {}) {
  const meta = INDICATOR_TYPES[type] || INDICATOR_TYPES.ema;
  return {
    id: overrides.id || `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    color: overrides.color || meta.color,
    width: cleanWidth(overrides.width ?? meta.width),
    params: { ...meta.params, ...(overrides.params || {}) },
  };
}

function toLineData(candles, values) {
  return candles
    .map((c, i) => (values[i] != null && Number.isFinite(values[i]) ? { time: c.time, value: values[i] } : null))
    .filter(Boolean);
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
  const conversion = midpoint(candles, cleanPeriod(params.conversion, 9));
  const base = midpoint(candles, cleanPeriod(params.base, 26));
  const spanB = midpoint(candles, cleanPeriod(params.spanB, 52));
  return { conversion, base, spanB };
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
    trs[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
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
