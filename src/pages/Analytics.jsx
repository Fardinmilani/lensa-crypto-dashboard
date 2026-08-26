import { useMemo, useState } from "react";
import MarketContextBar from "../components/MarketContextBar";
import EquityChart from "../components/EquityChart";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useStaggerReveal } from "../hooks/useAnimations";
import { coinIdFromPair, getChartCandles, auditTimeframes, auditLookbackDays } from "../lib/coingecko";
import { STRATEGIES } from "../lib/strategies";
import { getAllStrategies } from "../lib/customStrategies";
import { runPortfolioBacktest, estimateVolatility } from "../lib/portfolio";
import { correlationMatrix, relativeStrength } from "../lib/correlation";
import { seasonalityAnalysis, DOW_LABELS, MONTH_LABELS } from "../lib/seasonality";
import { applyStressScenario, monteCarloPortfolioStress, STRESS_PRESETS } from "../lib/stress";
import { evaluateSymbolStrategy } from "../lib/screener";
import { evaluateMultiTfConfluence } from "../lib/multitf";
import { detectDivergences } from "../lib/divergence";
import { fetchMacroSnapshot } from "../lib/macro";
import { fetchFearGreedIndex, fetchGlobalMarketLite } from "../lib/onchain";
import { fetchTseComparison } from "../lib/tsePanel";

const SECTIONS = [
  "portfolio",
  "screener",
  "correlation",
  "seasonality",
  "stress",
  "macro",
  "multitf",
  "divergence",
  "tse",
];

