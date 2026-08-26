import { useMemo, useState } from "react";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import InfoTip from "../components/InfoTip";
import { getChartCandles } from "../lib/coingecko";
import { STRATEGIES, combineDirectionalSignals, currentSignalState } from "../lib/strategies";
import { getAllStrategies } from "../lib/customStrategies";
import { runBacktest, runLeveragedBacktest, runAllStrategies } from "../lib/backtest";
import { classifyRegimes, currentRegime, breakdownTradesByRegime, gateSignalsByRegime, edgePermission, REGIME, REGIME_LABELS } from "../lib/regime";
import { enrichBacktest, deflatedSharpeRatio, volatilityTargetNotional } from "../lib/edge";
import { getCrowdSnapshot } from "../lib/derivatives";
import { qualityMetaFromError } from "../lib/dataQuality";
import { formatUsd } from "../lib/priceFormat";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n, pick } from "../i18n/langStore";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useStaggerReveal } from "../hooks/useAnimations";

const LOOKBACK = 365;

export default function EdgeLab() {
  const { coin } = useCoin();
  const { market, updateFromCandles } = useMarket();
  const { t, lang } = useI18n();
  const reveal = useStaggerReveal([]);
  const [strategyKey, setStrategyKey] = useLocalStorageState("lensa.backtest.strategy", "trendMomentumHybrid");
  const [params] = useLocalStorageState("lensa.backtest.params", STRATEGIES.trendMomentumHybrid.params);
  const [direction] = useLocalStorageState("lensa.backtest.direction", "long");
  const [leverage] = useLocalStorageState("lensa.backtest.leverage", 1);
  const [fee] = useLocalStorageState("lensa.backtest.fee", 0.1);
  const [gateRegimes, setGateRegimes] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState(null);
  const [audit, setAudit] = useState(null);
  const [crowd, setCrowd] = useState(null);
  const [live, setLive] = useState(null);
  const [ranking, setRanking] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);

  const allStrategies = useMemo(() => getAllStrategies(STRATEGIES), []);
  const strategy = allStrategies[strategyKey] || STRATEGIES.trendMomentumHybrid;
  const isFutures = market.marketType !== "Spot" || market.isForex;
  const effectiveDirection = isFutures ? direction : "long";
  const effectiveLeverage = isFutures ? Number(leverage) || 1 : 1;

  async function loadCandles() {
    const candles = await getChartCandles({
      id: coin.id,
      symbol: coin.symbol,
      timeframe: market.timeframe,
      lookbackDays: LOOKBACK,
      source: market.exchange,
      pair: market.pair,
      marketType: market.marketType,
    });
    updateFromCandles(candles);
    setDataMeta(candles.meta || null);
    return candles;
  }

  async function scanLive() {
    setError(null);
    try {
      const candles = await loadCandles();
      const regimes = classifyRegimes(candles);
      const now = currentRegime(candles);
      const snapshot = market.isSingleSource ? null : await getCrowdSnapshot(market.pair).catch(() => null);
      setCrowd(snapshot?.error ? null : snapshot);
      setLive({ candles, regimes, now, vol: volatilityTargetNotional({ candles, accountSize: 10000, periodsPerYear: estimatePeriods(candles) }) });
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err));
    }
  }

  async function runAudit() {
    setLoading(true);
    setError(null);
    setRanking(null);
    try {
      const candles = await loadCandles();
      const regimes = classifyRegimes(candles);
      const now = currentRegime(candles);
      const rawSignals = combineDirectionalSignals(strategy, candles, { ...strategy.params, ...params }, effectiveDirection);
      const profitable = new Set();
      // First pass without gating so we know which regimes actually paid.
      const ungated = runEngine(candles, rawSignals);
      const breakdown = breakdownTradesByRegime(ungated.trades, regimes);
      for (const [id, bucket] of Object.entries(breakdown)) {
        if (bucket.n >= 6 && Number.isFinite(bucket.profitFactor) && bucket.profitFactor >= 1) profitable.add(id);
      }
      const gatedSignals = gateRegimes && profitable.size
        ? gateSignalsByRegime(rawSignals, regimes, profitable)
        : rawSignals;
      const result = gateRegimes ? runEngine(candles, gatedSignals) : ungated;
      const edge = enrichBacktest(result, candles, { nTrials: Object.keys(STRATEGIES).length });
      const permission = edgePermission({
        current: now,
        breakdown,
        category: strategy.category,
      });
      const liveState = currentSignalState(strategy, candles, { ...strategy.params, ...params }, effectiveDirection);
      const snapshot = market.isSingleSource ? null : await getCrowdSnapshot(market.pair).catch(() => null);
      setCrowd(snapshot?.error ? null : snapshot);
      setLive({ candles, regimes, now, vol: volatilityTargetNotional({ candles, accountSize: 10000, periodsPerYear: estimatePeriods(candles) }) });
      setAudit({
        result,
        ungated,
        edge,
        breakdown,
        permission,
        liveState,
        gated: Boolean(gateRegimes && profitable.size),
        allowedRegimes: [...profitable],
        strategyKey,
        label: pick(lang, strategy.label),
        category: strategy.category,
      });
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err));
    } finally {
      setLoading(false);
    }
  }

  async function auditUniverse() {
    setLoadingAll(true);
    setError(null);
    try {
      const candles = await loadCandles();
      const nTrials = Object.keys(allStrategies).length;
      const pack = runAllStrategies({
        candles,
        strategies: allStrategies,
        feePercent: Number(fee) || 0.1,
        leverage: effectiveLeverage,
        direction: effectiveDirection,
      });
      const nObs = Math.max(2, candles.length - 1);
      const rows = (pack.rows || [])
        .map((row) => {
          const dsr = Number.isFinite(row.result?.sharpe)
            ? deflatedSharpeRatio({ sharpe: row.result.sharpe, nObs, nTrials })
            : null;
          return { ...row, dsr };
        })
        .sort((a, b) => (b.dsr?.dsr ?? -1) - (a.dsr?.dsr ?? -1));
      setRanking({ rows, nTrials });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingAll(false);
    }
  }

  function runEngine(candles, signals) {
    return effectiveLeverage > 1 || signals.some((s) => s < 0)
      ? runLeveragedBacktest({ candles, signals, feePercent: Number(fee) || 0.1, leverage: effectiveLeverage })
      : runBacktest({ candles, signals, feePercent: Number(fee) || 0.1 });
  }

  const permission = audit?.permission;
  const crowdWarn = crowd?.crowding && crowd.crowding !== "neutral";

  return (
    <div className="edge-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("edge.disclaimer")}</div>
      <MarketContextBar />
      <DataQualityGuard module={t("edge.module")} meta={dataMeta} expectedTimeframe={market.timeframe} />

      <section className="glass-card edge-hero reveal">
        <div className="edge-hero__copy">
          <span className="panel-subtitle">{t("edge.kicker")}</span>
          <h1>{t("edge.title")}</h1>
          <p>{t("edge.lead")}</p>
        </div>
        <div className="edge-hero__actions">
          <label className="edge-check">
            <input type="checkbox" checked={gateRegimes} onChange={(e) => setGateRegimes(e.target.checked)} />
            {t("edge.gate")}
            <InfoTip term="glossary.regimeGate" />
          </label>
          <button type="button" className="run-btn run-btn--ghost" onClick={scanLive}>{t("edge.scan")}</button>
          <button type="button" className="run-btn" onClick={runAudit} disabled={loading}>
            {loading ? t("edge.running") : t("edge.run")}
          </button>
        </div>
      </section>

      <div className="edge-physics">
        <PhysicsCard
          label={t("edge.regime")}
          value={live?.now ? regimeLabel(live.now.id, lang) : "—"}
          hint={live?.now?.adx != null ? t("edge.adx", { n: live.now.adx.toFixed(0) }) : t("edge.scanHint")}
          tone={live?.now?.id === REGIME.SHOCK ? "down" : live?.now?.id?.startsWith("trend") ? "up" : ""}
          tip="glossary.regime"
        />
        <PhysicsCard
          label={t("edge.vol")}
          value={live?.now ? `${Math.round((live.now.volRank || 0) * 100)}%` : "—"}
          hint={t("edge.volHint")}
          tip="glossary.volRank"
        />
        <PhysicsCard
          label={t("edge.permission")}
          value={permission ? t(`edge.action.${permission.action}`) : t("edge.action.unknown")}
          hint={permission ? t(`edge.reason.${permission.reason}`) : t("edge.permissionHint")}
          tone={permission?.action === "trade" ? "up" : permission?.action === "stand_down" ? "down" : ""}
          tip="glossary.edgePermission"
        />
        <PhysicsCard
          label={t("edge.crowd")}
          value={crowd ? t(`edge.crowd.${crowd.crowding}`) : "—"}
          hint={crowd?.fundingApr != null ? t("edge.funding", { n: crowd.fundingApr.toFixed(1) }) : t("edge.crowdHint")}
          tone={crowdWarn ? "down" : ""}
          tip="glossary.crowding"
        />
      </div>

      {crowd && !crowd.error && (
        <div className="glass-card edge-crowd reveal">
          <div className="panel-header"><h2>{t("edge.crowd.title")}</h2></div>
          <p className="section-note">{t("edge.crowd.body")}</p>
          <div className="stats-grid stats-grid--compact">
            <MiniStat label={t("edge.crowd.fundingApr")} value={fmt(crowd.fundingApr, 1, "%")} />
            <MiniStat label={t("edge.crowd.basis")} value={fmt(crowd.basisPct, 3, "%")} />
            <MiniStat label={t("edge.crowd.oi")} value={crowd.openInterest != null ? Number(crowd.openInterest).toLocaleString() : "—"} />
            <MiniStat label={t("edge.crowd.ls")} value={fmt(crowd.lsRatio, 2)} />
            <MiniStat label={t("edge.crowd.taker")} value={fmt(crowd.takerRatio, 2)} />
          </div>
        </div>
      )}

      <div className="glass-card reveal">
        <div className="panel-header"><h2>{t("edge.strategy")}</h2></div>
        <p className="section-note">{t("edge.strategyHint", { name: pick(lang, strategy.label) })}</p>
        <select value={strategyKey} onChange={(e) => setStrategyKey(e.target.value)}>
          {Object.entries(allStrategies).map(([key, s]) => (
            <option key={key} value={key}>{pick(lang, s.label)}</option>
          ))}
        </select>
      </div>

      {error && <p className="news-error reveal">{error}</p>}

      {audit && (
        <>
          <section className={`glass-card edge-verdict reveal edge-verdict--${permission?.action || "wait"}`}>
            <h2>{t("edge.verdict.title")}</h2>
            <p>{t("edge.verdict.body", {
              action: t(`edge.action.${permission?.action || "wait"}`),
              regime: live?.now ? regimeLabel(live.now.id, lang) : "—",
              sqn: fmt(audit.edge?.sqn, 2),
              kelly: audit.edge?.kelly?.usable != null ? `${(audit.edge.kelly.usable * 100).toFixed(1)}%` : "—",
            })}</p>
            {audit.gated && <p className="section-note">{t("edge.gatedNote", { n: audit.allowedRegimes.length })}</p>}
            {audit.liveState && (
              <p className="section-note">{t("edge.liveSignal", { state: audit.liveState.state })}</p>
            )}
          </section>

          <div className="stats-grid">
            <MiniStat label={t("edge.stat.sqn")} value={fmt(audit.edge?.sqn, 2)} tip="glossary.sqn" />
            <MiniStat label={t("edge.stat.calmar")} value={fmt(audit.edge?.calmar, 2)} tip="glossary.calmar" />
            <MiniStat label={t("edge.stat.mar")} value={fmt(audit.edge?.mar, 2)} tip="glossary.mar" />
            <MiniStat label={t("edge.stat.kelly")} value={audit.edge?.kelly?.usable != null ? `${(audit.edge.kelly.usable * 100).toFixed(1)}%` : "—"} tip="glossary.kelly" />
            <MiniStat label={t("edge.stat.sharpe")} value={fmt(audit.result.sharpe, 2)} />
            <MiniStat label={t("edge.stat.pf")} value={fmt(audit.result.profitFactor, 2)} />
            <MiniStat label={t("edge.stat.dd")} value={fmt(audit.result.maxDrawdownPercent, 1, "%")} />
            <MiniStat label={t("edge.stat.underwater")} value={fmt(audit.edge?.underwater, 0, "%")} />
            <MiniStat label={t("edge.stat.streak")} value={audit.edge?.streaks?.maxConsecLosses ?? "—"} tip="glossary.consecLoss" />
            <MiniStat label={t("edge.stat.dsr")} value={audit.edge?.dsr ? `${Math.round(audit.edge.dsr.dsr * 100)}%` : "—"} tip="glossary.dsr" />
          </div>

          {audit.edge?.tradeMc && !audit.edge.tradeMc.error && (
            <div className="glass-card reveal">
              <div className="panel-header"><h2>{t("edge.ruin.title")}</h2></div>
              <p className="section-note">{t("edge.ruin.body")}</p>
              <div className="edge-bars">
                <RuinBar label={t("edge.ruin.dd20")} p={audit.edge.tradeMc.pDD20} />
                <RuinBar label={t("edge.ruin.dd30")} p={audit.edge.tradeMc.pDD30} />
                <RuinBar label={t("edge.ruin.dd40")} p={audit.edge.tradeMc.pRuin} warn />
              </div>
              <div className="stats-grid stats-grid--compact">
                <MiniStat label={t("edge.ruin.median")} value={formatUsd(audit.edge.tradeMc.medianTerminal)} />
                <MiniStat label={t("edge.ruin.p5")} value={formatUsd(audit.edge.tradeMc.p5Terminal)} />
                <MiniStat label={t("edge.ruin.p95")} value={formatUsd(audit.edge.tradeMc.p95Terminal)} />
                <MiniStat
                  label={t("edge.ruin.size")}
                  value={audit.edge.riskBudget?.percentOfAllIn != null ? `${audit.edge.riskBudget.percentOfAllIn.toFixed(0)}%` : "—"}
                  tip="glossary.riskBudget"
                />
              </div>
            </div>
          )}

          {audit.edge?.maeMfe && !audit.edge.maeMfe.error && (
            <div className="glass-card reveal">
              <div className="panel-header"><h2>{t("edge.mae.title")}</h2></div>
              <p className="section-note">{t("edge.mae.body")}</p>
              <div className="stats-grid stats-grid--compact">
                <MiniStat label={t("edge.mae.avg")} value={fmt(audit.edge.maeMfe.avgMae, 2, "%")} />
                <MiniStat label={t("edge.mae.mfe")} value={fmt(audit.edge.maeMfe.avgMfe, 2, "%")} />
                <MiniStat label={t("edge.mae.ratio")} value={fmt(audit.edge.maeMfe.edgeRatio, 2)} tip="glossary.edgeRatio" />
                <MiniStat label={t("edge.mae.stop")} value={fmt(audit.edge.maeMfe.stopHint, 2, "%")} />
                <MiniStat label={t("edge.mae.target")} value={fmt(audit.edge.maeMfe.targetHint, 2, "%")} />
                <MiniStat label={t("edge.mae.giveback")} value={audit.edge.maeMfe.avgGiveback != null ? `${Math.round(audit.edge.maeMfe.avgGiveback * 100)}%` : "—"} />
              </div>
            </div>
          )}

          <div className="glass-card reveal">
            <div className="panel-header"><h2>{t("edge.byRegime.title")}</h2></div>
            <p className="section-note">{t("edge.byRegime.body")}</p>
            <div className="table-scroll">
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>{t("edge.byRegime.regime")}</th>
                    <th>{t("edge.byRegime.n")}</th>
                    <th>{t("edge.byRegime.win")}</th>
                    <th>{t("edge.byRegime.pf")}</th>
                    <th>{t("edge.byRegime.exp")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(REGIME).map((id) => {
                    const row = audit.breakdown[id];
                    const active = live?.now?.id === id;
                    return (
                      <tr key={id} className={active ? "is-active-regime" : undefined}>
                        <td>{regimeLabel(id, lang)}{active ? ` · ${t("edge.now")}` : ""}</td>
                        <td className="num">{row?.n || 0}</td>
                        <td className="num">{row?.winRate != null ? `${row.winRate.toFixed(0)}%` : "—"}</td>
                        <td className="num">{fmt(row?.profitFactor, 2)}</td>
                        <td className="num">{fmt(row?.expectancy, 2, "%")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="glass-card reveal">
        <div className="panel-header"><h2>{t("edge.universe.title")}</h2></div>
        <p className="section-note">{t("edge.universe.body")}</p>
        <button type="button" className="run-btn run-btn--ghost" onClick={auditUniverse} disabled={loadingAll}>
          {loadingAll ? t("edge.universe.running") : t("edge.universe.run")}
        </button>
        {ranking && (
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="trades-table">
              <thead>
                <tr>
                  <th>{t("edge.universe.strategy")}</th>
                  <th>{t("edge.universe.sharpe")}</th>
                  <th>{t("edge.universe.dsr")}</th>
                  <th>{t("edge.universe.return")}</th>
                  <th>{t("edge.universe.dd")}</th>
                  <th>{t("edge.universe.verdict")}</th>
                </tr>
              </thead>
              <tbody>
                {ranking.rows.slice(0, 12).map((row) => (
                  <tr key={row.key}>
                    <td>{pick(lang, row.label) || row.key}</td>
                    <td className="num">{fmt(row.result?.sharpe, 2)}</td>
                    <td className="num">{row.dsr ? `${Math.round(row.dsr.dsr * 100)}%` : "—"}</td>
                    <td className="num">{fmt(row.result?.totalReturnPercent, 1, "%")}</td>
                    <td className="num">{fmt(row.result?.maxDrawdownPercent, 1, "%")}</td>
                    <td>{row.dsr?.likelyOverfit ? t("edge.universe.overfit") : t("edge.universe.survives")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {live?.vol && !live.vol.error && (
        <div className="glass-card reveal">
          <div className="panel-header"><h2>{t("edge.volTarget.title")}</h2></div>
          <p className="section-note">{t("edge.volTarget.body")}</p>
          <div className="stats-grid stats-grid--compact">
            <MiniStat label={t("edge.volTarget.realized")} value={`${(live.vol.realizedVol * 100).toFixed(0)}%`} />
            <MiniStat label={t("edge.volTarget.target")} value="15%" />
            <MiniStat label={t("edge.volTarget.size")} value={`${live.vol.notionalPercent.toFixed(0)}%`} />
          </div>
        </div>
      )}
    </div>
  );
}

function estimatePeriods(candles) {
  if (!candles || candles.length < 3) return 365;
  const dt = candles[1].time - candles[0].time;
  if (!(dt > 0)) return 365;
  return (365.25 * 24 * 3600) / dt;
}

function regimeLabel(id, lang) {
  return REGIME_LABELS[id]?.[lang] || REGIME_LABELS[id]?.en || id;
}

function fmt(value, decimals = 2, suffix = "") {
  if (!Number.isFinite(value) || value === Infinity) return value === Infinity ? "∞" : "—";
  return `${value.toFixed(decimals)}${suffix}`;
}

function PhysicsCard({ label, value, hint, tone = "", tip }) {
  return (
    <div className={`glass-card edge-phys reveal ${tone ? `edge-phys--${tone}` : ""}`}>
      <span className="stat-label">
        {label}
        {tip ? <InfoTip term={tip} /> : null}
      </span>
      <strong className={`stat-value num ${tone}`}>{value}</strong>
      <span className="card-hint">{hint}</span>
    </div>
  );
}

function MiniStat({ label, value, tip }) {
  return (
    <div className="stat-card reveal">
      <span className="stat-label">
        {label}
        {tip ? <InfoTip term={tip} /> : null}
      </span>
      <span className="stat-value num">{value}</span>
    </div>
  );
}

function RuinBar({ label, p, warn }) {
  const pct = Math.round((p || 0) * 100);
  return (
    <div className="edge-bar">
      <div className="edge-bar__meta">
        <span>{label}</span>
        <strong className="num">{pct}%</strong>
      </div>
      <div className="edge-bar__track">
        <span className={`edge-bar__fill${warn ? " is-warn" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}
