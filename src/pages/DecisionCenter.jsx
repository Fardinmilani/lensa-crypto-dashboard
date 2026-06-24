import { useMemo, useState } from "react";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import { getChartCandles } from "../lib/coingecko";
import { firstTouchProbabilities, monteCarlo, touchProbability } from "../lib/forecast";
import { ema, macd, rsi } from "../lib/strategies";
import { calculateATR } from "../lib/risk";
import { formatPrice, formatUsd } from "../lib/priceFormat";
import { qualityMetaFromError } from "../lib/dataQuality";
import { useMarket } from "../context/MarketContext";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useStaggerReveal } from "../hooks/useAnimations";

const DEFAULT_RISK = {
  accountSize: 10000,
  riskPercent: 1,
  leverage: 3,
  feePercent: 0.08,
  slippagePercent: 0.05,
};

export default function DecisionCenter() {
  const { market, updateFromCandles } = useMarket();
  const [decision, setDecision] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [riskInputs, setRiskInputs] = useLocalStorageState("lensa.decision.risk", DEFAULT_RISK);
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
      if (candles.length < 60) throw new Error("Not enough candles for long/short decision analysis.");
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotContext(market));
      setDecision(analyzeDecision(candles, candles.meta, market));
    } catch (err) {
      setError(err.message);
      setDecision(null);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoading(false);
    }
  }

  const activeSetup = useMemo(() => {
    if (!decision) return null;
    if (decision.finalDecision === "Long") return decision.longSetup;
    if (decision.finalDecision === "Short") return decision.shortSetup;
    return decision.longSetup.score >= decision.shortSetup.score ? decision.longSetup : decision.shortSetup;
  }, [decision]);

  const risk = useMemo(
    () => (activeSetup ? calculateRiskEngine(activeSetup, riskInputs, market) : null),
    [activeSetup, riskInputs, market]
  );

  const scopedJournal = useMemo(
    () => journal.filter((item) => item.contextKey === contextKey(market)).slice(0, 6),
    [journal, market]
  );
  const scopedAlerts = useMemo(
    () => alerts.filter((item) => item.contextKey === contextKey(market)).slice(0, 6),
    [alerts, market]
  );

  function updateRisk(key, value) {
    setRiskInputs((prev) => ({ ...prev, [key]: Number(value) }));
  }

  function saveNote() {
    if (!note.trim()) return;
    setJournal((prev) => [
      {
        id: crypto.randomUUID?.() || `${Date.now()}`,
        contextKey: contextKey(market),
        context: snapshotContext(market),
        note: note.trim(),
        decision: decision?.finalDecision || "Unrated",
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
        Rule-based decision support only. Lensa does not connect to exchanges, execute orders, or provide financial advice.
      </div>

      <div className="glass-card decision-hero reveal">
        <MarketContextBar module="Decision Center" lastPrice={decision?.lastPrice} />
        <DataQualityGuard module="Decision Center" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
        <div className="decision-hero__main">
          <div>
            <span className="panel-subtitle">Active Market Context</span>
            <h1>{market.pair} · {market.marketType}</h1>
          </div>
          <button className="run-btn" onClick={runDecision} disabled={loading}>
            {loading ? "Analyzing..." : "Analyze Long / Short"}
          </button>
        </div>
      </div>

      {market.marketType === "Spot" && (
        <div className="source-warning reveal">
          Spot market selected: Short is directional analysis only. Lensa is not presenting an executable spot short.
        </div>
      )}
      {market.marketType !== "Spot" && (
        <div className="source-warning reveal">
          Futures framing is enabled for both Long and Short, but Lensa still does not execute trades or connect to accounts.
        </div>
      )}

      {error && <p className="news-error reveal">{error}</p>}

      {decision && (
        <>
          <TradeDecisionPanel decision={decision} precision={decision.precision} market={market} meta={dataMeta} />

          <div className="decision-grid decision-grid--setups">
            <SetupCard setup={decision.longSetup} precision={decision.precision} market={market} meta={dataMeta} />
            <SetupCard setup={decision.shortSetup} precision={decision.precision} market={market} meta={dataMeta} />
          </div>

          <RiskEnginePanel
            inputs={riskInputs}
            onChange={updateRisk}
            risk={risk}
            setup={activeSetup}
            precision={decision.precision}
            market={market}
            meta={dataMeta}
          />

          <SetupComparison decision={decision} precision={decision.precision} market={market} meta={dataMeta} />

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
  const atr = calculateATR(candles, 14) || last.close * 0.015;
  const precision = meta?.precision || market.precision;
  const qualityFactor = meta?.quality?.confidenceFactor ?? meta?.confidence ?? 1;
  const mc = monteCarlo({ closes, horizon: 48, sims: 2500, method: "bootstrap", driftMode: "zero" });

  const trendLong = fast > slow && last.close > trend;
  const trendShort = fast < slow && last.close < trend;
  const momentumLong = hist > 0 && hist > prevHist;
  const momentumShort = hist < 0 && hist < prevHist;
  const rsiLong = r > 50 && r < 74;
  const rsiShort = r < 50 && r > 26;

  const longSetup = buildSetup({
    side: "Long",
    lastPrice: last.close,
    lastCandleTime: last.time || last.timestamp || null,
    atr,
    precision,
    mc,
    qualityFactor,
    facts: {
      trendOk: trendLong,
      momentumOk: momentumLong,
      rsiOk: rsiLong,
      rsiExtreme: r >= 74,
      opposingTrend: trendShort,
      qualityWeak: qualityFactor < 0.75,
      spotShort: false,
    },
  });
  const shortSetup = buildSetup({
    side: "Short",
    lastPrice: last.close,
    atr,
    precision,
    mc,
    qualityFactor,
    facts: {
      trendOk: trendShort,
      momentumOk: momentumShort,
      rsiOk: rsiShort,
      rsiExtreme: r <= 26,
      opposingTrend: trendLong,
      qualityWeak: qualityFactor < 0.75,
      spotShort: market.marketType === "Spot",
    },
  });

  const finalDecision = chooseFinalDecision(longSetup, shortSetup, qualityFactor);
  const selected = finalDecision === "Long" ? longSetup : finalDecision === "Short" ? shortSetup : longSetup.score >= shortSetup.score ? longSetup : shortSetup;
  const riskLevel = riskLevelFrom({ atr, price: last.close, qualityFactor, selected });
  const confidence = Math.round(Math.max(longSetup.score, shortSetup.score) * qualityFactor);
  const mainReason =
    finalDecision === "No Trade"
      ? "Data quality or setup quality is not strong enough for a trade recommendation."
      : selected.reasonsFor[0] || "No dominant directional edge.";

  return {
    finalDecision,
    longScore: longSetup.score,
    shortScore: shortSetup.score,
    riskLevel,
    confidence,
    mainReason,
    conditionRequired: selected.conditionRequired,
    scenarioInvalidation: selected.invalidation,
    lastPrice: last.close,
    atr,
    precision,
    sourceLabel: meta?.sourceLabel || market.exchange,
    status: meta?.status || market.dataSourceStatus,
    longSetup,
    shortSetup,
  };
}

function buildSetup({ side, lastPrice, atr, precision, mc, qualityFactor, facts }) {
  const direction = side === "Long" ? 1 : -1;
  const entryMid = lastPrice;
  const entryLow = side === "Long" ? lastPrice - atr * 0.25 : lastPrice - atr * 0.1;
  const entryHigh = side === "Long" ? lastPrice + atr * 0.1 : lastPrice + atr * 0.25;
  const stop = lastPrice - direction * atr * 1.35;
  const target1 = lastPrice + direction * atr * 2.0;
  const target2 = lastPrice + direction * atr * 3.2;
  const invalidation = stop;
  const risk = Math.abs(entryMid - stop);
  const reward = Math.abs(target1 - entryMid);
  const rr = risk > 0 ? reward / risk : 0;
  const pTarget = mc?.error ? null : touchProbability(mc, target1, side === "Long" ? "up" : "down");
  const pStop = mc?.error ? null : touchProbability(mc, stop, side === "Long" ? "down" : "up");
  const firstTouch = mc?.error ? null : firstTouchProbabilities(mc, { target: target1, stop, side });
  const pTargetBeforeStop = firstTouch?.targetBeforeStop ?? null;
  const pStopBeforeTarget = firstTouch?.stopBeforeTarget ?? null;
  const pWin = pTargetBeforeStop ?? pTarget;
  const pLoss = pStopBeforeTarget ?? pStop;
  const ev = pWin != null && pLoss != null ? pWin * rr - pLoss : null;
  const reasonsFor = [];
  const reasonsAgainst = [];

  if (facts.trendOk) reasonsFor.push(`${side} aligns with the EMA trend structure.`);
  else reasonsAgainst.push(`${side} does not have trend alignment yet.`);
  if (facts.momentumOk) reasonsFor.push("MACD momentum supports this direction.");
  else reasonsAgainst.push("Momentum confirmation is weak or absent.");
  if (facts.rsiOk) reasonsFor.push("RSI is supportive without being extreme.");
  else reasonsAgainst.push("RSI is not in a clean confirmation zone.");
  if (rr >= 1.2) reasonsFor.push("Target 1 offers acceptable reward relative to stop distance.");
  else reasonsAgainst.push("Reward-to-risk is not attractive enough.");
  if (ev != null && ev > 0) reasonsFor.push("Monte Carlo touch probabilities produce positive expected value.");
  if (ev != null && ev <= 0) reasonsAgainst.push("Touch probabilities do not favor the setup.");
  if (facts.rsiExtreme) reasonsAgainst.push("RSI is stretched, so chasing entry is lower quality.");
  if (facts.opposingTrend) reasonsAgainst.push("The opposite trend is currently dominant.");
  if (facts.qualityWeak) reasonsAgainst.push("Data quality limits confidence in this setup.");
  if (facts.spotShort) reasonsAgainst.push("Spot market does not provide an executable short in this app.");

  const base =
    (facts.trendOk ? 25 : 0) +
    (facts.momentumOk ? 18 : 0) +
    (facts.rsiOk ? 14 : 0) +
    Math.min(18, rr * 8) +
    (ev == null ? 8 : ev > 0 ? 18 : 2);
  const penalty = (facts.rsiExtreme ? 10 : 0) + (facts.opposingTrend ? 12 : 0) + (facts.spotShort ? 22 : 0);
  const score = Math.max(0, Math.min(100, Math.round((base - penalty) * qualityFactor)));
  const status = score >= 70 ? "Accepted" : score >= 48 ? "Conditional" : "Rejected";

  return {
    side,
    entryLow,
    entryHigh,
    entryMid,
    atr,
    stop,
    target1,
    target2,
    riskReward: rr,
    expectedValue: ev,
    pTarget,
    pStop,
    pTargetBeforeStop,
    pStopBeforeTarget,
    score,
    status,
    reasonsFor,
    reasonsAgainst,
    invalidation,
    conditionRequired: conditionFor({ side, status, facts, entryLow, entryHigh, precision }),
  };
}

function chooseFinalDecision(longSetup, shortSetup, qualityFactor) {
  if (qualityFactor < 0.55) return "No Trade";
  const best = longSetup.score >= shortSetup.score ? longSetup : shortSetup;
  const other = best === longSetup ? shortSetup : longSetup;
  if (best.score < 48) return "No Trade";
  if (best.score < 70 || best.score - other.score < 12) return "Wait";
  return best.side;
}

function conditionFor({ side, status, facts, entryLow, entryHigh, precision }) {
  if (status === "Rejected") return "Wait for trend, momentum, and probability alignment before considering entry.";
  if (!facts.trendOk) return `Wait for trend confirmation before using the ${formatUsd(entryLow, precision, { mode: "trading" })} - ${formatUsd(entryHigh, precision, { mode: "trading" })} zone.`;
  if (!facts.momentumOk) return "Wait for momentum confirmation; avoid entering while MACD disagrees.";
  return `${side} is only valid inside the proposed entry zone, not after an extended chase.`;
}

function riskLevelFrom({ atr, price, qualityFactor, selected }) {
  const atrPct = price > 0 ? atr / price : 0;
  if (qualityFactor < 0.65 || selected.score < 50 || atrPct > 0.06) return "High";
  if (qualityFactor < 0.85 || selected.score < 70 || atrPct > 0.03) return "Medium";
  return "Low";
}

function calculateRiskEngine(setup, inputs, market) {
  const account = Number(inputs.accountSize) || 0;
  const riskPercent = Number(inputs.riskPercent) || 0;
  const leverage = Math.max(1, Number(inputs.leverage) || 1);
  const feePercent = Math.max(0, Number(inputs.feePercent) || 0);
  const slippagePercent = Math.max(0, Number(inputs.slippagePercent) || 0);
  const entry = setup.entryMid;
  const stop = setup.stop;
  const dollarRisk = account * (riskPercent / 100);
  const perUnitRisk = Math.abs(entry - stop);
  const units = perUnitRisk > 0 ? dollarRisk / perUnitRisk : 0;
  const notional = units * entry;
  const maxNotional = account * leverage;
  const cappedUnits = notional > maxNotional && entry > 0 ? maxNotional / entry : units;
  const positionSize = Math.min(units, cappedUnits);
  const effectiveNotional = positionSize * entry;
  const feeCost = effectiveNotional * (feePercent / 100) * 2;
  const slipCost = effectiveNotional * (slippagePercent / 100) * 2;
  const cost = feeCost + slipCost;
  const riskIfStopped = positionSize * perUnitRisk + cost;
  const reward1 = positionSize * Math.abs(setup.target1 - entry) - cost;
  const reward2 = positionSize * Math.abs(setup.target2 - entry) - cost;
  const realRR = riskIfStopped > 0 ? reward1 / riskIfStopped : 0;
  const liquidation = market.marketType === "Spot"
    ? null
    : setup.side === "Long"
      ? entry * (1 - 1 / leverage)
      : entry * (1 + 1 / leverage);
  const warnings = [];

  if (notional > maxNotional) warnings.push("Position size was capped by account size and leverage.");
  if (leverage >= 10) warnings.push("Leverage is high; liquidation risk can dominate the setup.");
  if (setup.atr && Math.abs(entry - stop) < setup.atr * 0.8) warnings.push("Stop is tight relative to recent volatility.");
  if (liquidation != null) {
    const liquidationBeforeStop = setup.side === "Long" ? liquidation > stop : liquidation < stop;
    if (liquidationBeforeStop) warnings.push("Approximate liquidation level is closer than the stop. Reduce leverage or widen margin.");
  }

  return {
    positionSize,
    riskIfStopped,
    reward1,
    reward2,
    realRR,
    liquidation,
    warnings,
  };
}

function TradeDecisionPanel({ decision, precision, market, meta }) {
  return (
    <div className={`trade-decision glass-card reveal trade-decision--${decision.finalDecision.toLowerCase().replace(/\s+/g, "-")}`}>
      <AnalysisContextMeta market={market} meta={meta} lastCandleTime={decision.lastCandleTime} />
      <div>
        <span className="decision-label">Final decision</span>
        <strong>{decision.finalDecision}</strong>
        <p>{decision.mainReason}</p>
      </div>
      <div className="decision-metrics">
        <Metric label="Long Score" value={`${decision.longScore}/100`} />
        <Metric label="Short Score" value={`${decision.shortScore}/100`} />
        <Metric label="Risk level" value={decision.riskLevel} />
        <Metric label="Confidence" value={`${decision.confidence}%`} />
        <Metric label="Condition before entry" value={decision.conditionRequired} />
        <Metric label="Scenario invalidation" value={formatUsd(decision.scenarioInvalidation, precision, { mode: "futures" })} />
      </div>
    </div>
  );
}

function SetupCard({ setup, precision, market, meta }) {
  return (
    <div className={`setup-card glass-card reveal setup-card--${setup.status.toLowerCase()}`}>
      <AnalysisContextMeta market={market} meta={meta} />
      <div className="setup-card__head">
        <h2>{setup.side} Setup</h2>
        <span>{setup.status}</span>
      </div>
      <div className="decision-metrics">
        <Metric label="Entry zone" value={`${formatUsd(setup.entryLow, precision, { mode: "trading" })} - ${formatUsd(setup.entryHigh, precision, { mode: "trading" })}`} />
        <Metric label="Stop loss" value={formatUsd(setup.stop, precision, { mode: "futures" })} />
        <Metric label="Target 1" value={formatUsd(setup.target1, precision, { mode: "futures" })} />
        <Metric label="Target 2" value={formatUsd(setup.target2, precision, { mode: "futures" })} />
        <Metric label="Risk/reward" value={`1:${formatPrice(setup.riskReward, {}, { mode: "display" })}`} />
        <Metric label="Expected value" value={setup.expectedValue == null ? "Unavailable" : formatPrice(setup.expectedValue, {}, { mode: "display" })} />
        <Metric label="P(target before stop)" value={formatProbability(setup.pTargetBeforeStop)} />
        <Metric label="P(stop before target)" value={formatProbability(setup.pStopBeforeTarget)} />
        <Metric label="Setup score" value={`${setup.score}/100`} />
        <Metric label="Invalidation" value={formatUsd(setup.invalidation, precision, { mode: "futures" })} />
      </div>
      <ReasonList title="Reasons for" items={setup.reasonsFor} />
      <ReasonList title="Reasons against" items={setup.reasonsAgainst} />
      <p className="card-hint"><strong>Condition:</strong> {setup.conditionRequired}</p>
    </div>
  );
}

function RiskEnginePanel({ inputs, onChange, risk, setup, precision, market, meta }) {
  return (
    <div className="risk-engine-panel glass-card reveal">
      <AnalysisContextMeta market={market} meta={meta} />
      <div className="panel-header">
        <div>
          <h2>Risk Engine</h2>
          <span className="panel-subtitle">Calculated for the currently favored setup: {setup?.side}</span>
        </div>
      </div>
      <div className="backtest-controls decision-risk-controls">
        <RiskInput label="Account size" value={inputs.accountSize} onChange={(v) => onChange("accountSize", v)} />
        <RiskInput label="Risk % / trade" value={inputs.riskPercent} onChange={(v) => onChange("riskPercent", v)} step="0.1" />
        <RiskInput label="Leverage" value={inputs.leverage} onChange={(v) => onChange("leverage", v)} step="0.5" />
        <RiskInput label="Fee estimate %" value={inputs.feePercent} onChange={(v) => onChange("feePercent", v)} step="0.01" />
        <RiskInput label="Slippage estimate %" value={inputs.slippagePercent} onChange={(v) => onChange("slippagePercent", v)} step="0.01" />
      </div>
      {risk && (
        <>
          <div className="decision-metrics">
            <Metric label="Position size" value={`${formatPrice(risk.positionSize, { stepSize: market.precision.stepSize }, { mode: "trading" })} units`} />
            <Metric label="Dollar risk at stop" value={formatUsd(risk.riskIfStopped)} />
            <Metric label="Reward at target 1" value={formatUsd(risk.reward1)} />
            <Metric label="Reward at target 2" value={formatUsd(risk.reward2)} />
            <Metric label="Real R:R after costs" value={`1:${formatPrice(risk.realRR, {}, { mode: "display" })}`} />
            <Metric label="Liquidation estimate" value={risk.liquidation == null ? "N/A for spot" : formatUsd(risk.liquidation, precision, { mode: "futures" })} />
          </div>
          {risk.warnings.length > 0 && (
            <ul className="risk-warning-list">
              {risk.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SetupComparison({ decision, precision, market, meta }) {
  const rows = [decision.longSetup, decision.shortSetup];
  return (
    <div className="glass-card table-card reveal">
      <AnalysisContextMeta market={market} meta={meta} lastCandleTime={decision.lastCandleTime} />
      <div className="panel-header"><h2>Setup comparison</h2></div>
      <div className="table-scroll">
        <table className="trades-table">
          <thead>
            <tr>
              <th>Side</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Target 1</th>
              <th>Target 2</th>
              <th>Score</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((setup) => (
              <tr key={setup.side}>
                <td>{setup.side}</td>
                <td className="num">{formatUsd(setup.entryMid, precision, { mode: "trading" })}</td>
                <td className="num">{formatUsd(setup.stop, precision, { mode: "futures" })}</td>
                <td className="num">{formatUsd(setup.target1, precision, { mode: "futures" })}</td>
                <td className="num">{formatUsd(setup.target2, precision, { mode: "futures" })}</td>
                <td className="num">{setup.score}/100</td>
                <td>{setup.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnalysisContextMeta({ market, meta, lastCandleTime }) {
  const candleTime = lastCandleTime || market.lastValidCandleTime;
  const source = meta?.sourceLabel || market.dataSourceStatus?.source || market.exchange;
  const quality = meta?.quality?.status || market.dataQualityStatus?.status || meta?.status || "Waiting";
  return (
    <div className="analysis-context-meta">
      <span>{market.pair}</span>
      <span>{market.marketType}</span>
      <span>{market.timeframe}</span>
      <span>{source}</span>
      <span>{quality}</span>
      <span>{candleTime ? new Date(candleTime * 1000).toLocaleString() : "No candle yet"}</span>
    </div>
  );
}

function RiskInput({ label, value, onChange, step = "1" }) {
  return (
    <div className="control-group">
      <label>{label}</label>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ReasonList({ title, items }) {
  return (
    <div className="reason-list">
      <strong>{title}</strong>
      <ul>
        {(items.length ? items : ["No major reason recorded."]).map((item) => <li key={item}>{item}</li>)}
      </ul>
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

function formatProbability(value) {
  return value == null ? "Unavailable" : `${Math.round(value * 100)}%`;
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
