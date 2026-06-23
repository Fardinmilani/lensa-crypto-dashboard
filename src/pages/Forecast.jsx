import { useState } from "react";
import { getCandles } from "../lib/coingecko";
import { monteCarlo, tradeSetups, annualizedVol, probabilityPriceMap } from "../lib/forecast";
import ConeChart from "../components/ConeChart";
import ReportActions from "../components/ReportActions";
import TimeframePicker from "../components/TimeframePicker";
import { useCoin } from "../context/coinStore";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

function fmtPrice(n) {
  if (n == null) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}
function pct(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

const PRECISION = [
  { key: "fast", sims: 1000 },
  { key: "balanced", sims: 3000 },
  { key: "precise", sims: 8000 },
];

export default function Forecast() {
  const { coin } = useCoin();
  const { t } = useI18n();
  const [days, setDays] = useLocalStorageState("lensa.forecast.timeframe", "4h");
  const [horizon, setHorizon] = useLocalStorageState("lensa.forecast.horizon", 30);
  const [method, setMethod] = useLocalStorageState("lensa.forecast.method", "bootstrap");
  const [driftMode, setDriftMode] = useLocalStorageState("lensa.forecast.drift", "historical");
  const [sims, setSims] = useLocalStorageState("lensa.forecast.sims", 3000);
  const [mc, setMc] = useState(null);
  const [extra, setExtra] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reveal = useStaggerReveal([mc, error]);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const candles = await getCandles(coin.id, days);
      if (candles.length < 20) throw new Error(t("fc.noData"));
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
        horizonDaysApprox: (Number(horizon) * stepSeconds) / 86400,
      });
    } catch (err) {
      setError(err.message);
      setMc(null);
    } finally {
      setLoading(false);
    }
  }
  const report =
    mc && extra
      ? {
          type: "forecast",
          generatedAt: new Date().toISOString(),
          coin,
          timeframe: days,
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
          <TimeframePicker value={days} onChange={setDays} />
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
          <ReportActions report={report} type="forecast" symbol={coin.symbol} />
          <div className="forecast-hl">
            <HlCard label={t("fc.hl.prob")} value={mc.probProfit * 100} suffix="%" decimals={0} tone={mc.probProfit >= 0.5 ? "up" : "down"} hint={t("fc.hl.probHint", { n: extra.horizonDaysApprox.toFixed(1) })} />
            <HlCard label={t("fc.hl.expected")} value={mc.expectedReturnPct} suffix="%" decimals={1} tone={mc.expectedReturnPct >= 0 ? "up" : "down"} hint={t("fc.hl.expectedHint")} />
            <HlCard label={t("fc.hl.upside")} value={mc.upside95Pct} suffix="%" decimals={1} tone="up" hint={fmtPrice(mc.dist.p95)} />
            <HlCard label={t("fc.hl.downside")} value={mc.var5Pct} suffix="%" decimals={1} tone="down" hint={fmtPrice(mc.dist.p5)} />
            <HlCard label={t("fc.hl.vol")} value={extra.annVol} suffix="%" decimals={0} hint={t("fc.hl.volHint")} />
          </div>

          <div className="glass-card probability-card reveal">
            <div className="panel-header">
              <h2>{t("fc.prob.title")}</h2>
            </div>
            <div className="probability-grid">
              {extra.probabilityMap.map((item) => (
                <div className="probability-item" key={item.key}>
                  <strong className="num">{fmtPrice(item.price)}</strong>
                  <span>
                    {t(`fc.prob.${item.side}`, {
                      p: item.probability,
                      price: fmtPrice(item.price),
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card chart-card reveal">
            <div className="panel-header">
              <div>
                <h2>{t("fc.cone")}</h2>
                <span className="panel-subtitle">{t("fc.coneSub")}</span>
              </div>
            </div>
            <ConeChart history={extra.history} cone={mc.cone} stepSeconds={extra.stepSeconds} />
          </div>

          <div className="forecast-cols forecast-cols--single">
            <div className="glass-card reveal">
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
                        <td className="num up">{fmtPrice(s.target)}<br /><small>{pct(s.targetPct)}</small></td>
                        <td className="num down">{fmtPrice(s.stop)}<br /><small>{pct(s.stopPct)}</small></td>
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
