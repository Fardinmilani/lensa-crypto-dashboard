import { useEffect, useMemo, useRef, useState } from "react";
import { STRATEGIES, PARAM_LABELS, DIRECTION_MODES, combineDirectionalSignals, currentSignalState } from "../lib/strategies";
import { runBacktest, runLeveragedBacktest, runAllStrategies, autoFitRiskExits, summarizeEquityCurve } from "../lib/backtest";
import { optimizeStrategy, optimizeAllStrategies, walkForwardValidate, optimizeOptionsStrategy, optimizeAllOptionsStrategies } from "../lib/optimize";
import { getAllStrategies, loadCustomDefs } from "../lib/customStrategies";
import { OPTIONS_STRATEGIES, OPTION_PARAM_LABELS, runOptionsStrategy, runAllOptionsStrategies } from "../lib/options";
import { getChartCandles, isBinanceFamilySource, sourceForMarketType } from "../lib/coingecko";
import { formatUsd } from "../lib/priceFormat";
import { qualityMetaFromError } from "../lib/dataQuality";
import EquityChart from "../components/EquityChart";
import TradeReplay from "../components/TradeReplay";
import UnderwaterChart from "../components/UnderwaterChart";
import OptionsPayoffChart from "../components/OptionsPayoffChart";
import ReportActions from "../components/ReportActions";
import TimeframePicker from "../components/TimeframePicker";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import StrategyDocs from "../components/StrategyDocs";
import StrategyBuilder from "../components/StrategyBuilder";
import { useCoin } from "../context/coinStore";
import { useMarket, MARKET_TYPES } from "../context/MarketContext";
import { useI18n, pick } from "../i18n/langStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import InfoTip from "../components/InfoTip";
import { underwaterEquity } from "../lib/underwater";
import { expiryPayoff, legsFromOptionStrategy } from "../lib/optionsPayoff";
import { strategyShareUrl, parseStrategyFromHash } from "../lib/strategyShare";
import { saveCustomDef } from "../lib/customStrategies";

const CATEGORY_ORDER = ["trend", "momentum", "reversion", "quant", "hybrid", "custom"];
const LOOKBACK_PRESETS = [90, 180, 365, 730];
const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100];
const IMPORTED_STRATEGY_KEY = "lensa.decision.importedStrategy";

