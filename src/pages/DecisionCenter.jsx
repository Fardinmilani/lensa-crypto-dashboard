import { useEffect, useMemo, useRef, useState } from "react";
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
const WATCH_CACHE_MS = 60_000;
const JOURNAL_STORE = "paperTrades";
const DB_NAME = "lensa-decision-center";
const DB_VERSION = 1;

function openTradeDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        db.createObjectStore(JOURNAL_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local trade journal database."));
  });
}

async function putPaperTrade(trade) {
  try {
    const db = await openTradeDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_STORE, "readwrite");
      tx.objectStore(JOURNAL_STORE).put(trade);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* IndexedDB may be unavailable in private or locked-down contexts; the trade is simply not persisted. */
  }
}

async function loadPaperTrades() {
  try {
    const db = await openTradeDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_STORE, "readonly");
      const request = tx.objectStore(JOURNAL_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    return [];
  }
}

async function deletePaperTrade(id) {
  try {
    const db = await openTradeDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_STORE, "readwrite");
      tx.objectStore(JOURNAL_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* nothing to clean up if the store never opened */
  }
}

async function setPaperTradeOutcome(id, outcome) {
  try {
    const db = await openTradeDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(JOURNAL_STORE, "readwrite");
      const store = tx.objectStore(JOURNAL_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (record) store.put({ ...record, outcome });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* outcome update is best-effort only */
  }
}

function paperTradesCsv(trades, precision) {
  const headers = ["id", "createdAt", "symbol", "marketType", "timeframe", "direction", "entry", "stop", "target1", "target2", "reason", "score", "outcome"];
  const rows = trades.map((trade) =>
    headers
      .map((key) => {
        const raw = key === "entry" || key === "stop" || key === "target1" || key === "target2"
          ? formatPrice(trade[key], precision, { mode: "trading" })
          : trade[key];
        const value = raw == null ? "" : String(raw).replace(/"/g, '""');
        return /[",\n]/.test(value) ? `"${value}"` : value;
      })
      .join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

function sortWatchRows(rows, sort) {
  const copy = [...rows];
  if (sort === "short") return copy.sort((a, b) => (b.shortScore || 0) - (a.shortScore || 0));
  if (sort === "risk") return copy.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  return copy.sort((a, b) => (b.longScore || 0) - (a.longScore || 0));
}

function evaluateBrowserAlert(alert, decision, market) {
  if (!alert || alert.status === "Triggered while app was open") return null;
  if (alert.contextKey && alert.contextKey !== contextKey(market)) return null;
  const price = decision?.lastPrice;
  if (price == null) return null;

  if (alert.type === "score") {
    const best = Math.max(decision.longScore || 0, decision.shortScore || 0);
    if (best >= Number(alert.score)) return { id: alert.id, reason: `Score crossed ${alert.score}` };
    return null;
  }
  if (alert.type === "rr") {
    const bestRR = Math.max(decision.longSetup?.riskReward || 0, decision.shortSetup?.riskReward || 0);
    if (bestRR >= Number(alert.rr)) return { id: alert.id, reason: `Risk/reward reached 1:${alert.rr}` };
    return null;
  }
  if (alert.type === "drawing") {
    const level = Number(alert.level);
    if (!Number.isFinite(level)) return null;
    if (Math.abs(price - level) <= (decision.atr || price * 0.002) * 0.15) {
      return { id: alert.id, reason: "Price touched the saved drawing level" };
    }
    return null;
  }
  const level = Number(alert.level ?? alert.price);
  if (!Number.isFinite(level)) return null;
  if ((alert.lastSeenPrice != null && alert.lastSeenPrice < level && price >= level) ||
      (alert.lastSeenPrice != null && alert.lastSeenPrice > level && price <= level)) {
    return { id: alert.id, reason: `Price crossed ${level}` };
  }
  return null;
}

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
  const [watchlist, setWatchlist] = useLocalStorageState("lensa.decision.watchlist", ["BTCUSDT", "ETHUSDT", "XRPUSDT", "DOGEUSDT"]);
  const [watchSymbol, setWatchSymbol] = useState("");
  const [watchSort, setWatchSort] = useState("long");
  const [watchResults, setWatchResults] = useState([]);
  const [watchLoading, setWatchLoading] = useState(false);
  const [paperTrades, setPaperTrades] = useState([]);
  const [alertDraft, setAlertDraft] = useState({ type: "price", level: "", score: 70, rr: 2 });
  const [note, setNote] = useState("");
  const [alertPrice, setAlertPrice] = useState("");
  const watchCache = useRef(new Map());
  const reveal = useStaggerReveal([decision, error]);

  useEffect(() => {
    loadPaperTrades().then(setPaperTrades);
  }, []);

  useEffect(() => {
    if (!decision || !alerts.length) return;
    const hits = new Map();
    for (const item of alerts) {
      const hit = evaluateBrowserAlert(item, decision, market);
      if (hit) hits.set(hit.id, hit);
    }
    setAlerts((prev) =>
      prev.map((item) => {
        if (item.contextKey && item.contextKey !== contextKey(market)) return item;
        const hit = hits.get(item.id);
        if (hit) {
          return { ...item, status: "Triggered while app was open", triggerReason: hit.reason, triggeredAt: new Date().toISOString() };
        }
        if (item.status === "Triggered while app was open") return item;
        return { ...item, lastSeenPrice: decision.lastPrice };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.lastPrice]);

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
        type: "price",
        level: price,
        lastSeenPrice: decision?.lastPrice ?? null,
        createdAt: new Date().toISOString(),
        status: "Active while app is open",
      },
      ...prev,
    ]);
    setAlertPrice("");
  }

  async function scanWatchlist() {
    setWatchLoading(true);
    const rows = [];
    for (const symbol of watchlist.slice(0, 12)) {
      const cacheKey = `${market.exchange}|${market.marketType}|${symbol}|${market.timeframe}`;
      const cached = watchCache.current.get(cacheKey);
      if (cached && Date.now() - cached.time < WATCH_CACHE_MS) {
        rows.push(cached.row);
        continue;
      }
      try {
        const candles = await getChartCandles({
          id: market.coin.id,
          symbol,
          timeframe: market.timeframe,
          source: market.exchange,
          pair: symbol,
          marketType: market.marketType,
        });
        const rowDecision = analyzeDecision(candles, candles.meta, { ...market, pair: symbol, symbol: symbol.replace(/USDT$/i, "") });
        const row = {
          symbol,
          price: candles.at(-1)?.close,
          longScore: rowDecision.longScore,
          shortScore: rowDecision.shortScore,
          trend: rowDecision.tests.trend.summary,
          volatility: rowDecision.tests.volatility.summary,
          dataQuality: rowDecision.dataQualityScore,
          source: candles.meta?.status || "Limited",
          riskScore: rowDecision.riskScore,
          precision: candles.meta?.precision || market.precision,
        };
        watchCache.current.set(cacheKey, { time: Date.now(), row });
        rows.push(row);
      } catch (err) {
        rows.push({ symbol, error: err.message, source: "Failed", dataQuality: 20, longScore: 0, shortScore: 0, riskScore: 100, precision: market.precision });
      }
    }
    setWatchResults(rows);
    setWatchLoading(false);
  }

  function addWatchSymbol() {
    const clean = watchSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!clean) return;
    setWatchlist((prev) => [...new Set([...prev, clean.endsWith("USDT") ? clean : `${clean}USDT`])].slice(0, 20));
    setWatchSymbol("");
  }

  async function savePaperTrade(setup = activeSetup) {
    if (!setup || !decision) return;
    const trade = {
      id: crypto.randomUUID?.() || `${Date.now()}`,
      createdAt: new Date().toISOString(),
      context: snapshotContext(market),
      symbol: market.pair,
      marketType: market.marketType,
      timeframe: market.timeframe,
      direction: setup.side,
      entry: setup.entryMid,
      stop: setup.stop,
      target1: setup.target1,
      target2: setup.target2,
      reason: decision.mainReason,
      score: setup.score,
      outcome: "Open",
      precision: decision.precision,
    };
    await putPaperTrade(trade);
    setPaperTrades(await loadPaperTrades());
  }

  async function importPaperTrades(file) {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.trades || [];
    for (const trade of rows) await putPaperTrade({ ...trade, id: trade.id || `${Date.now()}-${Math.random()}` });
    setPaperTrades(await loadPaperTrades());
  }

  async function removePaperTrade(id) {
    await deletePaperTrade(id);
    setPaperTrades(await loadPaperTrades());
  }

  async function markPaperTrade(id, outcome) {
    await setPaperTradeOutcome(id, outcome);
    setPaperTrades(await loadPaperTrades());
  }

  function exportPaperTrades(format) {
    const data = paperTrades.filter((item) => item.context?.pair === market.pair || item.symbol === market.pair);
    const blob = new Blob([format === "csv" ? paperTradesCsv(data, market.precision) : JSON.stringify(data, null, 2)], { type: format === "csv" ? "text/csv" : "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lensa-paper-trades-${market.pair}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function saveDecisionAlert() {
    const alert = {
      id: crypto.randomUUID?.() || `${Date.now()}`,
      contextKey: contextKey(market),
      context: snapshotContext(market),
      type: alertDraft.type,
      level: Number(alertDraft.level || alertPrice || decision?.lastPrice),
      lastSeenPrice: decision?.lastPrice ?? null,
      score: Number(alertDraft.score),
      rr: Number(alertDraft.rr),
      createdAt: new Date().toISOString(),
      status: "Active while app is open",
    };
    setAlerts((prev) => [alert, ...prev]);
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
          <DecisionTestsPanel decision={decision} />
          <SimulationCards cards={decision.simulationCards} />
          <BacktestSummary backtest={decision.backtest} precision={decision.precision} />

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

          <WatchlistScreener
            watchlist={watchlist}
            watchSymbol={watchSymbol}
            setWatchSymbol={setWatchSymbol}
            addWatchSymbol={addWatchSymbol}
            removeSymbol={(symbol) => setWatchlist((prev) => prev.filter((item) => item !== symbol))}
            scanWatchlist={scanWatchlist}
            watchLoading={watchLoading}
            rows={sortWatchRows(watchResults, watchSort)}
            sort={watchSort}
            setSort={setWatchSort}
            precision={market.precision}
          />

          <div className="decision-grid">
            <PaperTradePanel
              note={note}
              setNote={setNote}
              saveNote={saveNote}
              scopedJournal={scopedJournal}
              savePaperTrade={() => savePaperTrade(activeSetup)}
              paperTrades={paperTrades}
              market={market}
              precision={decision.precision}
              exportPaperTrades={exportPaperTrades}
              importPaperTrades={importPaperTrades}
              removePaperTrade={removePaperTrade}
              markPaperTrade={markPaperTrade}
            />
            <BrowserAlertsPanel
              alertPrice={alertPrice}
              setAlertPrice={setAlertPrice}
              saveAlert={saveAlert}
              alertDraft={alertDraft}
              setAlertDraft={setAlertDraft}
              saveDecisionAlert={saveDecisionAlert}
              scopedAlerts={scopedAlerts}
              market={market}
              precision={decision.precision}
              removeAlert={(id) => setAlerts((prev) => prev.filter((item) => item.id !== id))}
            />
          </div>
        </>
      )}
    </div>
  );
}

function analyzeDecision(candles, meta, market) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
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
  const backtest = lightweightBacktest(candles, { feePercent: 0.08, slippagePercent: 0.05 });
  const avgVolume = mean(volumes.slice(-30));
  const currentVolume = volumes.at(-1) || 0;
  const atrPct = last.close > 0 ? atr / last.close : 0;
  const higherFrame = approximateHigherFrame(candles, 4);
  const higherCloses = higherFrame.map((c) => c.close);
  const hFast = ema(higherCloses, 9).at(-1);
  const hSlow = ema(higherCloses, 21).at(-1);

  const trendLong = fast > slow && last.close > trend;
  const trendShort = fast < slow && last.close < trend;
  const momentumLong = hist > 0 && hist > prevHist;
  const momentumShort = hist < 0 && hist < prevHist;
  const rsiLong = r > 50 && r < 74;
  const rsiShort = r < 50 && r > 26;
  const volumeSupports = currentVolume > avgVolume * 1.05;
  const volumeFades = currentVolume < avgVolume * 0.7;
  const mtfLong = hFast > hSlow;
  const mtfShort = hFast < hSlow;

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
      volumeOk: volumeSupports,
      mtfOk: mtfLong,
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
      volumeOk: volumeSupports,
      mtfOk: mtfShort,
      spotShort: market.marketType === "Spot",
    },
  });

  const finalDecision = chooseFinalDecision(longSetup, shortSetup, qualityFactor);
  const selected = finalDecision === "Long" ? longSetup : finalDecision === "Short" ? shortSetup : longSetup.score >= shortSetup.score ? longSetup : shortSetup;
  const tests = buildTestSuite({
    trendLong, trendShort, momentumLong, momentumShort, r, hist, prevHist,
    atrPct, volumeSupports, volumeFades, currentVolume, avgVolume, mtfLong, mtfShort,
    mc, backtest, qualityFactor, meta, longSetup, shortSetup,
  });
  const dataQualityScore = Math.round(Math.max(0, Math.min(100, qualityFactor * 100)));
  const riskScore = riskScoreFrom({ atrPct, selected, qualityFactor, backtest });
  const riskLevel = riskLevelFrom({ atr, price: last.close, qualityFactor, selected });
  const confidence = aggregateConfidence({ longSetup, shortSetup, tests, qualityFactor, backtest });
  const mainReason =
    finalDecision === "No Trade"
      ? "Data quality or setup quality is not strong enough for a trade recommendation."
      : selected.reasonsFor[0] || "No dominant directional edge.";
  const simulationCards = buildSimulationCards(mc, precision);
  const mainReasons = aggregateReasons({ tests, selected, finalDecision });

  return {
    finalDecision,
    longScore: longSetup.score,
    shortScore: shortSetup.score,
    riskScore,
    dataQualityScore,
    riskLevel,
    confidence,
    mainReason,
    mainReasons,
    changeDecision: whatWouldChangeDecision({ finalDecision, longSetup, shortSetup, tests }),
    conditionRequired: selected.conditionRequired,
    scenarioInvalidation: selected.invalidation,
    lastPrice: last.close,
    lastCandleTime: last.time,
    atr,
    precision,
    tests,
    mc,
    simulationCards,
    backtest,
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
  if (facts.mtfOk) reasonsFor.push("Higher-timeframe structure confirms the setup direction.");
  else reasonsAgainst.push("Higher-timeframe confirmation is missing.");
  if (facts.volumeOk) reasonsFor.push("Recent volume supports active participation.");
  else reasonsAgainst.push("Volume behavior is not confirming the move.");
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
    (facts.mtfOk ? 12 : 0) +
    (facts.volumeOk ? 7 : 0) +
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

function buildTestSuite({ trendLong, trendShort, momentumLong, momentumShort, r, hist, prevHist, atrPct, volumeSupports, volumeFades, currentVolume, avgVolume, mtfLong, mtfShort, mc, backtest, qualityFactor, meta, longSetup, shortSetup }) {
  return {
    trend: {
      score: trendLong ? 75 : trendShort ? 25 : 50,
      summary: trendLong ? "Bullish EMA structure" : trendShort ? "Bearish EMA structure" : "Mixed trend",
      impact: trendLong ? "Favors Long." : trendShort ? "Favors Short." : "Supports waiting.",
    },
    momentum: {
      score: momentumLong ? 72 : momentumShort ? 28 : 50,
      summary: `RSI ${Math.round(r)} with MACD histogram ${hist > prevHist ? "improving" : "weakening"}`,
      impact: momentumLong ? "Momentum adds Long confirmation." : momentumShort ? "Momentum adds Short confirmation." : "Momentum is not decisive.",
    },
    volatility: {
      score: atrPct < 0.018 ? 72 : atrPct < 0.045 ? 52 : 28,
      summary: atrPct < 0.018 ? "Calm volatility" : atrPct < 0.045 ? "Elevated volatility" : "High volatility",
      impact: atrPct > 0.045 ? "Position sizing should be reduced or skipped." : "Volatility is usable for structured risk.",
    },
    volume: {
      score: volumeSupports ? 70 : volumeFades ? 30 : 50,
      summary: volumeSupports ? "Volume is above recent average" : volumeFades ? "Volume is fading" : "Volume is neutral",
      impact: volumeSupports ? "Breakout/follow-through evidence improves." : "Conviction is weaker without volume.",
      detail: `${Math.round(currentVolume)} vs avg ${Math.round(avgVolume || 0)}`,
    },
    multiTimeframe: {
      score: mtfLong ? 70 : mtfShort ? 30 : 50,
      summary: mtfLong ? "Higher timeframe leans bullish" : mtfShort ? "Higher timeframe leans bearish" : "Higher timeframe mixed",
      impact: mtfLong ? "Long setups get confirmation." : mtfShort ? "Short setups get confirmation." : "No extra confirmation.",
    },
    monteCarlo: {
      score: mc?.error ? 35 : Math.round((mc.probProfit || 0.5) * 100),
      summary: mc?.error ? "Simulation unavailable" : `Positive close probability ${Math.round(mc.probProfit * 100)}%`,
      impact: mc?.error ? "Confidence is reduced." : mc.probProfit > 0.58 ? "Simulation supports upside." : mc.probProfit < 0.42 ? "Simulation warns about downside." : "Simulation is not strong enough by itself.",
    },
    backtest: {
      score: backtest.tradeCount < 8 ? 45 : backtest.profitFactor > 1.25 ? 68 : backtest.profitFactor < 0.9 ? 32 : 50,
      summary: `${backtest.tradeCount} trades, ${Math.round(backtest.winRate || 0)}% win rate`,
      impact: backtest.reliabilityWarning || (backtest.profitFactor > 1 ? "Historical rule is supportive." : "Historical rule is not supportive."),
    },
    riskReward: {
      score: Math.round(Math.max(longSetup.riskReward, shortSetup.riskReward) * 35),
      summary: `Best R:R 1:${formatPrice(Math.max(longSetup.riskReward, shortSetup.riskReward), {}, { mode: "display" })}`,
      impact: Math.max(longSetup.riskReward, shortSetup.riskReward) >= 1.4 ? "Reward is acceptable for consideration." : "Reward is too thin for a strong decision.",
    },
    expectedValue: {
      score: Math.round(Math.max(0, Math.min(100, ((Math.max(longSetup.expectedValue ?? -1, shortSetup.expectedValue ?? -1) + 1) / 2) * 100))),
      summary: `Best EV ${formatPrice(Math.max(longSetup.expectedValue ?? 0, shortSetup.expectedValue ?? 0), {}, { mode: "display" })}`,
      impact: Math.max(longSetup.expectedValue ?? -1, shortSetup.expectedValue ?? -1) > 0 ? "Probability-adjusted payoff is positive." : "Probability-adjusted payoff is not convincing.",
    },
    dataQuality: {
      score: Math.round(qualityFactor * 100),
      summary: meta?.quality?.status || meta?.status || "Limited",
      impact: qualityFactor < 0.75 ? "Decision confidence is capped by data quality." : "Data quality is acceptable.",
    },
  };
}

function buildSimulationCards(mc, precision) {
  if (!mc || mc.error) {
    return [{ label: "Simulation unavailable", number: "N/A", explanation: mc?.error || "Monte Carlo could not run.", impact: "The Decision Center lowers confidence and avoids a strong recommendation." }];
  }
  const profitPct = Math.round(mc.probProfit * 100);
  return [
    {
      label: "Positive close probability",
      number: `${profitPct}%`,
      explanation: `Around ${profitPct} out of 100 simulated paths ended positive over the selected horizon.`,
      impact: profitPct >= 58 ? "This supports a Long bias, but still needs trend and risk confirmation." : profitPct <= 42 ? "This weakens Long entries and favors caution or Short analysis." : "This is not strong enough by itself to justify entry.",
    },
    {
      label: "Pessimistic scenario",
      number: formatUsd(mc.dist.p5, precision, { mode: "futures" }),
      explanation: `Only about 5 out of 100 simulated paths closed below this level.`,
      impact: "Use this as a downside stress level, not as a guaranteed stop.",
    },
    {
      label: "Median simulated close",
      number: formatUsd(mc.dist.p50, precision, { mode: "futures" }),
      explanation: "Half of simulated paths closed above this price and half below it.",
      impact: mc.dist.p50 > mc.current ? "The median path leans mildly constructive." : "The median path does not support chasing upside.",
    },
    {
      label: "Optimistic scenario",
      number: formatUsd(mc.dist.p95, precision, { mode: "futures" }),
      explanation: `Only about 5 out of 100 simulated paths closed above this level.`,
      impact: "This helps judge whether targets are realistic for the current horizon.",
    },
  ];
}

function aggregateReasons({ tests, selected, finalDecision }) {
  const reasons = [selected.reasonsFor[0], tests.trend.impact, tests.momentum.impact, tests.dataQuality.impact].filter(Boolean);
  if (finalDecision === "Wait") reasons.unshift("Long and Short scores are not separated enough for a clean trade.");
  if (finalDecision === "No Trade") reasons.unshift("The combined evidence is too weak or too unreliable.");
  return [...new Set(reasons)].slice(0, 6);
}

function whatWouldChangeDecision({ finalDecision, longSetup, shortSetup, tests }) {
  if (finalDecision === "Long") return "A momentum rollover, loss of higher-timeframe confirmation, or price moving through the Long invalidation level would downgrade the decision.";
  if (finalDecision === "Short") return "A bullish trend reclaim, improving volume into upside, or price moving through the Short invalidation level would downgrade the decision.";
  const better = longSetup.score >= shortSetup.score ? "Long" : "Short";
  return `A cleaner ${better} decision needs stronger trend/momentum alignment, better expected value, and data quality above ${tests.dataQuality.score < 75 ? "75%" : "the current level"}.`;
}

function aggregateConfidence({ longSetup, shortSetup, tests, qualityFactor, backtest }) {
  const edge = Math.abs(longSetup.score - shortSetup.score);
  const testAvg = mean(Object.values(tests).map((test) => test.score));
  const samplePenalty = backtest.tradeCount < 8 ? 10 : 0;
  return Math.round(Math.max(0, Math.min(100, (testAvg * 0.45 + Math.max(longSetup.score, shortSetup.score) * 0.45 + edge * 0.25) * qualityFactor - samplePenalty)));
}

function riskScoreFrom({ atrPct, selected, qualityFactor, backtest }) {
  let score = 30;
  if (atrPct > 0.03) score += 20;
  if (atrPct > 0.06) score += 20;
  if (selected.score < 55) score += 15;
  if (qualityFactor < 0.75) score += 15;
  if (backtest.maxDrawdown > 12) score += 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function lightweightBacktest(candles, { feePercent = 0.08, slippagePercent = 0.05 } = {}) {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const trades = [];
  let open = null;
  let losingStreak = 0;
  let worstLosingStreak = 0;
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  for (let i = 22; i < candles.length; i++) {
    const bullish = fast[i] > slow[i];
    const bearish = fast[i] < slow[i];
    if (!open && bullish) open = { entry: candles[i].close * (1 + slippagePercent / 100), time: candles[i].time };
    if (open && bearish) {
      const exit = candles[i].close * (1 - slippagePercent / 100);
      const r = ((exit - open.entry) / open.entry) * 100 - feePercent * 2;
      trades.push({ entryTime: open.time, exitTime: candles[i].time, entryPrice: open.entry, exitPrice: exit, r });
      equity *= 1 + r / 100;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
      losingStreak = r <= 0 ? losingStreak + 1 : 0;
      worstLosingStreak = Math.max(worstLosingStreak, losingStreak);
      open = null;
    }
  }
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((sum, t) => sum + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.r, 0));
  return {
    trades,
    tradeCount: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    maxDrawdown,
    averageR: trades.length ? mean(trades.map((t) => t.r)) / 100 : 0,
    worstLosingStreak,
    reliabilityWarning: trades.length < 8 ? "Low sample size: backtest is not statistically reliable." : "",
  };
}

function approximateHigherFrame(candles, groupSize = 4) {
  const out = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize);
    if (!group.length) continue;
    out.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1).close,
      volume: group.reduce((sum, c) => sum + (c.volume || 0), 0),
    });
  }
  return out;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
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
        <Metric label="Risk score" value={`${decision.riskScore}/100`} />
        <Metric label="Data quality" value={`${decision.dataQualityScore}/100`} />
        <Metric label="Risk level" value={decision.riskLevel} />
        <Metric label="Confidence" value={`${decision.confidence}%`} />
        <Metric label="Condition before entry" value={decision.conditionRequired} />
        <Metric label="Scenario invalidation" value={formatUsd(decision.scenarioInvalidation, precision, { mode: "futures" })} />
      </div>
      <ReasonList title="Main reasons" items={decision.mainReasons} />
      <p className="card-hint"><strong>What would change it:</strong> {decision.changeDecision}</p>
    </div>
  );
}