export default function Analytics() {
  const { coin } = useCoin();
  const { market, updateFromCandles } = useMarket();
  const { t } = useI18n();
  const reveal = useStaggerReveal([]);
  const [section, setSection] = useState("portfolio");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [watchlist] = useLocalStorageState("lensa.decision.watchlist", ["BTCUSDT", "ETHUSDT", "XRPUSDT", "DOGEUSDT"]);
  const [strategyKey] = useLocalStorageState("lensa.backtest.strategy", "trendMomentumHybrid");
  const [params] = useLocalStorageState("lensa.backtest.params", STRATEGIES.trendMomentumHybrid.params);
  const [direction] = useLocalStorageState("lensa.backtest.direction", "long");
  const [leverage] = useLocalStorageState("lensa.backtest.leverage", 1);
  const [fee] = useLocalStorageState("lensa.backtest.fee", 0.1);
  const [lookbackDays] = useLocalStorageState("lensa.backtest.lookback", 365);

  const [portfolioResult, setPortfolioResult] = useState(null);
  const [screenerRows, setScreenerRows] = useState([]);
  const [corrData, setCorrData] = useState(null);
  const [seasonData, setSeasonData] = useState(null);
  const [stressResult, setStressResult] = useState(null);
  const [macroData, setMacroData] = useState(null);
  const [mtfResult, setMtfResult] = useState(null);
  const [divRows, setDivRows] = useState([]);
  const [tseRows, setTseRows] = useState([]);
  const [tseSymbols, setTseSymbols] = useState("فملی,فولاد,شپنا");

  const [rebalanceDays, setRebalanceDays] = useState("");
  const [stressPreset, setStressPreset] = useState("crash");

  const strategy = useMemo(() => getAllStrategies(STRATEGIES)[strategyKey] || STRATEGIES.trendMomentumHybrid, [strategyKey]);
  const symbols = useMemo(() => [market.pair, ...watchlist.filter((s) => s !== market.pair)].slice(0, 8), [market.pair, watchlist]);

  const defaultWeights = useMemo(() => {
    const w = {};
    const share = symbols.length ? 100 / symbols.length : 0;
    for (const s of symbols) w[s] = Math.round(share);
    return w;
  }, [symbols]);

  const [weightOverrides, setWeightOverrides] = useState({});
  const weights = useMemo(() => ({ ...defaultWeights, ...weightOverrides }), [defaultWeights, weightOverrides]);

  async function fetchSymbolCandles(symbol) {
    return getChartCandles({
      id: coinIdFromPair(symbol, coin.id),
      symbol: symbol.replace(/USDT$/i, ""),
      timeframe: market.timeframe,
      lookbackDays,
      source: market.exchange,
      pair: symbol,
      marketType: market.marketType,
    });
  }

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      if (section === "portfolio") {
        const sets = [];
        for (const sym of symbols) {
          const candles = await fetchSymbolCandles(sym);
          if (candles.length > 10) sets.push({ key: sym, candles });
        }
        if (!sets.length) throw new Error(t("analytics.noData"));
        const w = {};
        for (const s of symbols) w[s] = Number(weights[s]) || 0;
        const res = runPortfolioBacktest({
          candleSets: sets,
          weights: w,
          rebalanceDays: rebalanceDays ? Number(rebalanceDays) : null,
          feePercent: Number(fee) || 0.1,
        });
        if (res.error) throw new Error(res.error);
        setPortfolioResult(res);
      }

      if (section === "screener") {
        const rows = [];
        for (const sym of symbols) {
          try {
            const candles = await fetchSymbolCandles(sym);
            const row = evaluateSymbolStrategy({
              candles,
              strategy,
              params,
              direction,
              leverage: Number(leverage) || 1,
              feePercent: Number(fee) || 0.1,
            });
            rows.push({ symbol: sym, ...row });
          } catch {
            rows.push({ symbol: sym, error: true });
          }
        }
        setScreenerRows(rows);
      }

      if (section === "correlation") {
        const series = {};
        const closesMap = {};
        for (const sym of symbols) {
          const candles = await fetchSymbolCandles(sym);
          if (candles.length > 20) {
            series[sym] = candles.map((c) => c.close);
            closesMap[sym] = candles.map((c) => c.close);
          }
        }
        const { keys, matrix } = correlationMatrix(series, 30);
        const activeCloses = closesMap[market.pair] || series[symbols[0]];
        const rs = symbols
          .filter((s) => s !== market.pair && closesMap[s])
          .map((s) => ({ symbol: s, ...relativeStrength(activeCloses, closesMap[s], 30) }))
          .filter((r) => r.spread != null);
        setCorrData({ keys, matrix, rs });
      }

      if (section === "seasonality") {
        const candles = await fetchSymbolCandles(market.pair);
        updateFromCandles(candles);
        setSeasonData(seasonalityAnalysis(candles));
      }

      if (section === "stress") {
        const w = {};
        const vols = {};
        const means = {};
        for (const sym of symbols) {
          w[sym] = Number(weights[sym]) || 0;
          const candles = await fetchSymbolCandles(sym);
          const closes = candles.map((c) => c.close);
          vols[sym] = estimateVolatility(closes) ?? 25;
          if (closes.length > 2) {
            means[sym] = ((closes.at(-1) / closes[0]) - 1) * 100;
          }
        }
        const preset = STRESS_PRESETS.find((p) => p.id === stressPreset) || STRESS_PRESETS[1];
        const det = applyStressScenario({
          weights: w,
          shocks: preset.shocks,
          correlation: preset.correlation ?? 0.5,
        });
        const mc = monteCarloPortfolioStress({ weights: w, meanReturns: means, vols, correlation: 0.45, sims: 400 });
        setStressResult({ det, mc, preset: preset.id });
      }

      if (section === "macro") {
        const [macro, fg, global] = await Promise.all([
          fetchMacroSnapshot(),
          fetchFearGreedIndex(),
          fetchGlobalMarketLite(),
        ]);
        setMacroData({ macro, fg, global });
      }

      if (section === "multitf") {
        const tfs = auditTimeframes(market.isSingleSource, market.timeframe);
        const sets = [];
        for (const tf of tfs.slice(0, 6)) {
          const lb = auditLookbackDays(tf, lookbackDays);
          const candles = await getChartCandles({
            id: coin.id,
            symbol: coin.symbol,
            timeframe: tf.id,
            lookbackDays: lb,
            source: market.exchange,
            pair: market.pair,
            marketType: market.marketType,
          });
          sets.push({ id: tf.id, label: t(`tf.${tf.id}`) || tf.label, candles });
        }
        setMtfResult(evaluateMultiTfConfluence({ strategy, candleSets: sets, params }));
      }

      if (section === "divergence") {
        const rows = [];
        for (const sym of symbols.slice(0, 6)) {
          const candles = await fetchSymbolCandles(sym);
          for (const type of ["rsi", "macd"]) {
            const hits = detectDivergences(candles, { type }).slice(0, 2);
            for (const h of hits) rows.push({ symbol: sym, ...h });
          }
        }
        setDivRows(rows.sort((a, b) => b.time - a.time).slice(0, 20));
      }

      if (section === "tse") {
        const syms = tseSymbols.split(/[,،\s]+/).map((s) => s.trim()).filter(Boolean);
        const { rows } = await fetchTseComparison(syms, Math.min(Number(lookbackDays) || 90, 365));
        setTseRows(rows);
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="analytics-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("analytics.disclaimer")}</div>
      <MarketContextBar />

      <section className="glass-card analytics-hero reveal">
        <span className="panel-subtitle">{t("analytics.kicker")}</span>
        <h1>{t("analytics.title")}</h1>
        <p>{t("analytics.lead")}</p>
        <nav className="analytics-nav" role="tablist">
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={`analytics-nav__btn ${section === id ? "active" : ""}`}
              onClick={() => setSection(id)}
            >
              {t(`analytics.nav.${id}`)}
            </button>
          ))}
        </nav>
        <button type="button" className="run-btn" onClick={runAnalysis} disabled={loading}>
          {loading ? t("analytics.loading") : t("analytics.run")}
        </button>
      </section>

      {error && <p className="news-error reveal">{error}</p>}

      {section === "portfolio" && (
        <section className="glass-card reveal">
          <h2>{t("analytics.portfolio.title")}</h2>
          <p className="card-hint">{t("analytics.portfolio.hint")}</p>
          <div className="analytics-weights">
            {symbols.map((sym) => (
              <label key={sym}>
                {sym}
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={weights[sym] ?? 0}
                  onChange={(e) => setWeightOverrides((w) => ({ ...w, [sym]: Number(e.target.value) }))}
                />
              </label>
            ))}
          </div>
          <label className="control-group">
            {t("analytics.portfolio.rebalance")}
            <input value={rebalanceDays} onChange={(e) => setRebalanceDays(e.target.value)} placeholder="30" />
          </label>
          {portfolioResult && (
            <>
              <div className="stats-grid">
                <Stat label={t("analytics.portfolio.return")} value={`${portfolioResult.totalReturnPercent.toFixed(1)}%`} />
                <Stat label={t("analytics.portfolio.maxDd")} value={`${portfolioResult.maxDrawdownPercent.toFixed(1)}%`} />
              </div>
              <EquityChart equityCurve={portfolioResult.equityCurve} />
            </>
          )}
        </section>
      )}

      {section === "screener" && screenerRows.length > 0 && (
        <section className="glass-card table-card reveal">
          <h2>{t("analytics.screener.title")}</h2>
          <p className="card-hint">{t("analytics.screener.hint")}</p>
          <div className="table-scroll">
            <table className="heatmap-table">
              <thead>
                <tr>
                  <th>{t("analytics.screener.symbol")}</th>
                  <th>{t("analytics.screener.return")}</th>
                  <th>{t("analytics.screener.sharpe")}</th>
                  <th>{t("analytics.screener.regime")}</th>
                  <th>{t("analytics.screener.signal")}</th>
                </tr>
              </thead>
              <tbody>
                {screenerRows.map((r) => (
                  <tr key={r.symbol}>
                    <td>{r.symbol}</td>
                    <td className={`num ${(r.returnPct ?? 0) >= 0 ? "up" : "down"}`}>{r.error ? "—" : `${r.returnPct?.toFixed(1)}%`}</td>
                    <td className="num">{r.sharpe?.toFixed(2) ?? "—"}</td>
                    <td>{r.regime ?? "—"}</td>
                    <td>{r.signal ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "correlation" && corrData && (
        <section className="glass-card reveal">
          <h2>{t("analytics.corr.title")}</h2>
          <p className="card-hint">{t("analytics.corr.hint")}</p>
          <div className="corr-matrix-wrap">
            <table className="corr-matrix">
              <thead>
                <tr>
                  <th />
                  {corrData.keys.map((k) => (
                    <th key={k}>{k.replace(/USDT$/, "")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {corrData.keys.map((row) => (
                  <tr key={row}>
                    <th>{row.replace(/USDT$/, "")}</th>
                    {corrData.keys.map((col) => {
                      const v = corrData.matrix[row][col];
                      const heat = v != null ? Math.round((v + 1) * 50) : 0;
                      return (
                        <td key={col} className="num corr-cell" style={{ background: `rgba(56,189,248,${heat / 100})` }}>
                          {v != null ? v.toFixed(2) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {corrData.rs?.length > 0 && (
            <>
              <h3>{t("analytics.corr.rs")}</h3>
              <ul className="guide-list">
                {corrData.rs.map((r) => (
                  <li key={r.symbol}>
                    {r.symbol}: spread {r.spread?.toFixed(1)}% (30d)
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {section === "seasonality" && seasonData && !seasonData.error && (
        <section className="glass-card reveal">
          <h2>{t("analytics.season.title")}</h2>
          <p className="card-hint">{t("analytics.season.hint")}</p>
          <div className="season-grid">
            <SeasonTable title={t("analytics.season.dow")} rows={seasonData.dayOfWeek} labels={DOW_LABELS} t={t} />
            <SeasonTable title={t("analytics.season.month")} rows={seasonData.month} labels={MONTH_LABELS} t={t} />
          </div>
        </section>
      )}

      {section === "stress" && (
        <section className="glass-card reveal">
          <h2>{t("analytics.stress.title")}</h2>
          <p className="card-hint">{t("analytics.stress.hint")}</p>
          <select value={stressPreset} onChange={(e) => setStressPreset(e.target.value)}>
            {STRESS_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {stressResult && (
            <div className="stats-grid">
              <Stat label={t("analytics.stress.portReturn")} value={`${stressResult.det.portfolioReturnPercent.toFixed(1)}%`} />
              <Stat label={t("analytics.stress.p5")} value={`${stressResult.mc.p5.toFixed(1)}%`} />
              <Stat label={t("analytics.stress.p50")} value={`${stressResult.mc.p50.toFixed(1)}%`} />
              <Stat label={t("analytics.stress.p95")} value={`${stressResult.mc.p95.toFixed(1)}%`} />
            </div>
          )}
        </section>
      )}

      {section === "macro" && macroData && (
        <section className="glass-card reveal">
          <h2>{t("analytics.macro.title")}</h2>
          <p className="card-hint">{t("analytics.macro.hint")}</p>
          <div className="macro-grid">
            {macroData.fg?.value != null && (
              <div className="macro-card">
                <span>{t("analytics.macro.fearGreed")}</span>
                <strong>{macroData.fg.value}</strong>
                <small>{macroData.fg.label}</small>
              </div>
            )}
            {macroData.global?.btcDominance != null && (
              <div className="macro-card">
                <span>{t("analytics.macro.btcDom")}</span>
                <strong>{macroData.global.btcDominance.toFixed(1)}%</strong>
              </div>
            )}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Rate</th>
                  <th>{t("analytics.macro.change1d")}</th>
                  <th>{t("analytics.macro.change30d")}</th>
                </tr>
              </thead>
              <tbody>
                {(macroData.macro?.rows || []).map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td className="num">{r.price?.toLocaleString()}</td>
                    <td className="num">{r.change1d?.toFixed(2) ?? "—"}%</td>
                    <td className="num">{r.change30d?.toFixed(2) ?? "—"}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "multitf" && mtfResult && !mtfResult.error && (
        <section className="glass-card reveal">
          <h2>{t("analytics.mtf.title")}</h2>
          <p className="card-hint">{t("analytics.mtf.hint")}</p>
          <p className="pill">{t("analytics.mtf.consensus")}: <strong>{mtfResult.consensus}</strong> ({Math.round(mtfResult.score * 100)}% {t("analytics.mtf.score")})</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>TF</th><th>Signal</th><th>State</th></tr>
              </thead>
              <tbody>
                {mtfResult.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>{r.signal}</td>
                    <td>{r.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "divergence" && (
        <section className="glass-card table-card reveal">
          <h2>{t("analytics.div.title")}</h2>
          <p className="card-hint">{t("analytics.div.hint")}</p>
          {!divRows.length && !loading && <p className="card-hint">{t("analytics.div.none")}</p>}
          {divRows.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Symbol</th><th>Type</th><th>Ind</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {divRows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.symbol}</td>
                      <td>{r.type === "bullish" ? t("analytics.div.bullish") : t("analytics.div.bearish")}</td>
                      <td>{r.indicator}</td>
                      <td className="num">{new Date(r.time * 1000).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {section === "tse" && (
        <section className="glass-card table-card reveal">
          <h2>{t("analytics.tse.title")}</h2>
          <p className="card-hint">{t("analytics.tse.hint")}</p>
          <label className="control-group">
            {t("analytics.tse.symbol")}
            <input value={tseSymbols} onChange={(e) => setTseSymbols(e.target.value)} />
          </label>
          {tseRows.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("analytics.tse.symbol")}</th>
                    <th>{t("analytics.tse.last")}</th>
                    <th>{t("analytics.tse.return")}</th>
                    <th>{t("analytics.tse.bars")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tseRows.map((r) => (
                    <tr key={r.symbol}>
                      <td>{r.label || r.symbol}</td>
                      <td className="num">{r.last?.toLocaleString()}</td>
                      <td className={`num ${r.returnPct >= 0 ? "up" : "down"}`}>{r.returnPct?.toFixed(2) ?? "—"}%</td>
                      <td className="num">{r.bars}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <strong className="stat-value num">{value}</strong>
    </div>
  );
}

function SeasonTable({ title, rows, labels, t }) {
  return (
    <div className="season-table">
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            <th />
            <th>{t("analytics.season.avg")}</th>
            <th>{t("analytics.season.win")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{labels[Number(r.key)] ?? r.key}</td>
              <td className="num">{r.avg?.toFixed(3) ?? "—"}%</td>
              <td className="num">{r.winRate?.toFixed(0) ?? "—"}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
