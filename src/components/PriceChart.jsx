import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { getCandles, resolveTimeframe } from "../lib/coingecko";
import { bollinger, ema, sma } from "../lib/strategies";
import { useI18n } from "../i18n/langStore";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const DEFAULT_INDICATORS = {
  ema: { enabled: true, period: 21 },
  sma: { enabled: false, period: 50 },
  bollinger: { enabled: false, period: 20, mult: 2 },
  donchian: { enabled: false, period: 20 },
};

/**
 * Native candlestick chart powered by CoinGecko OHLC — works for ANY coin and
 * ANY timeframe (in days), unlike a fixed TradingView symbol mapping.
 */
export default function PriceChart({ coinId, symbol, days }) {
  const { t } = useI18n();
  const wrapRef = useRef(null);
  const [indicators, setIndicators] = useLocalStorageState("lensa.chartIndicators", DEFAULT_INDICATORS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  function updateIndicator(name, patch) {
    setIndicators((prev) => ({
      ...prev,
      [name]: { ...DEFAULT_INDICATORS[name], ...prev[name], ...patch },
    }));
  }

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

        addIndicatorSeries(chart, candles, indicators);

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
  }, [coinId, days, indicators, t]);

  return (
    <div className="price-chart">
      <div className="indicator-panel no-print">
        <IndicatorToggle
          label="EMA"
          config={indicators.ema}
          fields={[{ key: "period", min: 2, max: 300 }]}
          onChange={(patch) => updateIndicator("ema", patch)}
        />
        <IndicatorToggle
          label="SMA"
          config={indicators.sma}
          fields={[{ key: "period", min: 2, max: 500 }]}
          onChange={(patch) => updateIndicator("sma", patch)}
        />
        <IndicatorToggle
          label="Bollinger"
          config={indicators.bollinger}
          fields={[{ key: "period", min: 2, max: 300 }, { key: "mult", min: 0.5, max: 5, step: 0.5 }]}
          onChange={(patch) => updateIndicator("bollinger", patch)}
        />
        <IndicatorToggle
          label="Donchian"
          config={indicators.donchian}
          fields={[{ key: "period", min: 2, max: 300 }]}
          onChange={(patch) => updateIndicator("donchian", patch)}
        />
      </div>
      {error && <div className="chart-overlay chart-overlay--error">{t("chart.error", { e: error })}</div>}
      {loading && !error && <div className="chart-overlay">{t("chart.loading", { sym: symbol })}</div>}
      <div className="price-chart__canvas" ref={wrapRef} />
      <div className="price-chart__legend">
        <span><i className="dot dot--gold" /> {t("chart.indicators")}</span>
        {last != null && <span className="num">${last.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>}
      </div>
    </div>
  );
}

function addIndicatorSeries(chart, candles, indicators) {
  const closes = candles.map((c) => c.close);
  const addLine = (data, color, width = 2) => {
    const series = chart.addSeries(LineSeries, {
      color,
      lineWidth: width,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(
      candles
        .map((c, i) => (data[i] != null ? { time: c.time, value: data[i] } : null))
        .filter(Boolean)
    );
  };

  if (indicators.ema?.enabled) addLine(ema(closes, cleanPeriod(indicators.ema.period, 21)), "#f59e0b", 2);
  if (indicators.sma?.enabled) addLine(sma(closes, cleanPeriod(indicators.sma.period, 50)), "#38bdf8", 2);
  if (indicators.bollinger?.enabled) {
    const b = bollinger(closes, cleanPeriod(indicators.bollinger.period, 20), cleanNumber(indicators.bollinger.mult, 2));
    addLine(b.upper, "#a78bfa", 1);
    addLine(b.mid, "#7c3aed", 1);
    addLine(b.lower, "#a78bfa", 1);
  }
  if (indicators.donchian?.enabled) {
    const d = donchian(candles, cleanPeriod(indicators.donchian.period, 20));
    addLine(d.upper, "#22c55e", 1);
    addLine(d.lower, "#ef4444", 1);
  }
}

function cleanPeriod(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 2 ? n : fallback;
}

function cleanNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function IndicatorToggle({ label, config, fields, onChange }) {
  return (
    <div className={`indicator-toggle ${config?.enabled ? "is-on" : ""}`}>
      <label>
        <input
          type="checkbox"
          checked={Boolean(config?.enabled)}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span>{label}</span>
      </label>
      {fields.map((field) => (
        <input
          key={field.key}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step || 1}
          value={config?.[field.key] ?? ""}
          onChange={(e) => onChange({ [field.key]: Number(e.target.value) })}
          aria-label={`${label} ${field.key}`}
        />
      ))}
    </div>
  );
}
