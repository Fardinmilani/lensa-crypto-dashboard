import { useState } from "react";
import { getChartCandles } from "../lib/coingecko";
import { monteCarlo, tradeSetups, annualizedVol, probabilityPriceMap } from "../lib/forecast";
import { formatUsd } from "../lib/priceFormat";
import ConeChart from "../components/ConeChart";
import ReportActions from "../components/ReportActions";
import TimeframePicker from "../components/TimeframePicker";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import { checkForecastAnchor, qualityMetaFromError, readableDuration } from "../lib/dataQuality";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

function pct(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

const PRECISION = [
  { key: "fast", sims: 1000 },
  { key: "balanced", sims: 3000 },
  { key: "precise", sims: 8000 },
];

export default function Forecast() {
  const { coin } = useCoin();
  const { market, setTimeframe, updateFromCandles } = useMarket();
  const { t } = useI18n();
  const [horizon, setHorizon] = useLocalStorageState("lensa.forecast.horizon", 30);
  const [method, setMethod] = useLocalStorageState("lensa.forecast.method", "bootstrap");
  const [driftMode, setDriftMode] = useLocalStorageState("lensa.forecast.drift", "historical");
  const [sims, setSims] = useLocalStorageState("lensa.forecast.sims", 3000);
  const [mc, setMc] = useState(null);
  const [extra, setExtra] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reveal = useStaggerReveal([mc, error]);

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
      if (candles.length < 20) throw new Error(t("fc.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      const closes = candles.map((c) => c.close);
      const stepSeconds = Math.max(1, candles[1].time - candles[0].time);
      const sim = monteCarlo({ closes, horizon: Number(horizon), sims, method, driftMode });
      if (sim.error) throw new Error(sim.error);
      const periodsPerYear = (365 * 86400) / stepSeconds;
      const histTail = candles.slice(-Math.min(candles.length, Math.max(40, horizon)));
      setMc(sim);
      setExtra({
        setups: tradeSetups(sim),
        probabilityMap: probabilityPriceMap(sim),
        annVol: annualizedVol(closes, periodsPerYear),
        stepSeconds,
        history: histTail.map((c) => ({ time: c.time, value: c.close })),
        horizonLabel: readableDuration(Number(horizon) * stepSeconds),
      });
    } catch (err) {
      setError(err.message);
      setMc(null);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoading(false);
    }
  }

  const report =
    mc && extra
      ? {
          type: "forecast",
          generatedAt: new Date().toISOString(),
          marketContext: market,
          horizon,
          method,
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
      <MarketContextBar module="Prediction + Monte Carlo" lastPrice={mc?.current} />
      <DataQualityGuard module="Prediction + Monte Carlo" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />

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
          <label>{t("fc.horizon")}</label>
          <input type="number" min="5" max="365" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
        </div>
        <div className="control-group">
          <label>{t("fc.method")}</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="bootstrap">{t("fc.method.bootstrap")}</option>
            <option value="gbm">{t("fc.method.gbm")}</option>
          </select>
        </div>
        <div className="control-group">
          <label>{t("fc.drift")}</label>
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

      {error && <p className="news-error reveal">{error}</p>}

      <div className="guide-card glass-card reveal">
        <h2>{t("fc.guide.title")}</h2>
        <p>{t("fc.guide.body")}</p>
      </div>

      {mc && extra && (
        <>
          <ReportActions report={report} type="forecast" symbol={coin.symbol} allowSave={false} />
          <div className="forecast-hl">
            <HlCard label={t("fc.hl.prob")} value={mc.probProfit * 100} suffix="%" decimals={0} tone={mc.probProfit >= 0.5 ? "up" : "down"} hint={t("fc.hl.probHint", { n: extra.horizonLabel })} />
            <HlCard label={t("fc.hl.expected")} value={mc.expectedReturnPct} suffix="%" decimals={1} tone={mc.expectedReturnPct >= 0 ? "up" : "down"} hint={t("fc.hl.expectedHint")} />
            <HlCard label={t("fc.hl.upside")} value={mc.upside95Pct} suffix="%" decimals={1} tone="up" hint={formatUsd(mc.dist.p95, market.precision, { mode: "futures" })} />
            <HlCard label={t("fc.hl.downside")} value={mc.var5Pct} suffix="%" decimals={1} tone="down" hint={formatUsd(mc.dist.p5, market.precision, { mode: "futures" })} />
            <HlCard label={t("fc.hl.vol")} value={extra.annVol} suffix="%" decimals={0} hint={t("fc.hl.volHint")} />
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
            <MarketContextBar module="Monte Carlo chart" lastPrice={mc.current} />
            <DataQualityGuard module="Monte Carlo chart" meta={dataMeta} analysisMarket={analysisMarket} forecastAnchor={checkForecastAnchor({ history: extra.history, cone: mc.cone, stepSeconds: extra.stepSeconds })} />
            <div className="panel-header">
              <div>
                <h2>{t("fc.cone")}</h2>
                <span className="panel-subtitle">{t("fc.coneSub")}</span>
              </div>
            </div>
            <ConeChart history={extra.history} cone={mc.cone} stepSeconds={extra.stepSeconds} precision={market.precision} />
          </div>

          <div className="forecast-cols forecast-cols--single">
            <div className="glass-card reveal">
              <MarketContextBar module="Long/Short analysis" lastPrice={mc.current} />
              <DataQualityGuard module="Long/Short analysis" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
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
                        <td className="num up">{formatUsd(s.target, market.precision, { mode: "futures" })}<br /><small>{pct(s.targetPct)}</small></td>
                        <td className="num down">{formatUsd(s.stop, market.precision, { mode: "futures" })}<br /><small>{pct(s.stopPct)}</small></td>
                        <td className="num"><strong>1:{s.rr?.toFixed(2)}</strong></td>
                        <td className="num up">{(s.pTarget * 100).toFixed(0)}%</td>
                        <td className="num down">{(s.pStop * 100).toFixed(0)}%</td>
                        <td className={`num ${(s.ev ?? 0) >= 0 ? "up" : "down"}`}>{s.ev?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="card-hint">{t("fc.evNote")}</p>
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

function HlCard({ label, value, suffix = "", decimals = 1, tone = "", hint }) {
  const animated = useCountUp(Number.isFinite(value) ? value : 0, { decimals });
  return (
    <div className="hl-card glass-card reveal">
      <span className="hl-card__label">{label}</span>
      <span className={`hl-card__value num ${tone}`}>
        {animated.toFixed(decimals)}{suffix}
      </span>
      {hint && <span className="hl-card__hint num">{hint}</span>}
    </div>
  );
}
