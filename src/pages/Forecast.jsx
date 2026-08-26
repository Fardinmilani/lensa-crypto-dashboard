import { useEffect, useRef, useState } from "react";
import { monteCarlo, tradeSetups, annualizedVol, probabilityPriceMap, SCENARIO_CONSENSUS_STEPS } from "../lib/forecast";
import { monteCarloPortfolioStress } from "../lib/stress";
import { estimateVolatility } from "../lib/portfolio";
import { coinIdFromPair, getChartCandles } from "../lib/coingecko";
import { formatUsd } from "../lib/priceFormat";
import ConeChart from "../components/ConeChart";
import ReportActions from "../components/ReportActions";
import TimeframePicker from "../components/TimeframePicker";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import { checkForecastAnchor, qualityMetaFromError } from "../lib/dataQuality";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import InfoTip from "../components/InfoTip";

function pct(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

const PRECISION = [
  { key: "fast", sims: 1000 },
  { key: "balanced", sims: 3000 },
  { key: "precise", sims: 8000 },
];

// A probabilistic path simulation still needs a finite sampling window, but
// exposing it as an exact candle countdown implies timing precision the model
// does not have. Broad scenario windows preserve the required math without
// presenting "the move should happen in N candles" as a signal.
const SCENARIO_WINDOWS = [
  { key: "short", periods: SCENARIO_CONSENSUS_STEPS[0] },
  { key: "medium", periods: SCENARIO_CONSENSUS_STEPS[1] },
  { key: "long", periods: SCENARIO_CONSENSUS_STEPS[2] },
];

export default function Forecast() {
  const { coin } = useCoin();
  const { market, setTimeframe, updateFromCandles } = useMarket();
  const { t } = useI18n();
  const [scenarioWindow, setScenarioWindow] = useLocalStorageState("lensa.forecast.window", "medium");
  const [method, setMethod] = useLocalStorageState("lensa.forecast.method", "bootstrap");
  const [blockSize, setBlockSize] = useLocalStorageState("lensa.forecast.blockSize", 5);
  const [driftMode, setDriftMode] = useLocalStorageState("lensa.forecast.drift", "historical");
  const [sims, setSims] = useLocalStorageState("lensa.forecast.sims", 3000);
  const [bands, setBands] = useLocalStorageState("lensa.forecast.bands", "inner");
  const [watchlist] = useLocalStorageState("lensa.decision.watchlist", ["BTCUSDT", "ETHUSDT", "XRPUSDT"]);
  const [mc, setMc] = useState(null);
  const [extra, setExtra] = useState(null);
  const [portfolioMc, setPortfolioMc] = useState(null);
  const [portfolioMcLoading, setPortfolioMcLoading] = useState(false);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reveal = useStaggerReveal([mc, error]);
  const windowConfig = SCENARIO_WINDOWS.find((item) => item.key === scenarioWindow) || SCENARIO_WINDOWS[1];
  const horizon = windowConfig.periods;

  // Monotonically increasing run id: only the LATEST run may commit state.
  // Without this, a slow candle fetch kicked off before a re-run (or before
  // switching coin/timeframe) could resolve late and overwrite the newer
  // result with stale data. Bumped on unmount so nothing commits after it.
  const runIdRef = useRef(0);
  useEffect(() => () => { runIdRef.current += 1; }, []);

  async function handleRun() {
    const runId = ++runIdRef.current;
    const isCurrent = () => runIdRef.current === runId;
    setLoading(true);
    setError(null);
    try {
      const candles = await getChartCandles({
        id: coin.id,
        symbol: coin.symbol,
        timeframe: market.timeframe,
        source: market.exchange,
        pair: market.pair,
        marketType: market.marketType,
      });
      if (!isCurrent()) return;
      if (candles.length < 20) throw new Error(t("fc.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      const closes = candles.map((c) => c.close);
      const stepSeconds = Math.max(1, candles[1].time - candles[0].time);
      const sim = monteCarlo({ closes, horizon, sims, method, driftMode, blockSize: Number(blockSize) });
      if (sim.error) throw new Error(sim.error);
      const periodsPerYear = (365 * 86400) / stepSeconds;
      const histTail = candles.slice(-Math.min(candles.length, Math.max(40, horizon)));
      // Everything path-derived (setups, probability map) is computed here,
      // so the raw per-path matrix (sims × horizon numbers — several MB at
      // the "precise" setting) doesn't need to live in React state.
      const simSummary = { ...sim };
      delete simSummary.paths;
      setMc(simSummary);
      setExtra({
        setups: tradeSetups(sim),
        probabilityMap: probabilityPriceMap(sim),
        annVol: annualizedVol(closes, periodsPerYear),
        stepSeconds,
        history: histTail.map((c) => ({ time: c.time, value: c.close })),
      });
    } catch (err) {
      if (!isCurrent()) return;
      setError(err.message);
      setMc(null);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  async function handlePortfolioMc() {
    setPortfolioMcLoading(true);
    try {
      const symbols = [market.pair, ...watchlist.filter((s) => s !== market.pair)].slice(0, 6);
      const weights = {};
      const vols = {};
      const means = {};
      const share = symbols.length ? 100 / symbols.length : 0;
      for (const sym of symbols) {
        weights[sym] = share;
        const candles = await getChartCandles({
          id: coinIdFromPair(sym, coin.id),
          symbol: sym.replace(/USDT$/i, ""),
          timeframe: market.timeframe,
          source: market.exchange,
          pair: sym,
          marketType: market.marketType,
        });
        vols[sym] = estimateVolatility(candles.map((c) => c.close), 30) * 100;
        const closes = candles.map((c) => c.close);
        means[sym] = closes.length > 2 ? ((closes.at(-1) / closes[0]) - 1) * 100 : 0;
      }
      setPortfolioMc(monteCarloPortfolioStress({ weights, meanReturns: means, vols, sims: 500, horizon: 30 }));
    } catch (err) {
      setError(err.message);
    } finally {
      setPortfolioMcLoading(false);
    }
  }

  const report =
    mc && extra
      ? {
          type: "forecast",
          generatedAt: new Date().toISOString(),
          marketContext: market,
          scenarioWindow: windowConfig.key,
          method,
          blockSize: method === "blockBootstrap" ? Number(blockSize) : undefined,
          driftMode,
          sims,
          summary: {
            probabilityOfProfit: mc.probProfit,
            expectedReturnPct: mc.expectedReturnPct,
            downsideP5Pct: mc.var5Pct,
            upsideP95Pct: mc.upside95Pct,
            annualizedVolatility: extra.annVol,
          },
          probabilityMap: extra.probabilityMap,
          setups: extra.setups,
          distribution: mc.dist,
          cone: mc.cone,
        }
      : null;

  return (
    <div className="forecast-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("fc.disclaimer")}</div>
      <MarketContextBar lastPrice={mc?.current} />
      <DataQualityGuard module={t("dq.module.scenario")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />

      <div className="backtest-controls glass-card reveal">
        <div className="control-group control-group--wide">
          <label>{t("common.activeCoin")}</label>
          <div className="active-coin-chip">
            {coin.thumb && <img src={coin.thumb} alt="" width="18" height="18" />}
            <strong>{coin.symbol}</strong>
            <span>{coin.name}</span>
          </div>
        </div>
        <div className="control-group">
          <label>{t("fc.window")}</label>
          <select value={windowConfig.key} onChange={(e) => setScenarioWindow(e.target.value)}>
            {SCENARIO_WINDOWS.map((item) => (
              <option key={item.key} value={item.key}>{t(`fc.window.${item.key}`)}</option>
            ))}
          </select>
          <small className="control-hint">{t("fc.window.hint")}</small>
        </div>
        <div className="control-group">
          <label>
            {t("fc.method")}
            <InfoTip term={method === "gbm" ? "glossary.forecastGbm" : method === "blockBootstrap" ? "glossary.forecastBlockBootstrap" : "glossary.forecastBootstrap"} />
          </label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="bootstrap">{t("fc.method.bootstrap")}</option>
            <option value="blockBootstrap">{t("fc.method.blockBootstrap")}</option>
            <option value="gbm">{t("fc.method.gbm")}</option>
          </select>
        </div>
        {method === "blockBootstrap" && (
          <div className="control-group">
            <label>{t("fc.blockSize")}</label>
            <input type="number" min="2" max="60" value={blockSize} onChange={(e) => setBlockSize(e.target.value)} />
            <small className="control-hint">{t("fc.blockSize.hint")}</small>
          </div>
        )}
        <div className="control-group">
          <label>
            {t("fc.drift")}
            <InfoTip term="glossary.forecastDrift" />
          </label>
          <select value={driftMode} onChange={(e) => setDriftMode(e.target.value)}>
            <option value="historical">{t("fc.drift.historical")}</option>
            <option value="zero">{t("fc.drift.zero")}</option>
          </select>
        </div>
        <div className="control-group">
          <label>{t("fc.precision")}</label>
          <select value={sims} onChange={(e) => setSims(Number(e.target.value))}>
            {PRECISION.map((p) => (
              <option key={p.sims} value={p.sims}>
                {t(`fc.precision.${p.key}`)} ({t("fc.paths", { n: p.sims.toLocaleString("en-US") })})
              </option>
            ))}
          </select>
        </div>
        <div className="control-group control-group--full">
          <label>{t("fc.dataRange")}</label>
          <TimeframePicker value={market.timeframe} onChange={setTimeframe} />
        </div>
        <button className="run-btn" onClick={handleRun} disabled={loading}>
          {loading ? t("fc.running") : t("fc.run")}
        </button>
      </div>

      {error && <p className="news-error reveal">{t(error)}</p>}

      <div className="guide-card glass-card reveal">
        <h2>{t("fc.guide.title")}</h2>
        <p>{t("fc.guide.body")}</p>
      </div>

      {mc && extra && (
        <>
          <ReportActions report={report} type="forecast" symbol={coin.symbol} allowSave={false} />
          <div className="forecast-hl">
            <HlCard label={t("fc.hl.median")} value={mc.medianReturnPct} suffix="%" decimals={0} tone={mc.medianReturnPct >= 0 ? "up" : "down"} hint={formatUsd(mc.dist.p50, market.precision, { mode: "futures" })} tip="glossary.medianScenario" />
            <HlCard label={t("fc.hl.prob")} value={mc.probAboveCurrent * 100} suffix="%" decimals={0} tone={mc.probAboveCurrent >= 0.5 ? "up" : "down"} hint={t("fc.hl.probHint")} tip="glossary.probAbove" />
            <HlCard label={t("fc.hl.upside")} value={mc.upside95Pct} suffix="%" decimals={0} tone="up" hint={formatUsd(mc.dist.p95, market.precision, { mode: "futures" })} tip="glossary.p95" />
            <HlCard label={t("fc.hl.downside")} value={mc.var5Pct} suffix="%" decimals={0} tone="down" hint={formatUsd(mc.dist.p5, market.precision, { mode: "futures" })} tip="glossary.p5" />
            <HlCard label={t("fc.hl.vol")} value={extra.annVol} suffix="%" decimals={0} hint={t("fc.hl.volHint")} tip="glossary.annualizedVol" />
          </div>

          <div className="glass-card probability-card reveal">
            <div className="panel-header"><h2>{t("fc.prob.title")}</h2></div>
            <div className="probability-grid">
              {extra.probabilityMap.map((item) => (
                <div className="probability-item" key={item.key}>
                  <strong className="num">{formatUsd(item.price, market.precision, { mode: "futures" })}</strong>
                  <span>{t(`fc.prob.${item.side}`, { p: item.probability, price: formatUsd(item.price, market.precision, { mode: "futures" }) })}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card chart-card reveal">
            <DataQualityGuard module={t("dq.module.cone")} meta={dataMeta} analysisMarket={analysisMarket} forecastAnchor={checkForecastAnchor({ history: extra.history, cone: mc.cone, stepSeconds: extra.stepSeconds })} />
            <div className="panel-header panel-header--wrap">
              <div>
                <h2>{t("fc.cone")}</h2>
                <span className="panel-subtitle">{t("fc.coneSub")}</span>
              </div>
              <div className="band-toggle" role="group" aria-label={t("fc.bands.label")}>
                {["median", "inner", "full"].map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`band-toggle__btn ${bands === b ? "active" : ""}`}
                    onClick={() => setBands(b)}
                  >
                    {t(`fc.bands.${b}`)}
                  </button>
                ))}
              </div>
            </div>
            <ConeChart history={extra.history} cone={mc.cone} stepSeconds={extra.stepSeconds} precision={market.precision} bands={bands} />
            <div className="cone-legend">
              <span><i className="cone-legend__swatch cone-legend__swatch--hist" />{t("fc.legend.history")}</span>
              <span><i className="cone-legend__swatch cone-legend__swatch--median" />{t("fc.legend.median")}</span>
              {bands !== "median" && <span><i className="cone-legend__swatch cone-legend__swatch--inner" />{t("fc.legend.inner")}</span>}
              {bands === "full" && <span><i className="cone-legend__swatch cone-legend__swatch--outer" />{t("fc.legend.outer")}</span>}
            </div>
            <div className="scenario-summary">
              <p className="scenario-summary__lead">{t("fc.summary.lead", {
                median: formatUsd(mc.dist.p50, market.precision, { mode: "futures" }),
              })}</p>
              <ul className="scenario-summary__list">
                <li><span>{t("fc.summary.down")}</span><strong className="num down">{formatUsd(mc.dist.p5, market.precision, { mode: "futures" })}</strong></li>
                <li><span>{t("fc.summary.up")}</span><strong className="num up">{formatUsd(mc.dist.p95, market.precision, { mode: "futures" })}</strong></li>
                <li><span>{t("fc.summary.prob")}</span><strong className="num">{Math.round(mc.probAboveCurrent * 100)}%</strong></li>
              </ul>
              <p className="scenario-summary__note">{t("fc.summary.note")}</p>
            </div>
          </div>

          <div className="forecast-cols forecast-cols--single">
            <div className="glass-card reveal">
              <DataQualityGuard module={t("dq.module.longShort")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
              <div className="panel-header">
                <div>
                  <h2>{t("fc.setups")}</h2>
                  <span className="panel-subtitle">{t("fc.setupsSub")}</span>
                </div>
              </div>
              <div className="table-scroll">
                <table className="trades-table setups-table">
                  <thead>
                    <tr>
                      <th>{t("fc.col.target")}</th>
                      <th>{t("fc.col.stop")}</th>
                      <th>{t("fc.col.rr")}</th>
                      <th>{t("fc.col.ptarget")}</th>
                      <th>{t("fc.col.pstop")}</th>
                      <th>{t("fc.col.ev")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extra.setups.map((s, i) => (
                      <tr key={i}>
                        <td className="num up" data-label={t("fc.col.target")}>{formatUsd(s.target, market.precision, { mode: "futures" })}<br /><small>{pct(s.targetPct)}</small></td>
                        <td className="num down" data-label={t("fc.col.stop")}>{formatUsd(s.stop, market.precision, { mode: "futures" })}<br /><small>{pct(s.stopPct)}</small></td>
                        <td className="num" data-label={t("fc.col.rr")}><strong>1:{s.rr?.toFixed(2)}</strong></td>
                        <td className="num up" data-label={t("fc.col.ptarget")}>{(s.pTarget * 100).toFixed(0)}%</td>
                        <td className="num down" data-label={t("fc.col.pstop")}>{(s.pStop * 100).toFixed(0)}%</td>
                        <td className={`num ${(s.ev ?? 0) >= 0 ? "up" : "down"}`} data-label={t("fc.col.ev")}>{s.ev?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="card-hint">{t("fc.evNote")}</p>
            </div>

            <div className="glass-card reveal">
              <div className="panel-header panel-header--wrap">
                <div>
                  <h2>{t("fc.portfolioMc.title")}</h2>
                  <span className="panel-subtitle">{t("fc.portfolioMc.hint")}</span>
                </div>
                <button type="button" className="run-btn run-btn--ghost" disabled={portfolioMcLoading} onClick={handlePortfolioMc}>
                  {portfolioMcLoading ? t("analytics.loading") : t("fc.portfolioMc.run")}
                </button>
              </div>
              {portfolioMc && (
                <ul className="scenario-summary__list">
                  <li><span>{t("fc.portfolioMc.probLoss")}</span><strong className="num">{Math.round(portfolioMc.probLoss * 100)}%</strong></li>
                  <li><span>{t("fc.portfolioMc.p5")}</span><strong className="num down">{portfolioMc.p5.toFixed(1)}%</strong></li>
                  <li><span>{t("fc.portfolioMc.p50")}</span><strong className="num">{portfolioMc.p50.toFixed(1)}%</strong></li>
                  <li><span>{t("fc.portfolioMc.p95")}</span><strong className="num up">{portfolioMc.p95.toFixed(1)}%</strong></li>
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function snapshotMarket(market) {
  return {
    exchange: market.exchange,
    pair: market.pair,
    marketType: market.marketType,
    timeframe: market.timeframe,
  };
}

function HlCard({ label, value, suffix = "", decimals = 1, tone = "", hint, tip }) {
  const animated = useCountUp(Number.isFinite(value) ? value : 0, { decimals });
  return (
    <div className="hl-card glass-card reveal">
      <span className="hl-card__label">
        {label}
        {tip ? <InfoTip term={tip} /> : null}
      </span>
      <span className={`hl-card__value num ${tone}`}>
        {animated.toFixed(decimals)}{suffix}
      </span>
      {hint && <span className="hl-card__hint num">{hint}</span>}
    </div>
  );
}
