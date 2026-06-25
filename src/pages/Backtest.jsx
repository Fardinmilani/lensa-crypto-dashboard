import { useState } from "react";
import { STRATEGIES, PARAM_LABELS } from "../lib/strategies";
import { runBacktest, runAllStrategies } from "../lib/backtest";
import { getChartCandles } from "../lib/coingecko";
import { formatUsd } from "../lib/priceFormat";
import { qualityMetaFromError } from "../lib/dataQuality";
import EquityChart from "../components/EquityChart";
import ReportActions from "../components/ReportActions";
import TimeframePicker from "../components/TimeframePicker";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n, pick } from "../i18n/langStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const CATEGORY_ORDER = ["trend", "momentum", "reversion", "hybrid"];

export default function Backtest() {
  const { coin } = useCoin();
  const { market, setTimeframe, updateFromCandles } = useMarket();
  const { t, lang } = useI18n();
  const locale = lang === "fa" ? "fa-IR" : "en-US";
  const [strategyKey, setStrategyKey] = useLocalStorageState("lensa.backtest.strategy", "trendMomentumHybrid");
  const [params, setParams] = useLocalStorageState("lensa.backtest.params", STRATEGIES.trendMomentumHybrid.params);
  const [fee, setFee] = useLocalStorageState("lensa.backtest.fee", 0.1);
  const [result, setResult] = useState(null);
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [aggregate, setAggregate] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState(null);
  const reveal = useStaggerReveal([result, aggregate, error]);
  const strategy = STRATEGIES[strategyKey];

  function handleStrategyChange(key) {
    setStrategyKey(key);
    setParams(STRATEGIES[key].params);
    setResult(null);
  }

  async function handleRun() {
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
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      const signals = strategy.generateSignals(candles, params);
      const strategyResult = runBacktest({ candles, signals, feePercent: Number(fee) });
      const benchmark = runBacktest({
        candles,
        signals: STRATEGIES.buyAndHold.generateSignals(candles),
        feePercent: Number(fee),
      });
      setResult(strategyResult);
      setBenchmarkResult(benchmark);
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleRunAll() {
    setLoadingAll(true);
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
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      setAggregate(runAllStrategies({ candles, strategies: STRATEGIES, feePercent: Number(fee) }));
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoadingAll(false);
    }
  }

  function handleInspectStrategy(key) {
    handleStrategyChange(key);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: Object.entries(STRATEGIES).filter(([, s]) => s.category === cat),
  }));
  const report =
    result && benchmarkResult
      ? {
          type: "backtest",
          generatedAt: new Date().toISOString(),
          marketContext: market,
          strategy: strategyKey,
          strategyLabel: pick(lang, strategy.label),
          params,
          fee,
          result,
          benchmark: benchmarkResult,
        }
      : null;

  return (
    <div className="backtest-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("bt.disclaimer")}</div>
      <MarketContextBar module="Backtest" />
      <DataQualityGuard module="Backtest" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />

      <div className="backtest-controls glass-card reveal">
        <div className="control-group control-group--wide">
          <label>{t("common.activeCoin")}</label>
          <div className="active-coin-chip">
            {coin.thumb && <img src={coin.thumb} alt="" width="18" height="18" />}
            <strong>{coin.symbol}</strong>
            <span>{coin.name}</span>
          </div>
        </div>
        <div className="control-group control-group--wide">
          <label>{t("bt.strategy")}</label>
          <select value={strategyKey} onChange={(e) => handleStrategyChange(e.target.value)}>
            {grouped.map((g) => (
              <optgroup key={g.cat} label={t(`cat.${g.cat}`)}>
                {g.items.map(([key, s]) => <option key={key} value={key}>{pick(lang, s.label)}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label>{t("bt.fee")}</label>
          <input type="number" step="0.05" value={fee} onChange={(e) => setFee(e.target.value)} />
        </div>
        {Object.entries(params).map(([name, value]) => (
          <div className="control-group" key={name}>
            <label>{pick(lang, PARAM_LABELS[name]) || name}</label>
            <input type="number" value={value} onChange={(e) => setParams((prev) => ({ ...prev, [name]: Number(e.target.value) }))} />
          </div>
        ))}
        <div className="control-group control-group--full">
          <label>{t("bt.timeframe")}</label>
          <TimeframePicker value={market.timeframe} onChange={setTimeframe} />
        </div>
        <button className="run-btn" onClick={handleRun} disabled={loading || loadingAll}>
          {loading ? t("bt.running") : t("bt.run")}
        </button>
        <button className="run-btn run-btn--ghost" onClick={handleRunAll} disabled={loading || loadingAll}>
          {loadingAll ? t("bt.runningAll") : t("bt.runAll")}
        </button>
      </div>

      <div className="guide-card glass-card reveal">
        <h2>{t("bt.guide.title")}</h2>
        <p>{t("bt.guide.body")}</p>
        <p>{t("bt.guide.metrics")}</p>
      </div>
      <p className="strategy-description reveal">{pick(lang, strategy.description)}</p>
      {error && <p className="news-error reveal">{error}</p>}

      {result && (
        <div className="backtest-results">
          <ReportActions report={report} type="backtest" symbol={coin.symbol} />
          <div className="stats-grid">
            <Stat label={t("bt.stat.return")} value={result.totalReturnPercent} suffix="%" tone={result.totalReturnPercent >= 0 ? "up" : "down"} />
            <Stat label={t("bt.stat.bench")} value={result.benchmarkReturnPercent} suffix="%" tone={result.benchmarkReturnPercent >= 0 ? "up" : "down"} />
            <Stat label={t("bt.stat.dd")} value={result.maxDrawdownPercent} suffix="%" tone="down" prefix="-" abs />
            <Stat label={t("bt.stat.winrate")} value={result.winRate} suffix="%" decimals={0} />
            <Stat label={t("bt.stat.sharpe")} value={result.sharpe} decimals={2} tone={result.sharpe >= 1 ? "up" : ""} />
            <Stat label={t("bt.stat.sortino")} value={result.sortino} decimals={2} />
            <Stat label={t("bt.stat.pf")} value={isFinite(result.profitFactor) ? result.profitFactor : null} decimals={2} fallback={result.profitFactor === Infinity ? "∞" : "-"} />
            <Stat label={t("bt.stat.expectancy")} value={result.expectancy} suffix="%" decimals={2} tone={(result.expectancy ?? 0) >= 0 ? "up" : "down"} />
            <Stat label={t("bt.stat.avgwin")} value={result.avgWin} suffix="%" decimals={2} tone="up" />
            <Stat label={t("bt.stat.avgloss")} value={result.avgLoss} suffix="%" decimals={2} tone="down" />
            <Stat label={t("bt.stat.trades")} value={result.tradeCount} decimals={0} />
            <Stat label={t("bt.stat.exposure")} value={result.exposurePercent} suffix="%" decimals={0} />
          </div>
          <div className="glass-card chart-card">
            <MarketContextBar module="Backtest equity" />
            <DataQualityGuard module="Backtest equity" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
            <div className="panel-header"><h2>{t("bt.equity")}</h2></div>
            <p className="section-note">{t("bt.equity.note")}</p>
            <EquityChart equityCurve={result.equityCurve} benchmarkCurve={benchmarkResult?.equityCurve} />
          </div>
          {result.trades.length > 0 && (
            <div className="glass-card table-card">
              <MarketContextBar module="Backtest trades" />
              <DataQualityGuard module="Backtest trades" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
              <div className="panel-header"><h2>{t("bt.trades", { n: result.tradeCount })}</h2></div>
              <p className="section-note">{t("bt.trades.note")}</p>
              <div className="table-scroll">
                <table className="trades-table">
                  <thead>
                    <tr>
                      <th>{t("bt.col.entry")}</th>
                      <th>{t("bt.col.exit")}</th>
                      <th>{t("bt.col.entryPrice")}</th>
                      <th>{t("bt.col.exitPrice")}</th>
                      <th>{t("bt.col.pnl")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((tr, i) => (
                      <tr key={i}>
                        <td className="num">{new Date(tr.entryTime * 1000).toLocaleDateString(locale)}</td>
                        <td className="num">{new Date(tr.exitTime * 1000).toLocaleDateString(locale)}</td>
                        <td className="num">{formatUsd(tr.entryPrice, market.precision, { mode: "trading" })}</td>
                        <td className="num">{formatUsd(tr.exitPrice, market.precision, { mode: "trading" })}</td>
                        <td className={`num ${tr.pnlPercent >= 0 ? "up" : "down"}`}>{tr.pnlPercent >= 0 ? "+" : ""}{tr.pnlPercent.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {aggregate && (
        <AggregateResults
          aggregate={aggregate}
          t={t}
          lang={lang}
          dataMeta={dataMeta}
          analysisMarket={analysisMarket}
          market={market}
          onInspect={handleInspectStrategy}
        />
      )}
    </div>
  );
}

function AggregateResults({ aggregate, t, lang, dataMeta, analysisMarket, market, onInspect }) {
  const { rows, summary } = aggregate;
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
  const signed = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "-");

  return (
    <div className="aggregate-results reveal">
      <div className="glass-card chart-card">
        <MarketContextBar module="Backtest all strategies" />
        <DataQualityGuard module="Backtest all strategies" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
        <div className="panel-header"><h2>{t("bt.agg.title")}</h2></div>
        <p className="section-note">{t("bt.agg.subtitle", { n: summary.count })}</p>

        <div className="agg-kpi-grid">
          <div className="agg-kpi agg-kpi--accent">
            <span className="agg-kpi__label">{t("bt.agg.best")}</span>
            <strong className="agg-kpi__value">{summary.best ? pick(lang, summary.best.label) : "-"}</strong>
            <span className={`agg-kpi__sub ${summary.best && summary.best.result.totalReturnPercent >= 0 ? "up" : "down"}`}>
              {summary.best ? `${signed(summary.best.result.totalReturnPercent)}%` : ""}
            </span>
          </div>
          <div className="agg-kpi">
            <span className="agg-kpi__label">{t("bt.agg.bestSharpe")}</span>
            <strong className="agg-kpi__value">{summary.bestBySharpe ? pick(lang, summary.bestBySharpe.label) : "-"}</strong>
            <span className="agg-kpi__sub">{summary.bestBySharpe ? `${t("bt.stat.sharpe")} ${fmt(summary.bestBySharpe.result.sharpe, 2)}` : ""}</span>
          </div>
          <div className="agg-kpi">
            <span className="agg-kpi__label">{t("bt.agg.bench")}</span>
            <strong className={`agg-kpi__value num ${summary.benchmarkReturn >= 0 ? "up" : "down"}`}>{signed(summary.benchmarkReturn)}%</strong>
            <span className="agg-kpi__sub">{t("bt.agg.beat", { n: summary.beatsBenchmark, total: summary.count })}</span>
          </div>
          <div className="agg-kpi">
            <span className="agg-kpi__label">{t("bt.agg.profitable")}</span>
            <strong className="agg-kpi__value num">{summary.profitable}/{summary.count}</strong>
            <span className="agg-kpi__sub">{t("bt.agg.avgReturn")}: <span className={summary.avgReturn >= 0 ? "up" : "down"}>{signed(summary.avgReturn)}%</span></span>
          </div>
        </div>
      </div>

      <div className="glass-card table-card">
        <div className="panel-header"><h2>{t("bt.agg.tableTitle")}</h2></div>
        <p className="section-note">{t("bt.agg.hint")}</p>
        <div className="table-scroll">
          <table className="trades-table agg-table">
            <thead>
              <tr>
                <th>{t("bt.agg.col.rank")}</th>
                <th className="agg-table__name">{t("bt.agg.col.strategy")}</th>
                <th>{t("bt.stat.return")}</th>
                <th>{t("bt.agg.col.excess")}</th>
                <th>{t("bt.stat.dd")}</th>
                <th>{t("bt.stat.winrate")}</th>
                <th>{t("bt.stat.sharpe")}</th>
                <th>{t("bt.stat.pf")}</th>
                <th>{t("bt.stat.trades")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.key} className="agg-row" onClick={() => onInspect(row.key)} title={t("bt.agg.hint")}>
                  <td className="num agg-table__rank">{i + 1}</td>
                  <td className="agg-table__name">
                    <span className="agg-name">{pick(lang, row.label)}</span>
                    <small>{t(`cat.${row.category}`)}</small>
                  </td>
                  <td className={`num ${row.result.totalReturnPercent >= 0 ? "up" : "down"}`}>{signed(row.result.totalReturnPercent)}%</td>
                  <td className={`num ${row.excessReturn >= 0 ? "up" : "down"}`}>{signed(row.excessReturn)}%</td>
                  <td className="num down">-{fmt(row.result.maxDrawdownPercent)}%</td>
                  <td className="num">{Number.isFinite(row.result.winRate) ? `${fmt(row.result.winRate, 0)}%` : "-"}</td>
                  <td className={`num ${Number.isFinite(row.result.sharpe) && row.result.sharpe >= 1 ? "up" : ""}`}>{fmt(row.result.sharpe, 2)}</td>
                  <td className="num">{row.result.profitFactor === Infinity ? "∞" : fmt(row.result.profitFactor, 2)}</td>
                  <td className="num">{row.result.tradeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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

function Stat({ label, value, suffix = "", prefix = "", decimals = 1, tone = "", abs = false, fallback = "-" }) {
  const animated = useCountUp(Number.isFinite(value) ? (abs ? Math.abs(value) : value) : 0, { decimals });
  const display = Number.isFinite(value) ? `${prefix}${animated.toFixed(decimals)}${suffix}` : fallback;
  return (
    <div className="stat-card reveal">
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${tone}`}>{display}</span>
    </div>
  );
}