export default function Backtest() {
  const { coin } = useCoin();
  const { market, setTimeframe, setMarketType, setExchange, setPair, updateFromCandles } = useMarket();
  const { t, lang } = useI18n();
  const locale = lang === "fa" ? "fa-IR" : "en-US";
  const [strategyKey, setStrategyKey] = useLocalStorageState("lensa.backtest.strategy", "trendMomentumHybrid");
  const [params, setParams] = useLocalStorageState("lensa.backtest.params", STRATEGIES.trendMomentumHybrid.params);
  const [fee, setFee] = useLocalStorageState("lensa.backtest.fee", 0.1);
  const [lookbackDays, setLookbackDays] = useLocalStorageState("lensa.backtest.lookback", 365);
  const [result, setResult] = useState(null);
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [aggregate, setAggregate] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState(null);
  const [lastCandles, setLastCandles] = useState([]);
  const [shareNotice, setShareNotice] = useState(false);
  const reveal = useStaggerReveal([result, aggregate, error]);
  // Bumped whenever a custom strategy is saved/deleted in the Strategy
  // Builder below, so allStrategies (and therefore the dropdown/registry
  // everywhere else on this page) picks up the change immediately.
  const [strategiesVersion, setStrategiesVersion] = useState(0);
  const [customCount, setCustomCount] = useState(0);
  const allStrategies = useMemo(
    () => getAllStrategies(STRATEGIES),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- strategiesVersion is a deliberate cache-buster: getAllStrategies() re-reads localStorage each call and has no other argument that changes when a custom strategy is saved/deleted.
    [strategiesVersion]
  );

  useEffect(() => {
    const imported = parseStrategyFromHash(window.location.hash);
    if (!imported?.strategyKey) return;
    setStrategyKey(imported.strategyKey);
    if (imported.params) setParams(imported.params);
    if (imported.customDefinition) saveCustomDef(imported.customDefinition);
  }, [setStrategyKey, setParams]);

  const underwater = useMemo(
    () => (result?.equityCurve ? underwaterEquity(result.equityCurve) : null),
    [result]
  );

  const strategy = allStrategies[strategyKey] || STRATEGIES.trendMomentumHybrid;
  // Keep only parameters the current strategy still supports. Besides
  // preventing stale values from another strategy leaking across reloads,
  // this migrates saved Monte Carlo configs away from the removed exact
  // candle-horizon setting.
  const activeParams = useMemo(
    () => Object.fromEntries(
      Object.entries(strategy.params || {}).map(([name, fallback]) => [name, params?.[name] ?? fallback])
    ),
    [params, strategy]
  );

  // Futures-only controls. market.marketType already comes from the global
  // market bar (Spot / USD-M Futures / Coin-M Futures) — leverage and
  // direction are just additional dimensions of that same run, not a
  // separate page/section. Crypto Spot can never short or use leverage, so
  // these stay pinned at 1x/long whenever marketType is "Spot" -- BUT forex
  // is the one exception: real forex trading is margin/leverage-based by
  // default (there's no separate "futures" instrument the way crypto has
  // perpetuals), and shorting a currency pair is completely standard. So we
  // also unlock this section for forex pairs even though their marketType
  // is always pinned to "Spot" (see MarketContext.jsx).
  const isFutures = market.marketType !== "Spot" || market.isForex;
  const [leverage, setLeverage] = useLocalStorageState("lensa.backtest.leverage", 1);
  const [direction, setDirection] = useLocalStorageState("lensa.backtest.direction", "long");
  // "options" is a third mode alongside long/short/both, not a real trading
  // direction — it doesn't need leverage or a futures/margin market at all
  // (the option-roll engine runs on plain spot candles), so it's exempt
  // from the isFutures gating that long/short/both are subject to below.
  const isOptionsMode = direction === "options";
  const effectiveLeverage = isFutures && !isOptionsMode ? Number(leverage) || 1 : 1;
  const effectiveDirection = isOptionsMode ? "options" : isFutures ? direction : "long";
  const BACKTEST_MODES = [...DIRECTION_MODES, "options"];
  const supportsShort = typeof strategy.generateShortSignals === "function";

  // Risk management (stop-loss / take-profit). Off by default — riskEnabled
  // gates everything below it so a user who never opens this section gets
  // byte-for-byte the same backtest behavior as before this feature existed.
  // stopLossPercent/takeProfitPercent act as a floor/ceiling on top of the
  // strategy's own exit signal (see applyRiskExits in lib/backtest.js): an
  // earlier strategy exit is always respected as-is, these only force an
  // *earlier* exit, never a later one.
  const [riskEnabled, setRiskEnabled] = useLocalStorageState("lensa.backtest.risk.enabled", false);
  // Stop-loss and take-profit are independently toggleable: a user may want
  // only a stop-loss with no profit cap, only a profit cap with no stop, or
  // both together. slEnabled/tpEnabled gate each side separately; the
  // shared riskEnabled checkbox only gates whether the risk section's
  // effects apply at all (so turning it off is still a single-click way to
  // fully revert to the no-risk-management backtest).
  const [slEnabled, setSlEnabled] = useLocalStorageState("lensa.backtest.risk.sl.enabled", true);
  const [tpEnabled, setTpEnabled] = useLocalStorageState("lensa.backtest.risk.tp.enabled", true);
  const [stopLossPercent, setStopLossPercent] = useLocalStorageState("lensa.backtest.risk.sl", 5);
  const [takeProfitPercent, setTakeProfitPercent] = useLocalStorageState("lensa.backtest.risk.tp", 15);
  const [autoFit, setAutoFit] = useLocalStorageState("lensa.backtest.risk.autofit", false);
  const [autoFitResult, setAutoFitResult] = useState(null);

  // Position sizing. Default "allIn" reproduces the engine's original,
  // always-on behavior exactly. "riskPercent" instead sizes each trade so a
  // stop-loss hit loses a fixed share of the account (the same
  // fixed-fractional formula the standalone Risk Tools calculator uses) —
  // it needs a stop-loss distance to be well-defined, so it only takes
  // effect once Stop-Loss is enabled above.
  const [sizingMode, setSizingMode] = useLocalStorageState("lensa.backtest.sizing.mode", "allIn");
  const [sizingRiskPercent, setSizingRiskPercent] = useLocalStorageState("lensa.backtest.sizing.riskPercent", 1);
  // Fill timing. Default "close" reproduces the engine's original,
  // zero-latency assumption (signal computed from bar i's close, filled at
  // that same close). "nextOpen" is the more conservative alternative: a
  // decision made from bar i's data is filled at bar i+1's open instead.
  const [fillTiming, setFillTiming] = useLocalStorageState("lensa.backtest.fillTiming", "close");

  const [walkForwardRunning, setWalkForwardRunning] = useState(false);
  const [walkForwardResult, setWalkForwardResult] = useState(null);

  const [collapsedSections, setCollapsedSections] = useLocalStorageState("lensa.backtest.collapsed", {});
  const toggleSection = (id) => setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const [optionKind, setOptionKind] = useLocalStorageState("lensa.backtest.options.kind", "coveredCall");
  const [optionParams, setOptionParams] = useLocalStorageState(
    "lensa.backtest.options.params",
    OPTIONS_STRATEGIES.coveredCall.params
  );

  const payoffPoints = useMemo(() => {
    if (!result?.isOptions || !lastCandles.length) return [];
    const spot = lastCandles.at(-1)?.close ?? 100;
    const legs = legsFromOptionStrategy(optionKind, { spot, strike: spot * 1.05, premium: spot * 0.02 });
    return expiryPayoff({ legs, spotMin: spot * 0.7, spotMax: spot * 1.3, steps: 60 });
  }, [result, lastCandles, optionKind]);

  // Best-fit parameter search
  // lib/optimize.js. `optimizing`/`optimizingAll` drive button spinners;
  // `fitInfo` and `fitAllInfo` hold the last search's summary so the UI can
  // show what changed and how many combinations were tried.
  const [optimizing, setOptimizing] = useState(false);
  const [optimizingAll, setOptimizingAll] = useState(false);
  const [fitInfo, setFitInfo] = useState(null);
  const [fitAllParams, setFitAllParams] = useState(null); // { [strategyKey]: params } from "fit all"
  const [fitAllInfo, setFitAllInfo] = useState(null);
  const [liveSignal, setLiveSignal] = useState(null);
  const [importedNotice, setImportedNotice] = useState(false);
  const [, setImportedStrategy] = useLocalStorageState(IMPORTED_STRATEGY_KEY, null);
  const importedNoticeTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(importedNoticeTimerRef.current), []);

  const riskParams = riskEnabled && (slEnabled || tpEnabled)
    ? autoFit && autoFitResult
      ? {
          stopLossPercent: slEnabled ? autoFitResult.stopLossPercent : null,
          takeProfitPercent: tpEnabled ? autoFitResult.takeProfitPercent : null,
        }
      : {
          stopLossPercent: slEnabled ? Number(stopLossPercent) || null : null,
          takeProfitPercent: tpEnabled ? Number(takeProfitPercent) || null : null,
        }
    : null;

  // Risk-based sizing needs an actual stop-loss distance to size against; if
  // Stop-Loss isn't enabled (or has no percent set), sizing quietly stays
  // "allIn" here at the UI layer, matching the graceful all-in fallback
  // the engines themselves apply when sizing is passed but no
  // stopLossPercent is available.
  const sizingAvailable = sizingMode === "riskPercent" && riskParams?.stopLossPercent > 0;
  const sizing = sizingAvailable ? { mode: "riskPercent", riskPercent: Number(sizingRiskPercent) || 1 } : null;

  // Binance is the only exchange this app wires up for futures (see
  // SymbolSearch.jsx), and each market type there uses a different pair
  // suffix (Coin-M uses `${base}USD_PERP`, not `${base}USDT`), so switching
  // market type has to update exchange+pair together, not just marketType.
  const base = String(coin.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const isBinanceFamily = isBinanceFamilySource(market.exchange, market.marketType);
  function selectMarketType(mt) {
    setExchange(sourceForMarketType(mt));
    if (mt === "Coin-M Futures") setPair(`${base}USD_PERP`);
    else setPair(`${base}USDT`);
    setMarketType(mt);
  }

  function handleStrategyChange(key) {
    setStrategyKey(key);
    setParams(allStrategies[key]?.params || {});
    setResult(null);
    setFitInfo(null);
    setLiveSignal(null);
    setWalkForwardResult(null);
  }

  async function fetchCandles() {
    return getChartCandles({
      id: coin.id,
      symbol: coin.symbol,
      timeframe: market.timeframe,
      lookbackDays: Number(lookbackDays),
      source: market.exchange,
      pair: market.pair,
      marketType: market.marketType,
    });
  }

  async function handleRun() {
    setLoading(true);
    setError(null);
    setAggregate(null);
    setFitAllParams(null);
    setFitAllInfo(null);
    setAutoFitResult(null);
    setFitInfo(null);
    setWalkForwardResult(null);
    try {
      const candles = await fetchCandles();
      if (candles.length < 30) throw new Error(t("bt.noData"));
      setLastCandles(candles);
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));

      // Options strategies don't fit the signals-array interface every
      // directional strategy on this page uses (their payoff is a periodic
      // roll, not a per-candle position multiplier) — see lib/options.js —
      // so this runs its own small pipeline instead of combineDirectionalSignals
      // + runBacktest/runLeveragedBacktest. It still ends by feeding a plain
      // {time, equity} curve into summarizeEquityCurve(), so the KPIs and
      // chart below are the same shape as every other result on this page,
      // and the same Run/Fit/Run All/Reset buttons work for both modes.
      if (isOptionsMode) {
        const sim = runOptionsStrategy({ candles, kind: optionKind, params: optionParams, initialCapital: 10000 });
        if (sim.error) throw new Error(sim.error);
        // Buy & Hold over the exact same sub-range the option strategy
        // actually traded (it only starts once enough history exists for a
        // volatility estimate), for an apples-to-apples comparison.
        const benchCandles = candles.slice(sim.startIdx);
        const bench = runBacktest({ candles: benchCandles, signals: STRATEGIES.buyAndHold.generateSignals(benchCandles), feePercent: 0 });
        const summarized = summarizeEquityCurve(sim.equityCurve, {
          initialCapital: sim.initialCapital,
          candles,
          benchmarkReturnPercent: bench.totalReturnPercent,
        });
        summarized.tradeCount = sim.rolls.length;
        summarized.rolls = sim.rolls;
        summarized.isOptions = true;
        setResult(summarized);
        setBenchmarkResult(bench);
        setLiveSignal(null);
        return;
      }

      const signals = combineDirectionalSignals(strategy, candles, activeParams, effectiveDirection);

      let effectiveRiskParams = riskParams;
      if (riskEnabled && autoFit) {
        const fit = autoFitRiskExits({
          candles,
          signals,
          feePercent: Number(fee),
          leverage: effectiveLeverage,
        });
        setAutoFitResult(fit);
        effectiveRiskParams = fit
          ? { stopLossPercent: fit.stopLossPercent, takeProfitPercent: fit.takeProfitPercent }
          : null;
      }

      const strategyResult =
        effectiveLeverage > 1 || effectiveDirection !== "long"
          ? runLeveragedBacktest({ candles, signals, feePercent: Number(fee), leverage: effectiveLeverage, riskParams: effectiveRiskParams, sizing, fillTiming })
          : runBacktest({ candles, signals, feePercent: Number(fee), riskParams: effectiveRiskParams, sizing, fillTiming });
      const benchmark = runBacktest({
        candles,
        signals: STRATEGIES.buyAndHold.generateSignals(candles),
        feePercent: Number(fee),
      });
      setResult(strategyResult);
      setBenchmarkResult(benchmark);
      setLiveSignal(currentSignalState(strategy, candles, activeParams, effectiveDirection));
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoading(false);
    }
  }

  // Search a bounded grid of parameter values around this strategy's
  // defaults and adopt whichever combination scored best on this exact
  // coin/timeframe/direction/leverage, then immediately run it so the
  // results below reflect the fitted params. See lib/optimize.js for the
  // scoring rule and in-sample-fitting caveat.
  async function handleFitBest() {
    setOptimizing(true);
    setError(null);
    // Mirror of the aggregate-side fix: clear any previous "all strategies"
    // table so it doesn't linger next to this fresh single-strategy fit.
    setAggregate(null);
    setFitAllParams(null);
    setFitAllInfo(null);
    try {
      const candles = await fetchCandles();
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));

      if (isOptionsMode) {
        const fit = optimizeOptionsStrategy({ kind: optionKind, candles });
        if (!fit) {
          setFitInfo({ unavailable: true });
          return;
        }
        setOptionParams(fit.bestParams);
        setFitInfo({
          testedCount: fit.testedCount,
          improved: fit.improved,
          baselineReturn: fit.baselineResult.totalReturnPercent,
          bestReturn: fit.bestResult.totalReturnPercent,
          robust: fit.robust,
          holdout: fit.holdout,
        });
        const sim = runOptionsStrategy({ candles, kind: optionKind, params: fit.bestParams, initialCapital: 10000 });
        const benchCandles = candles.slice(sim.startIdx);
        const bench = runBacktest({ candles: benchCandles, signals: STRATEGIES.buyAndHold.generateSignals(benchCandles), feePercent: 0 });
        fit.bestResult.benchmarkReturnPercent = bench.totalReturnPercent;
        setResult(fit.bestResult);
        setBenchmarkResult(bench);
        setLiveSignal(null);
        return;
      }

      const fit = optimizeStrategy({
        strategy,
        candles,
        direction: effectiveDirection,
        leverage: effectiveLeverage,
        feePercent: Number(fee),
        riskParams: riskEnabled && !autoFit ? riskParams : null,
        sizing,
        fillTiming,
      });
      if (!fit) {
        setFitInfo({ unavailable: true });
        return;
      }
      setParams(fit.bestParams);
      setFitInfo({
        testedCount: fit.testedCount,
        improved: fit.improved,
        baselineReturn: fit.baselineResult.totalReturnPercent,
        bestReturn: fit.bestResult.totalReturnPercent,
        robust: fit.robust,
        holdout: fit.holdout,
      });
      const signals = combineDirectionalSignals(strategy, candles, fit.bestParams, effectiveDirection);
      let effectiveRiskParams = riskEnabled && !autoFit ? riskParams : null;
      if (riskEnabled && autoFit) {
        const autoFitted = autoFitRiskExits({ candles, signals, feePercent: Number(fee), leverage: effectiveLeverage, sizing, fillTiming });
        setAutoFitResult(autoFitted);
        effectiveRiskParams = autoFitted ? { stopLossPercent: autoFitted.stopLossPercent, takeProfitPercent: autoFitted.takeProfitPercent } : null;
      }
      const strategyResult =
        effectiveLeverage > 1 || effectiveDirection !== "long"
          ? runLeveragedBacktest({ candles, signals, feePercent: Number(fee), leverage: effectiveLeverage, riskParams: effectiveRiskParams, sizing, fillTiming })
          : runBacktest({ candles, signals, feePercent: Number(fee), riskParams: effectiveRiskParams, sizing, fillTiming });
      const benchmark = runBacktest({ candles, signals: STRATEGIES.buyAndHold.generateSignals(candles), feePercent: Number(fee) });
      setResult(strategyResult);
      setBenchmarkResult(benchmark);
      setLiveSignal(currentSignalState(strategy, candles, fit.bestParams, effectiveDirection));
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setOptimizing(false);
    }
  }

  // Same idea as handleFitBest but across every strategy in the registry,
  // then re-runs the "all strategies" comparison using each strategy's
  // fitted params instead of its shipped defaults.
  async function handleFitAllBest() {
    setOptimizingAll(true);
    setError(null);
    // Same reasoning as handleRunAll: clear the previous single-strategy
    // run so its panel doesn't linger next to the freshly fitted aggregate
    // table.
    setResult(null);
    setBenchmarkResult(null);
    setAutoFitResult(null);
    setFitInfo(null);
    setWalkForwardResult(null);
    setLiveSignal(null);
    try {
      const candles = await fetchCandles();
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));

      if (isOptionsMode) {
        const fits = optimizeAllOptionsStrategies({ candles });
        const paramsByKey = {};
        let improvedCount = 0;
        let robustCount = 0;
        for (const [key, fit] of Object.entries(fits)) {
          paramsByKey[key] = fit.bestParams;
          if (fit.improved) improvedCount++;
          if (fit.robust) robustCount++;
        }
        setFitAllParams(paramsByKey);
        setFitAllInfo({ strategyCount: Object.keys(fits).length, improvedCount, robustCount });
        const fittedStrategies = Object.fromEntries(
          Object.entries(OPTIONS_STRATEGIES).map(([key, s]) => [key, paramsByKey[key] ? { ...s, params: paramsByKey[key] } : s])
        );
        setAggregate(runAllOptionsStrategies({ candles, strategies: fittedStrategies }));
        return;
      }

      const fits = optimizeAllStrategies({
        strategies: allStrategies,
        candles,
        direction: effectiveDirection,
        leverage: effectiveLeverage,
        feePercent: Number(fee),
        riskParams: riskEnabled && !autoFit ? riskParams : null,
        sizing,
        fillTiming,
      });
      const paramsByKey = {};
      let improvedCount = 0;
      let robustCount = 0;
      for (const [key, fit] of Object.entries(fits)) {
        paramsByKey[key] = fit.bestParams;
        if (fit.improved) improvedCount++;
        if (fit.robust) robustCount++;
      }
      setFitAllParams(paramsByKey);
      setFitAllInfo({ strategyCount: Object.keys(fits).length, improvedCount, robustCount });
      const fittedStrategies = Object.fromEntries(
        Object.entries(allStrategies).map(([key, s]) => [key, paramsByKey[key] ? { ...s, params: paramsByKey[key] } : s])
      );
      setAggregate(
        runAllStrategies({
          candles,
          strategies: fittedStrategies,
          feePercent: Number(fee),
          leverage: effectiveLeverage,
          direction: effectiveDirection,
          riskParams: riskEnabled && !autoFit ? riskParams : null,
          sizing,
          fillTiming,
        })
      );
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setOptimizingAll(false);
    }
  }

  // Hand the currently configured (or just-fitted) strategy off to the
  // Decision Center so it can be weighed alongside the built-in analysis
  // instead of only living in this page's historical view.
  function buildStrategyPayload() {
    const customDefinition = strategy.isCustom
      ? loadCustomDefs().find((definition) => definition.id === strategyKey) || null
      : null;

    return {
      schemaVersion: 2,
      strategyKey,
      params: activeParams,
      direction: effectiveDirection,
      leverage: effectiveLeverage,
      marketType: market.marketType,
      pair: market.pair,
      exchange: market.exchange,
      timeframe: market.timeframe,
      historicalRange: market.historicalRange,
      coin: {
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        thumb: coin.thumb || null,
      },
      lookbackDays: Number(lookbackDays),
      fee: Number(fee),
      riskParams,
      riskSettings: {
        enabled: Boolean(riskEnabled),
        stopLossEnabled: Boolean(slEnabled),
        takeProfitEnabled: Boolean(tpEnabled),
        autoFit: Boolean(autoFit),
        stopLossPercent: riskParams?.stopLossPercent ?? null,
        takeProfitPercent: riskParams?.takeProfitPercent ?? null,
      },
      sizing,
      sizingMode: sizingAvailable ? "riskPercent" : "allIn",
      sizingRiskPercent: Number(sizingRiskPercent) || 1,
      fillTiming,
      customDefinition,
      label: pick(lang, strategy.label),
      savedAt: Date.now(),
    };
  }

  function handleSendToDecisionCenter() {
    setImportedStrategy(buildStrategyPayload());
    setImportedNotice(true);
    clearTimeout(importedNoticeTimerRef.current);
    importedNoticeTimerRef.current = setTimeout(() => setImportedNotice(false), 4000);
  }

  function handleExportStrategy() {
    const blob = new Blob([JSON.stringify(buildStrategyPayload(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lensa-strategy-${strategyKey}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleShareStrategy() {
    const url = strategyShareUrl(buildStrategyPayload());
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setShareNotice(true);
      setTimeout(() => setShareNotice(false), 3000);
    });
  }

  async function handleRunAll() {
    setLoadingAll(true);
    setError(null);
    setFitAllParams(null);
    setFitAllInfo(null);
    // Clear any single-strategy run left over from before — otherwise its
    // panel (rendered independently of the aggregate table below) keeps
    // showing that old strategy's numbers alongside the fresh "all
    // strategies" comparison, which is confusing and looks like a stale/
    // frozen result.
    setResult(null);
    setBenchmarkResult(null);
    setAutoFitResult(null);
    setFitInfo(null);
    setWalkForwardResult(null);
    setLiveSignal(null);
    try {
      const candles = await fetchCandles();
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      if (isOptionsMode) {
        setAggregate(runAllOptionsStrategies({ candles }));
        return;
      }
      setAggregate(
        runAllStrategies({
          candles,
          strategies: allStrategies,
          feePercent: Number(fee),
          leverage: effectiveLeverage,
          direction: effectiveDirection,
          riskParams: riskEnabled && !autoFit ? riskParams : null,
          sizing,
          fillTiming,
        })
      );
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoadingAll(false);
    }
  }

  // Out-of-sample check for the currently selected strategy: fits on the
  // first share of history, then scores both the fitted params and the
  // shipped defaults on the untouched remainder. See walkForwardValidate()
  // in lib/optimize.js for why this matters and what a big train/test gap
  // means.
  async function handleWalkForward() {
    setWalkForwardRunning(true);
    setError(null);
    try {
      const candles = await fetchCandles();
      if (candles.length < 30) throw new Error(t("bt.noData"));
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      const wf = walkForwardValidate({
        strategy,
        candles,
        direction: effectiveDirection,
        leverage: effectiveLeverage,
        feePercent: Number(fee),
        riskParams: riskEnabled && !autoFit ? riskParams : null,
        sizing,
        fillTiming,
      });
      setWalkForwardResult(wf || { unavailable: true });
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setWalkForwardRunning(false);
    }
  }

  // Discards any single-strategy fit and puts this strategy's inputs back
  // to exactly what it shipped with, clearing the stale result/fit-info
  // that belonged to the old (possibly fitted) params — same idea as
  // handleStrategyChange, just without switching strategy.
  function handleResetParams() {
    if (isOptionsMode) {
      setOptionParams(OPTIONS_STRATEGIES[optionKind]?.params || {});
    } else {
      setParams(allStrategies[strategyKey]?.params || {});
    }
    setResult(null);
    setBenchmarkResult(null);
    setAutoFitResult(null);
    setFitInfo(null);
    setWalkForwardResult(null);
    setLiveSignal(null);
  }

  // Clears every strategy's fitted overrides from "Fit all" and re-runs the
  // all-strategies comparison so it immediately reflects shipped defaults
  // again, rather than leaving the fitted table up until the user manually
  // re-runs it.
  async function handleResetAllParams() {
    setFitAllParams(null);
    setFitAllInfo(null);
    await handleRunAll();
  }

  function handleInspectStrategy(key) {
    handleStrategyChange(key);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleOptionKindChange(kind) {
    setOptionKind(kind);
    setOptionParams(OPTIONS_STRATEGIES[kind]?.params || {});
    setResult(null);
    setBenchmarkResult(null);
    setFitInfo(null);
  }

  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: Object.entries(allStrategies).filter(([, s]) => s.category === cat),
  })).filter((g) => g.items.length > 0);
  const report =
    result && benchmarkResult
      ? isOptionsMode
        ? {
            type: "options",
            generatedAt: new Date().toISOString(),
            marketContext: market,
            strategy: optionKind,
            strategyLabel: pick(lang, OPTIONS_STRATEGIES[optionKind]?.label),
            params: optionParams,
            result,
            benchmark: benchmarkResult,
          }
        : {
            type: "backtest",
            generatedAt: new Date().toISOString(),
            marketContext: market,
            strategy: strategyKey,
            strategyLabel: pick(lang, strategy.label),
            params: activeParams,
            fee,
            leverage: effectiveLeverage,
            direction: effectiveDirection,
            riskParams: result.riskParams || null,
            autoFit: riskEnabled && autoFit ? autoFitResult : null,
            result,
            benchmark: benchmarkResult,
          }
      : null;

  return (
    <div className="backtest-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("bt.disclaimer")}</div>
      <MarketContextBar />
      <DataQualityGuard module={t("dq.module.backtest")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />

      <div className="backtest-controls glass-card reveal">
        <ControlsSection
          id="market"
          title={t("bt.section.market")}
          collapsed={collapsedSections.market}
          onToggle={() => toggleSection("market")}
        >
          <div className="control-group control-group--wide">
            <label>{t("common.activeCoin")}</label>
            <div className="active-coin-chip">
              {coin.thumb && <img src={coin.thumb} alt="" width="18" height="18" />}
              <strong>{coin.symbol}</strong>
              <span>{coin.name}</span>
            </div>
          </div>
          {!market.isSingleSource && (
            <div className="control-group control-group--full">
              <label>
                {t("bt.marketType")}
                <InfoTip term="glossary.btMarketType" />
              </label>
              {isBinanceFamily ? (
                <>
                  <div className="chip-toggle-group">
                    {MARKET_TYPES.map((mt) => (
                      <button
                        type="button"
                        key={mt}
                        className={`chip-toggle${market.marketType === mt ? " is-active" : ""}`}
                        onClick={() => selectMarketType(mt)}
                      >
                        {mt}
                      </button>
                    ))}
                  </div>
                  <small className="control-hint">
                    {market.marketType === "Spot" ? t("bt.marketType.spotHint") : t("bt.marketType.futuresHint")}
                  </small>
                </>
              ) : (
                <small className="control-hint">{t("bt.marketType.binanceOnly")}</small>
              )}
            </div>
          )}
          {isOptionsMode ? (
            <>
              <div className="control-group control-group--wide">
                <label>{t("bt.options.strategy")}</label>
                <select value={optionKind} onChange={(e) => handleOptionKindChange(e.target.value)}>
                  {Object.entries(OPTIONS_STRATEGIES).map(([key, s]) => (
                    <option key={key} value={key}>{pick(lang, s.label)}</option>
                  ))}
                </select>
              </div>
              {Object.entries(optionParams).map(([name, value]) => (
                <div className="control-group" key={name}>
                  <label>{pick(lang, OPTION_PARAM_LABELS[name]) || name}</label>
                  <input
                    type="number"
                    value={value}
                    onChange={(e) => setOptionParams((prev) => ({ ...prev, [name]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <p className="strategy-description control-group--full">{pick(lang, OPTIONS_STRATEGIES[optionKind]?.description)}</p>
              <small className="control-hint control-hint--accent control-group--full">{t("bt.options.disclaimer")}</small>
            </>
          ) : (
            <>
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
              {Object.entries(activeParams).map(([name, value]) => (
                <div className="control-group" key={name}>
                  <label>{pick(lang, PARAM_LABELS[name]) || name}</label>
                  <input type="number" value={value} onChange={(e) => setParams((prev) => ({ ...prev, [name]: Number(e.target.value) }))} />
                </div>
              ))}
            </>
          )}
          <div className="control-group control-group--full">
            <label>{t("bt.candleInterval")}</label>
            <TimeframePicker value={market.timeframe} onChange={setTimeframe} intradayDisabled={market.isSingleSource} />
          </div>
          <div className="control-group control-group--wide">
            <label>{t("bt.lookback")}</label>
            <div className="lookback-control">
              <select
                value={LOOKBACK_PRESETS.includes(Number(lookbackDays)) ? lookbackDays : ""}
                onChange={(e) => e.target.value && setLookbackDays(Number(e.target.value))}
              >
                {!LOOKBACK_PRESETS.includes(Number(lookbackDays)) && (
                  <option value="">{t("tf.days", { n: lookbackDays })}</option>
                )}
                {LOOKBACK_PRESETS.map((days) => (
                  <option key={days} value={days}>
                    {t("tf.days", { n: days })}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="30"
                max="3650"
                value={lookbackDays}
                onChange={(e) => setLookbackDays(e.target.value)}
                aria-label={t("bt.lookback")}
              />
            </div>
            <small className="control-hint">{t("bt.lookback.hint")}</small>
          </div>
          {isFutures && (
            <div className="control-group">
              <label>{t("bt.leverage")}</label>
              <select value={LEVERAGE_PRESETS.includes(Number(leverage)) ? leverage : ""} onChange={(e) => e.target.value && setLeverage(Number(e.target.value))}>
                {!LEVERAGE_PRESETS.includes(Number(leverage)) && <option value="">{leverage}x</option>}
                {LEVERAGE_PRESETS.map((lv) => (
                  <option key={lv} value={lv}>{lv}x</option>
                ))}
              </select>
              <small className="control-hint">{t("bt.leverage.hint", { market: market.isForex ? t("bt.market.forex") : market.marketType })}</small>
            </div>
          )}
          <div className="control-group">
            <label>{t("bt.direction")}</label>
            <div className="chip-toggle-group">
              {BACKTEST_MODES.map((mode) => {
                const isOptions = mode === "options";
                const blockedByMarket = !isOptions && mode !== "long" && !isFutures;
                const blockedByStrategy = !isOptions && mode !== "long" && isFutures && !supportsShort;
                const disabled = blockedByMarket || blockedByStrategy;
                const hint = blockedByMarket ? t("bt.direction.spotOnlyLong") : blockedByStrategy ? t("bt.direction.noShortRule") : undefined;
                // Highlight follows the direction the run will ACTUALLY use
                // (effectiveDirection clamps to long on Spot), not the raw
                // saved value — otherwise a Short chip left over from a
                // futures session stays lit while the results are long-only.
                const isActive = isOptionsMode ? mode === "options" : effectiveDirection === mode;
                return (
                  <button
                    type="button"
                    key={mode}
                    className={`chip-toggle${isActive ? " is-active" : ""}`}
                    onClick={() => setDirection(mode)}
                    disabled={disabled}
                    title={hint}
                    aria-pressed={isActive}
                  >
                    {t(`bt.direction.${mode}`)}
                  </button>
                );
              })}
            </div>
            {!isFutures && direction !== "long" && !isOptionsMode && (
              <small className="control-hint control-hint--warn">{t("bt.direction.spotOnlyLong")}</small>
            )}
            {isFutures && !supportsShort && direction !== "long" && !isOptionsMode && (
              <small className="control-hint control-hint--warn">{t("bt.direction.noShortRule")}</small>
            )}
          </div>
        </ControlsSection>

        {!isOptionsMode && (
        <ControlsSection
          id="customStrategy"
          title={t("bt.section.custom")}
          badge={customCount > 0 ? t("bt.section.custom.count", { n: customCount }) : null}
          collapsed={collapsedSections.customStrategy !== false}
          onToggle={() => toggleSection("customStrategy")}
        >
          <StrategyBuilder
            t={t}
            activeStrategyKey={strategyKey}
            onSaved={(id) => {
              setStrategiesVersion((v) => v + 1);
              handleStrategyChange(id);
            }}
            onDeleted={() => setStrategiesVersion((v) => v + 1)}
            onCountChange={setCustomCount}
          />
        </ControlsSection>
        )}

        {!isOptionsMode && (
        <ControlsSection
          id="risk"
          title={t("bt.section.risk")}
          badge={
            !riskEnabled
              ? t("bt.section.risk.off")
              : slEnabled && tpEnabled
                ? t("bt.section.risk.both")
                : slEnabled
                  ? t("bt.section.risk.slonly")
                  : tpEnabled
                    ? t("bt.section.risk.tponly")
                    : t("bt.section.risk.off")
          }
          collapsed={collapsedSections.risk}
          onToggle={() => toggleSection("risk")}
        >
          <div className="controls-section__row control-group--full">
            <label className="toggle-row">
              <input type="checkbox" checked={riskEnabled} onChange={(e) => setRiskEnabled(e.target.checked)} />
              {t("bt.risk.enable")}
            </label>
          </div>
          {riskEnabled && (
            <>
              <div className="control-group">
                <label className="toggle-row toggle-row--inline">
                  <input type="checkbox" checked={slEnabled} disabled={autoFit} onChange={(e) => setSlEnabled(e.target.checked)} />
                  {t("bt.risk.sl")}<InfoTip term="glossary.btStopLoss" />
                </label>
                <input
                  type="number"
                  min="0.1"
                  step="0.5"
                  value={stopLossPercent}
                  disabled={autoFit || !slEnabled}
                  onChange={(e) => setStopLossPercent(e.target.value)}
                />
                <small className="control-hint">
                  {t("bt.risk.sl.hint", {
                    lev: effectiveLeverage,
                    pos: stopLossPercent,
                    coin: (Number(stopLossPercent) / Math.max(1, effectiveLeverage)).toFixed(2),
                  })}
                </small>
              </div>
              <div className="control-group">
                <label className="toggle-row toggle-row--inline">
                  <input type="checkbox" checked={tpEnabled} disabled={autoFit} onChange={(e) => setTpEnabled(e.target.checked)} />
                  {t("bt.risk.tp")}<InfoTip term="glossary.btTakeProfit" />
                </label>
                <input
                  type="number"
                  min="0.1"
                  step="0.5"
                  value={takeProfitPercent}
                  disabled={autoFit || !tpEnabled}
                  onChange={(e) => setTakeProfitPercent(e.target.value)}
                />
                <small className="control-hint">
                  {t("bt.risk.tp.hint", {
                    lev: effectiveLeverage,
                    pos: takeProfitPercent,
                    coin: (Number(takeProfitPercent) / Math.max(1, effectiveLeverage)).toFixed(2),
                  })}
                </small>
              </div>
              <div className="control-group control-group--full">
                <label className="toggle-row">
                  <input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />
                  {t("bt.risk.autofit")}
                </label>
                <small className="control-hint">{t("bt.risk.autofit.hint")}</small>
                {autoFit && autoFitResult && (
                  <small className="control-hint control-hint--accent">
                    {t("bt.risk.autofit.result", {
                      sl: autoFitResult.stopLossPercent,
                      tp: autoFitResult.takeProfitPercent,
                    })}
                  </small>
                )}
              </div>
            </>
          )}
        </ControlsSection>
        )}

        {!isOptionsMode && (
        <ControlsSection
          id="execution"
          title={t("bt.section.execution")}
          badge={sizingAvailable ? t("bt.sizing.badge", { n: sizingRiskPercent }) : null}
          collapsed={collapsedSections.execution !== false}
          onToggle={() => toggleSection("execution")}
        >
          <div className="control-group control-group--wide">
            <label>
              {t("bt.sizing")}
              <InfoTip term="glossary.btSizing" />
            </label>
            <select value={sizingMode} onChange={(e) => setSizingMode(e.target.value)}>
              <option value="allIn">{t("bt.sizing.allIn")}</option>
              <option value="riskPercent">{t("bt.sizing.riskPercent")}</option>
            </select>
            {sizingMode === "riskPercent" && !(riskEnabled && slEnabled) && (
              <small className="control-hint control-hint--warn">{t("bt.sizing.needsSl")}</small>
            )}
          </div>
          {sizingMode === "riskPercent" && (
            <div className="control-group">
              <label>{t("bt.sizing.riskPercent.label")}</label>
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.25"
                value={sizingRiskPercent}
                onChange={(e) => setSizingRiskPercent(e.target.value)}
              />
              <small className="control-hint">{t("bt.sizing.riskPercent.hint")}</small>
            </div>
          )}
          <div className="control-group control-group--wide">
            <label>
              {t("bt.fillTiming")}
              <InfoTip term="glossary.btFillTiming" />
            </label>
            <select value={fillTiming} onChange={(e) => setFillTiming(e.target.value)}>
              <option value="close">{t("bt.fillTiming.close")}</option>
              <option value="nextOpen">{t("bt.fillTiming.nextOpen")}</option>
            </select>
          </div>
        </ControlsSection>
        )}

        <ControlsSection id="run" title={t("bt.section.run")} collapsed={false} onToggle={null}>
          <div className="run-btn-row">
            <button className="run-btn" onClick={handleRun} disabled={loading || loadingAll || optimizing || optimizingAll}>
              {loading ? t("bt.running") : t("bt.run")}
            </button>
            <button
              className="run-btn run-btn--ghost"
              onClick={handleFitBest}
              disabled={loading || loadingAll || optimizing || optimizingAll}
              title={t("bt.fit.hint")}
            >
              {optimizing ? t("bt.fit.running") : t("bt.fit")}
            </button>
            <button
              className="run-btn run-btn--ghost"
              onClick={handleResetParams}
              disabled={loading || loadingAll || optimizing || optimizingAll}
              title={t("bt.reset.hint")}
            >
              {t("bt.reset")}
            </button>
          </div>
          <div className="run-btn-row">
            <button className="run-btn run-btn--ghost" onClick={handleRunAll} disabled={loading || loadingAll || optimizing || optimizingAll}>
              {loadingAll ? t("bt.runningAll") : t("bt.runAll")}
            </button>
            <button
              className="run-btn run-btn--ghost"
              onClick={handleFitAllBest}
              disabled={loading || loadingAll || optimizing || optimizingAll}
              title={t("bt.fitAll.hint")}
            >
              {optimizingAll ? t("bt.fitAll.running") : t("bt.fitAll")}
            </button>
            <button
              className="run-btn run-btn--ghost"
              onClick={handleResetAllParams}
              disabled={loading || loadingAll || optimizing || optimizingAll}
              title={t("bt.resetAll.hint")}
            >
              {t("bt.resetAll")}
            </button>
          </div>
          {fitInfo && !fitInfo.unavailable && (
            <small className="control-hint control-hint--accent">
              {t("bt.fit.result", {
                n: fitInfo.testedCount,
                from: fitInfo.baselineReturn.toFixed(1),
                to: fitInfo.bestReturn.toFixed(1),
              })}
            </small>
          )}
          {fitInfo && !fitInfo.unavailable && fitInfo.robust && fitInfo.holdout && (
            <small className="control-hint">
              {t("bt.fit.holdout", {
                fitted: fitInfo.holdout.fittedReturnPercent.toFixed(1),
                default: fitInfo.holdout.defaultReturnPercent.toFixed(1),
              })}
            </small>
          )}
          {fitInfo && !fitInfo.unavailable && fitInfo.robust === false && (
            <small className="control-hint control-hint--warn">{t("bt.fit.notRobust")}</small>
          )}
          {fitInfo?.unavailable && <small className="control-hint">{t("bt.fit.unavailable")}</small>}
          {fitAllInfo && (
            <small className="control-hint control-hint--accent">
              {t("bt.fitAll.result", { improved: fitAllInfo.improvedCount, total: fitAllInfo.strategyCount })}
            </small>
          )}
          {fitAllInfo && (
            <small className="control-hint">
              {t("bt.fitAll.robust", { robust: fitAllInfo.robustCount, total: fitAllInfo.strategyCount })}
            </small>
          )}
          <div className="run-btn-row">
            <button
              className="run-btn run-btn--ghost"
              onClick={handleWalkForward}
              disabled={loading || loadingAll || optimizing || optimizingAll || walkForwardRunning}
              title={t("bt.walkforward.hint")}
            >
              {walkForwardRunning ? t("bt.walkforward.running") : t("bt.walkforward")}
              <InfoTip term="glossary.btWalkForward" />
            </button>
          </div>
          {walkForwardResult?.unavailable && <small className="control-hint">{t("bt.walkforward.unavailable")}</small>}
          {walkForwardResult && !walkForwardResult.unavailable && (
            <div className="walkforward-summary">
              <small className="control-hint">
                {t("bt.walkforward.split", {
                  train: walkForwardResult.trainCandleCount,
                  test: walkForwardResult.testCandleCount,
                })}
              </small>
              <div className="walkforward-row">
                <span>{t("bt.walkforward.train")}</span>
                <strong>{walkForwardResult.trainResult.totalReturnPercent.toFixed(1)}%</strong>
              </div>
              <div className="walkforward-row">
                <span>{t("bt.walkforward.testFitted")}</span>
                <strong>{walkForwardResult.testFittedResult.totalReturnPercent.toFixed(1)}%</strong>
              </div>
              <div className="walkforward-row">
                <span>{t("bt.walkforward.testDefault")}</span>
                <strong>{walkForwardResult.testDefaultResult.totalReturnPercent.toFixed(1)}%</strong>
              </div>
              {Number.isFinite(walkForwardResult.trainScore) &&
                Number.isFinite(walkForwardResult.testScore) &&
                walkForwardResult.trainScore > 0 && (
                  <small className="control-hint control-hint--accent">
                    {walkForwardResult.testScore < walkForwardResult.trainScore * 0.5
                      ? t("bt.walkforward.warn")
                      : t("bt.walkforward.ok")}
                  </small>
                )}
            </div>
          )}
        </ControlsSection>

        {!isOptionsMode && (
        <ControlsSection
          id="docs"
          title={t("bt.section.docs")}
          badge={t("bt.section.docs.badge")}
          collapsed={collapsedSections.docs !== false}
          onToggle={() => toggleSection("docs")}
        >
          <StrategyDocs activeStrategyKey={strategyKey} />
        </ControlsSection>
        )}
      </div>

      <div className="guide-card glass-card reveal">
        <h2>{t("bt.guide.title")}</h2>
        <p>{t("bt.guide.body")}</p>
        <p>{t("bt.guide.metrics")}</p>
      </div>
      <p className="strategy-description reveal">{pick(lang, strategy.description)}</p>
      {error && <p className="news-error reveal">{t(error)}</p>}

      {result && (
        <div className="backtest-results">
          <ReportActions report={report} type={result.isOptions ? "options" : "backtest"} symbol={coin.symbol} />
          {liveSignal && <LiveSignalCard liveSignal={liveSignal} direction={effectiveDirection} t={t} locale={locale} />}
          {!result.isOptions && (
            <div className="glass-card decision-handoff reveal">
              <div className="panel-header"><h2>{t("bt.handoff.title")}</h2></div>
              <p className="section-note">{t("bt.handoff.body")}</p>
              <button className="run-btn run-btn--ghost" onClick={handleSendToDecisionCenter}>
                {t("bt.handoff.button")}
              </button>
              <button className="run-btn run-btn--ghost" onClick={handleExportStrategy}>
                {t("bt.handoff.export")}
              </button>
              <button className="run-btn run-btn--ghost" onClick={handleShareStrategy}>
                {t("bt.share.copy")}
              </button>
              {shareNotice && <small className="control-hint control-hint--accent">{t("bt.share.copied")}</small>}
              <button className="run-btn run-btn--ghost" onClick={() => { window.location.hash = "edge"; }}>
                {t("bt.handoff.edge")}
              </button>
              <button className="run-btn run-btn--ghost" onClick={() => { window.location.hash = "guide"; }}>
                {t("bt.handoff.guide")}
              </button>
              {importedNotice && <small className="control-hint control-hint--accent">{t("bt.handoff.sent")}</small>}
            </div>
          )}
          {result.isOptions && (
            <p className="section-note control-group--full">{t("bt.options.disclaimer")}</p>
          )}
          <div className="stats-grid">
            <Stat label={t("bt.stat.return")} value={result.totalReturnPercent} suffix="%" tone={result.totalReturnPercent >= 0 ? "up" : "down"} />
            <Stat label={t("bt.stat.bench")} value={result.benchmarkReturnPercent} suffix="%" tone={result.benchmarkReturnPercent >= 0 ? "up" : "down"} tip="glossary.benchmark" />
            <Stat label={t("bt.stat.dd")} value={result.maxDrawdownPercent} suffix="%" tone="down" prefix="-" abs tip="glossary.maxDrawdown" />
            <Stat label={t("bt.stat.sharpe")} value={result.sharpe} decimals={2} tone={result.sharpe >= 1 ? "up" : ""} tip="glossary.sharpe" />
            <Stat label={t("bt.stat.sortino")} value={result.sortino} decimals={2} tip="glossary.sortino" />
            {result.isOptions ? (
              <Stat label={t("bt.options.stat.rolls")} value={result.tradeCount} decimals={0} />
            ) : (
              <>
                <Stat label={t("bt.stat.winrate")} value={result.winRate} suffix="%" decimals={0} tip="glossary.winRate" />
                <Stat label={t("bt.stat.pf")} value={isFinite(result.profitFactor) ? result.profitFactor : null} decimals={2} fallback={result.profitFactor === Infinity ? "∞" : "-"} tip="glossary.profitFactor" />
                <Stat label={t("bt.stat.expectancy")} value={result.expectancy} suffix="%" decimals={2} tone={(result.expectancy ?? 0) >= 0 ? "up" : "down"} tip="glossary.expectancy" />
                <Stat label={t("bt.stat.avgwin")} value={result.avgWin} suffix="%" decimals={2} tone="up" />
                <Stat label={t("bt.stat.avgloss")} value={result.avgLoss} suffix="%" decimals={2} tone="down" />
                <Stat label={t("bt.stat.trades")} value={result.tradeCount} decimals={0} />
                <Stat label={t("bt.stat.exposure")} value={result.exposurePercent} suffix="%" decimals={0} tip="glossary.exposure" />
              </>
            )}
            {isFutures && !result.isOptions && (
              <>
                <Stat label={t("bt.stat.leverage")} value={effectiveLeverage} suffix="x" decimals={0} />
                <Stat label={t("bt.stat.longShort")} value={result.longCount ?? 0} decimals={0} suffix={` / ${result.shortCount ?? 0}`} />
                <Stat
                  label={t("bt.stat.liquidations")}
                  value={result.liquidationCount ?? 0}
                  decimals={0}
                  tone={(result.liquidationCount ?? 0) > 0 ? "down" : ""}
                />
              </>
            )}
            {result.riskParams?.stopLossPercent != null && (
              <Stat label={t("bt.risk.sl")} value={result.riskParams.stopLossPercent} suffix="%" decimals={1} tone="down" tip="glossary.btStopLoss" />
            )}
            {result.riskParams?.takeProfitPercent != null && (
              <Stat label={t("bt.risk.tp")} value={result.riskParams.takeProfitPercent} suffix="%" decimals={1} tone="up" tip="glossary.btTakeProfit" />
            )}
          </div>
          {!result.isOptions && !sizingAvailable && result.riskParams?.stopLossPercent != null && (
            <p className="section-note">{t("bt.dd.compound", { sl: result.riskParams.stopLossPercent })}</p>
          )}
          <div className="glass-card chart-card">
            <DataQualityGuard module={t("dq.module.backtestEquity")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
            <div className="panel-header"><h2>{t("bt.equity")}</h2></div>
            <p className="section-note">{t("bt.equity.note")}</p>
            <EquityChart equityCurve={result.equityCurve} benchmarkCurve={benchmarkResult?.equityCurve} />
          </div>
          {underwater?.points?.length > 0 && (
            <div className="glass-card chart-card">
              <UnderwaterChart points={underwater.points} />
              {underwater.recoveries?.length > 0 && (
                <p className="section-note">{t("bt.underwater.recovery")}: {underwater.recoveries.length}</p>
              )}
            </div>
          )}
          {!result.isOptions && result.trades?.length > 0 && lastCandles.length > 0 && (
            <TradeReplay trades={result.trades} candles={lastCandles} precision={market.precision} />
          )}
          {result.isOptions && payoffPoints.length > 0 && (
            <div className="glass-card chart-card">
              <OptionsPayoffChart points={payoffPoints} spot={lastCandles.at(-1)?.close} />
            </div>
          )}
          {!result.isOptions && result.trades.length > 0 && (
            <div className="glass-card table-card">
              <DataQualityGuard module={t("dq.module.backtestTrades")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
              <div className="panel-header"><h2>{t("bt.trades", { n: result.tradeCount })}</h2></div>
              <p className="section-note">{t("bt.trades.note")}</p>
              <BacktestConfigSummary report={report} t={t} lang={lang} />
              <div className="table-scroll">
                <table className="trades-table">
                  <thead>
                    <tr>
                      <th>{t("bt.col.entry")}</th>
                      <th>{t("bt.col.exit")}</th>
                      <th>{t("bt.col.entryPrice")}</th>
                      <th>{t("bt.col.exitPrice")}</th>
                      {isFutures && <th>{t("bt.col.side")}</th>}
                      <th>{t("bt.col.pnl")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice().reverse().map((tr, i) => (
                      <tr key={i}>
                        <td className="num" data-label={t("bt.col.entry")}>{new Date(tr.entryTime * 1000).toLocaleDateString(locale)}</td>
                        <td className="num" data-label={t("bt.col.exit")}>{new Date(tr.exitTime * 1000).toLocaleDateString(locale)}</td>
                        <td className="num" data-label={t("bt.col.entryPrice")}>{formatUsd(tr.entryPrice, market.precision, { mode: "trading" })}</td>
                        <td className="num" data-label={t("bt.col.exitPrice")}>{formatUsd(tr.exitPrice, market.precision, { mode: "trading" })}</td>
                        {isFutures && (
                          <td className="num" data-label={t("bt.col.side")}>
                            <span className={`side-badge side-badge--${tr.side === -1 ? "short" : "long"}`}>
                              {tr.side === -1 ? t("bt.direction.short") : t("bt.direction.long")}
                            </span>
                            {tr.liquidated && <span className="risk-badge risk-badge--liquidated">{t("bt.badgeLiquidated")}</span>}
                          </td>
                        )}
                        <td className={`num ${tr.pnlPercent >= 0 ? "up" : "down"}`} data-label={t("bt.col.pnl")}>{tr.pnlPercent >= 0 ? "+" : ""}{tr.pnlPercent.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {result.isOptions && result.rolls?.length > 0 && (
            <div className="glass-card table-card">
              <div className="panel-header"><h2>{t("bt.options.rolls", { n: result.rolls.length })}</h2></div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("bt.options.col.date")}</th>
                      <th>{t("bt.options.col.action")}</th>
                      <th className="num">{t("bt.options.col.strike")}</th>
                      <th className="num">{t("bt.options.col.vol")}</th>
                      <th className="num">{t("bt.options.col.premium")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rolls.slice().reverse().map((roll, i) => (
                      <tr key={i}>
                        <td data-label={t("bt.options.col.date")}>{new Date(roll.time * 1000).toLocaleDateString(locale)}</td>
                        <td data-label={t("bt.options.col.action")}>{t(`bt.options.action.${roll.action}`)}</td>
                        <td className="num" data-label={t("bt.options.col.strike")}>{formatUsd(roll.strike, market.precision, { mode: "trading" })}</td>
                        <td className="num" data-label={t("bt.options.col.vol")}>{(roll.sigma * 100).toFixed(1)}%</td>
                        <td className="num" data-label={t("bt.options.col.premium")}>{formatUsd(roll.premium, market.precision, { mode: "trading" })}</td>
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
          fitAllParams={fitAllParams}
        />
      )}
    </div>
  );
}

function AggregateResults({ aggregate, t, lang, dataMeta, analysisMarket, market, onInspect, fitAllParams }) {
  const { rows, summary, benchmark, aggregate: ensemble } = aggregate;
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
  const signed = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "-");

  return (
    <div className="aggregate-results reveal">
      <div className="glass-card chart-card">
        <DataQualityGuard module={t("dq.module.backtestAll")} meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
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
            <span className="agg-kpi__label">{t("bt.agg.ensemble")}</span>
            <strong className={`agg-kpi__value num ${ensemble?.result?.totalReturnPercent >= 0 ? "up" : "down"}`}>
              {signed(ensemble?.result?.totalReturnPercent)}%
            </strong>
            <span className="agg-kpi__sub">{t("bt.agg.ensembleHint")}</span>
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
          {summary.liquidated > 0 && (
            <div className="agg-kpi">
              <span className="agg-kpi__label">{t("bt.stat.liquidations")}</span>
              <strong className="agg-kpi__value num down">{summary.liquidated}/{summary.count}</strong>
            </div>
          )}
        </div>
      </div>

      {ensemble?.equityCurve?.length > 1 && (
        <div className="glass-card chart-card">
          <div className="panel-header"><h2>{t("bt.agg.equity")}</h2></div>
          <p className="section-note">{t("bt.agg.equity.note")}</p>
          <div className="stats-grid stats-grid--compact">
            <div className="stat-card">
              <span className="stat-label">{t("bt.agg.ensembleReturn")}</span>
              <span className={`stat-value num ${ensemble.result?.totalReturnPercent >= 0 ? "up" : "down"}`}>
                {signed(ensemble.result?.totalReturnPercent)}%
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">{t("bt.stat.bench")}</span>
              <span className={`stat-value num ${summary.benchmarkReturn >= 0 ? "up" : "down"}`}>{signed(summary.benchmarkReturn)}%</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">{t("bt.stat.dd")}</span>
              <span className="stat-value num down">-{fmt(ensemble.result?.maxDrawdownPercent)}%</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">{t("bt.stat.sharpe")}</span>
              <span className={`stat-value num ${Number.isFinite(ensemble.result?.sharpe) && ensemble.result.sharpe >= 1 ? "up" : ""}`}>
                {fmt(ensemble.result?.sharpe, 2)}
              </span>
            </div>
          </div>
          <EquityChart
            equityCurve={ensemble.equityCurve}
            benchmarkCurve={benchmark?.equityCurve}
            strategyTitle={t("bt.equity.aggregate")}
            benchmarkTitle={t("bt.equity.benchmark")}
          />
        </div>
      )}

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
                {summary.liquidated > 0 && <th>{t("bt.stat.liquidations")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.key} className="agg-row" onClick={() => onInspect(row.key)} title={t("bt.agg.hint")}>
                  <td className="num agg-table__rank" data-label={t("bt.agg.col.rank")}>{i + 1}</td>
                  <td className="agg-table__name" data-label={t("bt.agg.col.strategy")}>
                    <span className="agg-name">{pick(lang, row.label)}</span>
                    <small>{t(`cat.${row.category}`)}</small>
                    {fitAllParams?.[row.key] && <small className="control-hint control-hint--accent">{t("bt.agg.fitted")}</small>}
                  </td>
                  <td className={`num ${row.result.totalReturnPercent >= 0 ? "up" : "down"}`} data-label={t("bt.stat.return")}>{signed(row.result.totalReturnPercent)}%</td>
                  <td className={`num ${row.excessReturn >= 0 ? "up" : "down"}`} data-label={t("bt.agg.col.excess")}>{signed(row.excessReturn)}%</td>
                  <td className="num down" data-label={t("bt.stat.dd")}>-{fmt(row.result.maxDrawdownPercent)}%</td>
                  <td className="num" data-label={t("bt.stat.winrate")}>{Number.isFinite(row.result.winRate) ? `${fmt(row.result.winRate, 0)}%` : "-"}</td>
                  <td className={`num ${Number.isFinite(row.result.sharpe) && row.result.sharpe >= 1 ? "up" : ""}`} data-label={t("bt.stat.sharpe")}>{fmt(row.result.sharpe, 2)}</td>
                  <td className="num" data-label={t("bt.stat.pf")}>{row.result.profitFactor === Infinity ? "∞" : fmt(row.result.profitFactor, 2)}</td>
                  <td className="num" data-label={t("bt.stat.trades")}>{row.result.tradeCount}</td>
                  {summary.liquidated > 0 && (
                    <td className="num" data-label={t("bt.stat.liquidations")}>
                      {row.result.wasLiquidated ? <span className="risk-badge risk-badge--liquidated">{t("bt.badgeLiquidated")}</span> : "-"}
                    </td>
                  )}
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

function ControlsSection({ id, title, badge, collapsed, onToggle, children }) {
  const isCollapsible = typeof onToggle === "function";
  return (
    <div className={`controls-section${collapsed ? " is-collapsed" : ""}`} data-section={id}>
      {isCollapsible ? (
        <button type="button" className="controls-section__header" onClick={onToggle} aria-expanded={!collapsed}>
          <span className="controls-section__title">
            {title}
            {badge && <span className="controls-section__badge">{badge}</span>}
          </span>
          <span className="controls-section__chevron">▾</span>
        </button>
      ) : (
        <div className="controls-section__header" style={{ cursor: "default" }}>
          <span className="controls-section__title">{title}</span>
        </div>
      )}
      {!collapsed && <div className="controls-section__body">{children}</div>}
    </div>
  );
}

// Shows where the strategy stands on the most recent candle, distinct from
// the historical equity curve above — answers "is this rule saying to be
// in a position right now, and since when" rather than only "how did it do
// in the past". Still not a forward guarantee: it's the mechanical output
// of the same deterministic rule, evaluated on the latest data point.
// A quick "what exactly was this run?" strip — strategy, every tuned
// parameter, direction, leverage, fee, and risk exits — placed right above
// the trade list so it's never ambiguous which configuration produced
// these numbers (important once params get fitted/changed across runs).
function BacktestConfigSummary({ report, t, lang }) {
  if (!report) return null;
  const paramEntries = Object.entries(report.params || {});
  return (
    <div className="backtest-config-summary">
      <span className="config-chip config-chip--strategy">{report.strategyLabel}</span>
      <span className="config-chip">{t(`bt.direction.${report.direction}`, undefined) || report.direction}</span>
      {report.leverage > 1 && <span className="config-chip">{report.leverage}x</span>}
      <span className="config-chip">{t("bt.config.fee", { fee: report.fee })}</span>
      {paramEntries.map(([key, value]) => (
        <span className="config-chip config-chip--param" key={key}>
          {pick(lang, PARAM_LABELS[key]) || key}: {String(value)}
        </span>
      ))}
      {report.riskParams?.stopLossPercent != null && (
        <span className="config-chip config-chip--risk">{t("bt.config.sl", { pct: report.riskParams.stopLossPercent })}</span>
      )}
      {report.riskParams?.takeProfitPercent != null && (
        <span className="config-chip config-chip--risk">{t("bt.config.tp", { pct: report.riskParams.takeProfitPercent })}</span>
      )}
      {!report.riskParams && <span className="config-chip config-chip--muted">{t("bt.config.noRisk")}</span>}
    </div>
  );
}

function LiveSignalCard({ liveSignal, direction, t, locale }) {
  const { state, changedAtTime, lastCandleTime } = liveSignal;
  const changedDate = changedAtTime ? new Date(changedAtTime * 1000).toLocaleString(locale) : null;
  const asOfDate = lastCandleTime ? new Date(lastCandleTime * 1000).toLocaleString(locale) : null;
  return (
    <div className={`glass-card live-signal-card reveal live-signal-card--${state}`}>
      <div className="panel-header"><h2>{t("bt.live.title")}</h2></div>
      <p className="section-note">{t("bt.live.note")}</p>
      <div className="live-signal-state">
        <span className={`side-badge side-badge--${state === "short" ? "short" : state === "long" ? "long" : "flat"}`}>
          {t(`bt.live.state.${state}`)}
        </span>
        {state !== "flat" && (
          <span className="control-hint">{t("bt.live.since", { date: changedDate || "-" })}</span>
        )}
      </div>
      <small className="control-hint">{t("bt.live.asOf", { date: asOfDate || "-" })}</small>
      {direction === "long" && state === "flat" && <small className="control-hint">{t("bt.live.longOnlyFlat")}</small>}
    </div>
  );
}

function Stat({ label, value, suffix = "", prefix = "", decimals = 1, tone = "", abs = false, fallback = "-", tip }) {
  const animated = useCountUp(Number.isFinite(value) ? (abs ? Math.abs(value) : value) : 0, { decimals });
  const display = Number.isFinite(value) ? `${prefix}${animated.toFixed(decimals)}${suffix}` : fallback;
  return (
    <div className="stat-card reveal">
      <span className="stat-label">
        {label}
        {tip ? <InfoTip term={tip} /> : null}
      </span>
      <span className={`stat-value num ${tone}`}>{display}</span>
    </div>
  );
}
