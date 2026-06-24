import { useMemo, useState } from "react";
import MarketContextBar from "../components/MarketContextBar";
import { getChartCandles } from "../lib/coingecko";
import { ema, macd, rsi } from "../lib/strategies";
import { calculateATR } from "../lib/risk";
import { formatPrice, formatUsd } from "../lib/priceFormat";
import { useMarket } from "../context/MarketContext";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useStaggerReveal } from "../hooks/useAnimations";

export default function DecisionCenter() {
  const { market, updateFromCandles } = useMarket();
  const [decision, setDecision] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [journal, setJournal] = useLocalStorageState("lensa.journal", []);
  const [alerts, setAlerts] = useLocalStorageState("lensa.alerts", []);
  const [note, setNote] = useState("");
  const [alertPrice, setAlertPrice] = useState("");
  const reveal = useStaggerReveal([decision, error]);

  async function runDecision() {
    setLoading(true);
    setError(null);
    try {
      const candles = await getChartCandles({
        id: market.coin.id,
        symbol: market.symbol,
        timeframe: market.timeframe,
        source: market.exchange,
        pair: market.pair,
        marketType: market.marketType,
      });
      if (candles.length < 60) throw new Error("Not enough candles for decision analysis.");
      updateFromCandles(candles);
      setDecision(analyzeDecision(candles, candles.meta, market));
    } catch (err) {
      setError(err.message);
      setDecision(null);
    } finally {
      setLoading(false);
    }
  }

  const scopedJournal = useMemo(
    () => journal.filter((item) => item.contextKey === contextKey(market)).slice(0, 6),
    [journal, market]
  );
  const scopedAlerts = useMemo(
    () => alerts.filter((item) => item.contextKey === contextKey(market)).slice(0, 6),
    [alerts, market]
  );

  function saveNote() {
    if (!note.trim()) return;
    setJournal((prev) => [
      {
        id: crypto.randomUUID?.() || `${Date.now()}`,
        contextKey: contextKey(market),
        context: snapshotContext(market),
        note: note.trim(),
        decision: decision?.action || "Unrated",
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setNote("");
  }

  function saveAlert() {
    const price = Number(alertPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    setAlerts((prev) => [
      {
        id: crypto.randomUUID?.() || `${Date.now()}`,
        contextKey: contextKey(market),
        context: snapshotContext(market),
        price,
        createdAt: new Date().toISOString(),
        status: "Active while app is open",
      },
      ...prev,
    ]);
    setAlertPrice("");
  }

  return (
    <div className="decision-page" ref={reveal}>
      <div className="disclaimer-banner reveal">
        Decision Center is rule-based decision support, not financial advice. It does not place trades or connect to exchanges.
      </div>

      <div className="glass-card decision-hero reveal">
        <MarketContextBar module="Decision Center" lastPrice={decision?.lastPrice} />
        <div className="decision-hero__main">
          <div>
            <span className="panel-subtitle">Selected setup</span>
            <h1>{market.pair} · {market.marketType}</h1>
          </div>
          <button className="run-btn" onClick={runDecision} disabled={loading}>
            {loading ? "Analyzing..." : "Analyze Long / Short"}
          </button>
        </div>
      </div>

      {error && <p className="news-error reveal">{error}</p>}

      {decision && (
        <>
          <div className={`decision-card glass-card reveal decision-card--${decision.action.toLowerCase().replace(/\s+/g, "-")}`}>
            <span className="decision-label">Decision</span>
            <strong>{decision.action}</strong>
            <p>{decision.reason}</p>
            <div className="decision-metrics">
              <Metric label="Confidence" value={`${decision.confidence}%`} />
              <Metric label="Last price" value={formatUsd(decision.lastPrice, decision.precision, { mode: "trading" })} />
              <Metric label="ATR" value={formatUsd(decision.atr, decision.precision, { mode: "trading" })} />
              <Metric label="Source" value={`${decision.sourceLabel} · ${decision.status}`} />
            </div>
          </div>

          <div className="decision-grid">
            <SetupCard title="Long Setup" setup={decision.longSetup} precision={decision.precision} />
            <SetupCard title="Short Setup" setup={decision.shortSetup} precision={decision.precision} />
          </div>

          <div className="decision-grid">
            <LocalPanel title="Journal" module="Journal">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note for this exact market context..." />
              <button className="ghost-btn" onClick={saveNote}>Save journal note</button>
              {scopedJournal.map((item) => (
                <div className="local-item" key={item.id}>
                  <strong>{item.decision}</strong>
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <p>{item.note}</p>
                </div>
              ))}
            </LocalPanel>
            <LocalPanel title="Alerts" module="Alerts">
              <input type="number" value={alertPrice} onChange={(e) => setAlertPrice(e.target.value)} placeholder="Alert price while app is open" />
              <button className="ghost-btn" onClick={saveAlert}>Save in-browser alert</button>
              {scopedAlerts.map((item) => (
                <div className="local-item" key={item.id}>
                  <strong>{formatUsd(item.price, market.precision, { mode: "trading" })}</strong>
                  <span>{item.status}</span>
                </div>
              ))}
            </LocalPanel>
          </div>
        </>
      )}
    </div>
  );
}

function analyzeDecision(candles, meta, market) {
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);
  const fast = ema(closes, 9).at(-1);
  const slow = ema(closes, 21).at(-1);
  const trend = ema(closes, 55).at(-1);
  const r = rsi(closes, 14).at(-1);
  const m = macd(closes, 12, 26, 9);
  const hist = m.hist.at(-1);
  const prevHist = m.hist.at(-2);
  const atr = calculateATR(candles, 14);
  const precision = meta?.precision || market.precision;

  let score = 0;
  const reasons = [];
  if (fast > slow) { score += 2; reasons.push("fast EMA above slow EMA"); }
  else { score -= 2; reasons.push("fast EMA below slow EMA"); }
  if (last.close > trend) { score += 1; reasons.push("price above trend EMA"); }
  else { score -= 1; reasons.push("price below trend EMA"); }
  if (r > 55 && r < 76) { score += 1; reasons.push("RSI supports upside without extreme overbought"); }
  if (r < 45 && r > 24) { score -= 1; reasons.push("RSI supports downside without extreme oversold"); }
  if (hist > 0 && hist > prevHist) { score += 1; reasons.push("MACD momentum rising"); }
  if (hist < 0 && hist < prevHist) { score -= 1; reasons.push("MACD momentum falling"); }

  const confidence = Math.max(20, Math.min(92, 45 + Math.abs(score) * 9 - (meta?.warnings?.length || 0) * 8));
  const action = confidence < 45 ? "No Trade" : score >= 3 ? "Long" : score <= -3 ? "Short" : "Wait";
  const risk = atr || last.close * 0.015;
  return {
    action,
    confidence,
    reason: reasons.join("; "),
    lastPrice: last.close,
    atr: risk,
    precision,
    sourceLabel: meta?.sourceLabel || market.exchange,
    status: meta?.status || market.dataSourceStatus,
    longSetup: {
      entry: last.close,
      stop: last.close - risk * 1.4,
      target1: last.close + risk * 2,
      target2: last.close + risk * 3.2,
      valid: score > 0,
    },
    shortSetup: {
      entry: last.close,
      stop: last.close + risk * 1.4,
      target1: last.close - risk * 2,
      target2: last.close - risk * 3.2,
      valid: score < 0,
    },
  };
}

function SetupCard({ title, setup, precision }) {
  return (
    <div className={`setup-card glass-card reveal ${setup.valid ? "is-valid" : ""}`}>
      <h2>{title}</h2>
      <Metric label="Entry" value={formatUsd(setup.entry, precision, { mode: "trading" })} />
      <Metric label="Stop loss" value={formatUsd(setup.stop, precision, { mode: "futures" })} />
      <Metric label="Target 1" value={formatUsd(setup.target1, precision, { mode: "futures" })} />
      <Metric label="Target 2" value={formatUsd(setup.target2, precision, { mode: "futures" })} />
      <Metric label="Estimated R" value={formatPrice(Math.abs((setup.target1 - setup.entry) / (setup.entry - setup.stop)), {}, { mode: "display" })} />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="decision-metric">
      <span>{label}</span>
      <strong className="num">{value}</strong>
    </div>
  );
}

function LocalPanel({ title, module, children }) {
  return (
    <div className="local-panel glass-card reveal">
      <MarketContextBar module={module} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function contextKey(market) {
  return [market.exchange, market.pair, market.marketType, market.timeframe].join("|");
}

function snapshotContext(market) {
  return {
    exchange: market.exchange,
    pair: market.pair,
    marketType: market.marketType,
    timeframe: market.timeframe,
    historicalRange: market.historicalRange,
  };
}