function DecisionTestsPanel({ decision }) {
  return (
    <div className="glass-card decision-analysis-card reveal">
      <div className="panel-header"><h2>Aggregated tests</h2><span className="panel-subtitle">One decision from all available front-end checks</span></div>
      <div className="decision-test-grid">
        {Object.entries(decision.tests).map(([key, test]) => (
          <div className="decision-test" key={key}>
            <span>{labelize(key)}</span>
            <strong>{test.score}/100</strong>
            <p>{test.summary}</p>
            <small>{test.impact}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimulationCards({ cards }) {
  return (
    <div className="decision-grid decision-grid--sim reveal">
      {cards.map((card) => (
        <div className="simulation-card glass-card" key={card.label}>
          <span>{card.label}</span>
          <strong className="num">{card.number}</strong>
          <p>{card.explanation}</p>
          <small>{card.impact}</small>
        </div>
      ))}
    </div>
  );
}

function BacktestSummary({ backtest, precision }) {
  const lastTrades = backtest.trades.slice(-5).reverse();
  return (
    <div className="glass-card table-card reveal">
      <div className="panel-header">
        <h2>Lightweight backtest</h2>
        <span className="panel-subtitle">EMA 9/21 rule over fetched candles, with fee and slippage included</span>
      </div>
      {backtest.reliabilityWarning && <div className="source-warning">{backtest.reliabilityWarning}</div>}
      <div className="decision-metrics">
        <Metric label="Trade count" value={backtest.tradeCount} />
        <Metric label="Win rate" value={`${Math.round(backtest.winRate)}%`} />
        <Metric label="Profit factor" value={Number.isFinite(backtest.profitFactor) ? formatPrice(backtest.profitFactor, {}, { mode: "display" }) : "Infinite"} />
        <Metric label="Max drawdown" value={`${formatPrice(backtest.maxDrawdown, {}, { mode: "display" })}%`} />
        <Metric label="Average R" value={formatPrice(backtest.averageR, {}, { mode: "display" })} />
        <Metric label="Worst losing streak" value={backtest.worstLosingStreak} />
      </div>
      <div className="table-scroll">
        <table className="trades-table">
          <thead><tr><th>Entry</th><th>Exit</th><th>Result</th></tr></thead>
          <tbody>
            {lastTrades.map((trade) => (
              <tr key={`${trade.entryTime}-${trade.exitTime}`}>
                <td className="num">{formatUsd(trade.entryPrice, precision, { mode: "trading" })}</td>
                <td className="num">{formatUsd(trade.exitPrice, precision, { mode: "trading" })}</td>
                <td className={`num ${trade.r >= 0 ? "up" : "down"}`}>{formatPrice(trade.r, {}, { mode: "display" })}%</td>
              </tr>
            ))}
            {!lastTrades.length && <tr><td colSpan="3">No completed trades in the fetched range.</td></tr>}
          </tbody>
        </table>
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

function WatchlistScreener({ watchlist, watchSymbol, setWatchSymbol, addWatchSymbol, removeSymbol, scanWatchlist, watchLoading, rows, sort, setSort, precision }) {
  return (
    <div className="glass-card table-card reveal watchlist-panel">
      <div className="panel-header">
        <div>
          <h2>Watchlist / Screener</h2>
          <span className="panel-subtitle">Long Score, Short Score, trend, volatility, and data quality, computed per symbol with cached results</span>
        </div>
        <button className="run-btn run-btn--ghost" onClick={scanWatchlist} disabled={watchLoading}>
          {watchLoading ? "Scanning..." : "Scan watchlist"}
        </button>
      </div>

      <div className="backtest-controls watchlist-controls">
        <div className="control-group control-group--wide">
          <label>Add symbol</label>
          <input
            placeholder="e.g. SOL"
            value={watchSymbol}
            onChange={(e) => setWatchSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addWatchSymbol()}
          />
        </div>
        <button className="run-btn run-btn--ghost" onClick={addWatchSymbol}>Add</button>
        <div className="control-group">
          <label>Sort by</label>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="long">Best Long setups</option>
            <option value="short">Best Short setups</option>
            <option value="risk">Highest risk</option>
          </select>
        </div>
      </div>

      <div className="watchlist-chips">
        {watchlist.map((symbol) => (
          <span className="watchlist-chip" key={symbol}>
            {symbol}
            <button onClick={() => removeSymbol(symbol)} aria-label={`Remove ${symbol}`}>×</button>
          </span>
        ))}
        {!watchlist.length && <span className="card-hint">No symbols yet. Add one above.</span>}
      </div>

      <div className="table-scroll">
        <table className="trades-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Price</th>
              <th>Long</th>
              <th>Short</th>
              <th>Trend</th>
              <th>Volatility</th>
              <th>Data quality</th>
              <th>Risk</th>
              <th>Source health</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.symbol} className={row.error ? "watch-row--degraded" : ""}>
                <td>{row.symbol}</td>
                <td className="num">{row.error ? "Unavailable" : formatUsd(row.price, row.precision || precision, { mode: "trading" })}</td>
                <td className="num">{row.error ? "-" : `${row.longScore}/100`}</td>
                <td className="num">{row.error ? "-" : `${row.shortScore}/100`}</td>
                <td>{row.error ? "-" : row.trend}</td>
                <td>{row.error ? "-" : row.volatility}</td>
                <td className="num">{row.error ? "-" : `${row.dataQuality}/100`}</td>
                <td className="num">{row.error ? "-" : `${row.riskScore}/100`}</td>
                <td className={row.error ? "watch-source watch-source--failed" : "watch-source"}>{row.error ? `Failed: ${row.error}` : row.source}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan="9">Scan the watchlist to compute Long/Short scores per symbol.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="card-hint">Results are cached for about a minute per symbol/timeframe to avoid excessive API requests; rescanning within that window reuses cached data.</p>
    </div>
  );
}

function PaperTradePanel({ note, setNote, saveNote, scopedJournal, savePaperTrade, paperTrades, market, precision, exportPaperTrades, importPaperTrades, removePaperTrade, markPaperTrade }) {
  const symbolTrades = paperTrades.filter((item) => item.symbol === market.pair).slice(0, 8);
  return (
    <div className="local-panel glass-card reveal">
      <MarketContextBar module="Trading Journal" />
      <h2>Trading Journal / Paper Trade</h2>
      <p className="card-hint">Paper trades are stored locally in this browser's IndexedDB. Nothing is sent to a server and no real orders are placed.</p>

      <button className="run-btn run-btn--ghost" onClick={savePaperTrade}>Save current setup as paper trade</button>

      <div className="local-item-list">
        {symbolTrades.map((trade) => (
          <div className="local-item paper-trade-item" key={trade.id}>
            <div className="paper-trade-item__head">
              <strong>{trade.direction} · {trade.symbol}</strong>
              <span>{trade.outcome}</span>
            </div>
            <span>{new Date(trade.createdAt).toLocaleString()} · {trade.timeframe} · {trade.marketType}</span>
            <p>
              Entry {formatUsd(trade.entry, precision, { mode: "trading" })} · Stop {formatUsd(trade.stop, precision, { mode: "futures" })} · T1 {formatUsd(trade.target1, precision, { mode: "futures" })} · T2 {formatUsd(trade.target2, precision, { mode: "futures" })} · Score {trade.score}/100
            </p>
            {trade.reason && <p className="card-hint">{trade.reason}</p>}
            <div className="paper-trade-item__actions">
              <button onClick={() => markPaperTrade(trade.id, "Win")}>Mark win</button>
              <button onClick={() => markPaperTrade(trade.id, "Loss")}>Mark loss</button>
              <button onClick={() => markPaperTrade(trade.id, "Open")}>Mark open</button>
              <button className="danger" onClick={() => removePaperTrade(trade.id)}>Delete</button>
            </div>
          </div>
        ))}
        {!symbolTrades.length && <p className="card-hint">No paper trades saved yet for {market.pair}.</p>}
      </div>

      <div className="journal-export-row">
        <button onClick={() => exportPaperTrades("json")}>Export JSON</button>
        <button onClick={() => exportPaperTrades("csv")}>Export CSV</button>
        <label className="import-label">
          Import JSON
          <input type="file" accept="application/json" onChange={(e) => importPaperTrades(e.target.files?.[0])} />
        </label>
      </div>

      <h2 className="journal-subheading">Quick notes</h2>
      <textarea
        placeholder="Write a quick journal note about this setup or market read..."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button onClick={saveNote}>Save note</button>
      {scopedJournal.map((item) => (
        <div className="local-item" key={item.id}>
          <strong>{item.decision}</strong>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
          <p>{item.note}</p>
        </div>
      ))}
    </div>
  );
}

function BrowserAlertsPanel({ alertPrice, setAlertPrice, saveAlert, alertDraft, setAlertDraft, saveDecisionAlert, scopedAlerts, market, precision, removeAlert }) {
  return (
    <div className="local-panel glass-card reveal">
      <MarketContextBar module="In-browser Alerts" />
      <h2>In-browser Alerts</h2>
      <p className="card-hint"><strong>Alerts only work while the app is open in this browser tab.</strong> Closing the tab or losing connectivity stops all checks; nothing is monitored on a server.</p>

      <div className="backtest-controls">
        <div className="control-group">
          <label>Alert type</label>
          <select value={alertDraft.type} onChange={(e) => setAlertDraft((prev) => ({ ...prev, type: e.target.value }))}>
            <option value="price">Price crosses level</option>
            <option value="drawing">Price touches drawing</option>
            <option value="score">Long/Short score crosses threshold</option>
            <option value="rr">Risk/reward reaches target</option>
          </select>
        </div>
        {(alertDraft.type === "price" || alertDraft.type === "drawing") && (
          <div className="control-group">
            <label>{alertDraft.type === "price" ? "Price level" : "Drawing price level"}</label>
            <input
              type="number"
              placeholder={market.pair}
              value={alertDraft.level}
              onChange={(e) => setAlertDraft((prev) => ({ ...prev, level: e.target.value }))}
            />
          </div>
        )}
        {alertDraft.type === "score" && (
          <div className="control-group">
            <label>Score threshold</label>
            <input type="number" value={alertDraft.score} onChange={(e) => setAlertDraft((prev) => ({ ...prev, score: e.target.value }))} />
          </div>
        )}
        {alertDraft.type === "rr" && (
          <div className="control-group">
            <label>Risk/reward target</label>
            <input type="number" step="0.1" value={alertDraft.rr} onChange={(e) => setAlertDraft((prev) => ({ ...prev, rr: e.target.value }))} />
          </div>
        )}
        <button className="run-btn run-btn--ghost" onClick={saveDecisionAlert}>Add alert</button>
      </div>

      <div className="control-group control-group--full quick-price-alert">
        <label>Quick price-cross alert</label>
        <div className="quick-price-alert__row">
          <input type="number" placeholder="Price level" value={alertPrice} onChange={(e) => setAlertPrice(e.target.value)} />
          <button onClick={saveAlert}>Add</button>
        </div>
      </div>

      {scopedAlerts.map((alert) => (
        <div className={`local-item alert-item ${alert.status === "Triggered while app was open" ? "alert-item--triggered" : ""}`} key={alert.id}>
          <strong>{labelize(alert.type || "price")}</strong>
          <span>
            {alert.type === "score" ? `Threshold ${alert.score}/100` :
              alert.type === "rr" ? `Target 1:${alert.rr}` :
                `Level ${formatUsd(alert.level ?? alert.price, precision, { mode: "trading" })}`}
            {" · "}{new Date(alert.createdAt).toLocaleString()}
          </span>
          <p>{alert.triggerReason || alert.status}</p>
          <div className="paper-trade-item__actions">
            <button className="danger" onClick={() => removeAlert(alert.id)}>Remove</button>
          </div>
        </div>
      ))}
      {!scopedAlerts.length && <p className="card-hint">No alerts saved yet for {market.pair}.</p>}
    </div>
  );
}

function labelize(key) {
  const labels = {
    price: "Price crosses level",
    drawing: "Price touches drawing",
    score: "Score threshold",
    rr: "Risk/reward target",
    trend: "Trend analysis",
    momentum: "Momentum analysis",
    volatility: "Volatility regime",
    volume: "Volume behavior",
    multiTimeframe: "Multi-timeframe confirmation",
    monteCarlo: "Monte Carlo simulation",
    backtest: "Backtest result",
    riskReward: "Risk/reward quality",
    expectedValue: "Expected value",
    dataQuality: "Data quality",
  };
  if (labels[key]) return labels[key];
  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
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
