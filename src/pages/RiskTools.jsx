import { useState } from "react";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../lib/risk";
import { getChartCandles } from "../lib/coingecko";
import { formatPrice, formatUsd } from "../lib/priceFormat";
import { qualityMetaFromError } from "../lib/dataQuality";
import MarketContextBar from "../components/MarketContextBar";
import DataQualityGuard from "../components/DataQualityGuard";
import { useCoin } from "../context/coinStore";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";
import InfoTip from "../components/InfoTip";

export default function RiskTools() {
  const { t } = useI18n();
  const reveal = useStaggerReveal([]);
  return (
    <div className="risk-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("risk.disclaimer")}</div>
      <MarketContextBar module="Risk Engine" />
      <div className="risk-grid">
        <PositionSizeCalculator />
        <ATRStopCalculator />
        <RiskRewardCalculator />
      </div>
    </div>
  );
}

function PositionSizeCalculator() {
  const { market } = useMarket();
  const { t } = useI18n();
  const [accountSize, setAccountSize] = useState(1000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const result =
    entryPrice && stopPrice
      ? positionSize({ accountSize: Number(accountSize), riskPercent: Number(riskPercent), entryPrice: Number(entryPrice), stopPrice: Number(stopPrice) })
      : null;
  return (
    <div className="risk-card glass-card reveal">
      <MarketContextBar module="Position size" />
      <h3>
        {t("risk.pos.title")}
        <InfoTip term="glossary.positionSize" />
      </h3>
      <p className="card-hint">{t("risk.pos.hint")}</p>
      <Field label={t("risk.pos.account")} value={accountSize} onChange={setAccountSize} type="number" />
      <Field label={t("risk.pos.riskPct")} value={riskPercent} onChange={setRiskPercent} type="number" step="0.1" />
      <Field label={t("risk.pos.entry")} value={entryPrice} onChange={setEntryPrice} type="number" step="any" />
      <Field label={t("risk.pos.stop")} value={stopPrice} onChange={setStopPrice} type="number" step="any" />
      {result && !result.error && (
        <div className="result-box">
          <Row label={t("risk.pos.riskAmt")} value={formatUsd(result.riskAmount)} />
          <Row label={t("risk.pos.units")} value={`${formatPrice(result.units, { stepSize: market.precision.stepSize }, { mode: "trading" })} ${t("risk.pos.units.suffix")}`} />
          <Row label={t("risk.pos.value")} value={formatUsd(result.positionValue)} />
          <Row label={t("risk.pos.pctAcct")} value={`${result.positionPercentOfAccount.toFixed(1)}%`} />
        </div>
      )}
      {result?.error && <p className="news-error">{result.error}</p>}
    </div>
  );
}

function ATRStopCalculator() {
  const { coin } = useCoin();
  const { market, updateFromCandles } = useMarket();
  const { t } = useI18n();
  const [entryPrice, setEntryPrice] = useState("");
  const [multiplier, setMultiplier] = useState(2);
  const [direction, setDirection] = useState("long");
  const [atr, setAtr] = useState(null);
  const [dataMeta, setDataMeta] = useState(null);
  const [analysisMarket, setAnalysisMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleCalculate() {
    setLoading(true);
    setError(null);
    try {
      const candles = await getChartCandles({ id: coin.id, symbol: coin.symbol, timeframe: market.timeframe, source: market.exchange, pair: market.pair, marketType: market.marketType });
      updateFromCandles(candles);
      setDataMeta(candles.meta || null);
      setAnalysisMarket(snapshotMarket(market));
      setAtr(calculateATR(candles, 14));
    } catch (err) {
      setError(err.message);
      setDataMeta(qualityMetaFromError(err, market.exchange));
      setAnalysisMarket(null);
    } finally {
      setLoading(false);
    }
  }

  const suggestion = atr && entryPrice ? atrStopSuggestion({ entryPrice: Number(entryPrice), atr, multiplier: Number(multiplier), direction }) : null;

  return (
    <div className="risk-card glass-card reveal">
      <MarketContextBar module="ATR stop" />
      <DataQualityGuard module="ATR stop" meta={dataMeta} expectedTimeframe={analysisMarket?.timeframe || market.timeframe} analysisMarket={analysisMarket} />
      <h3>
        {t("risk.atr.title")}
        <InfoTip term="glossary.atr" />
      </h3>
      <p className="card-hint">{t("risk.atr.hint")}</p>
      <button className="run-btn" onClick={handleCalculate} disabled={loading}>
        {loading ? t("risk.atr.calculating") : t("risk.atr.get", { sym: coin.symbol })}
      </button>
      {error && <p className="news-error">{error}</p>}
      {atr && <Row label={t("risk.atr.value")} value={formatUsd(atr, market.precision, { mode: "futures" })} />}
      <Field label={t("risk.atr.entry")} value={entryPrice} onChange={setEntryPrice} type="number" step="any" />
      <div className="control-group">
        <label>
          {t("risk.atr.mult")}
          <InfoTip term="glossary.atr" />
        </label>
        <input type="number" step="0.5" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
      </div>
      <div className="control-group">
        <label>{t("risk.atr.dir")}</label>
        <select value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="long">{t("risk.atr.long")}</option>
          <option value="short">{t("risk.atr.short")}</option>
        </select>
      </div>
      {suggestion && (
        <div className="result-box">
          <Row label={t("risk.atr.dist")} value={formatUsd(suggestion.distance, market.precision, { mode: "futures" })} />
          <Row label={t("risk.atr.stop")} value={formatUsd(suggestion.stopPrice, market.precision, { mode: "futures" })} />
        </div>
      )}
    </div>
  );
}

function RiskRewardCalculator() {
  const { market } = useMarket();
  const { t } = useI18n();
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const ratio = entryPrice && stopPrice && targetPrice ? riskRewardRatio({ entryPrice: Number(entryPrice), stopPrice: Number(stopPrice), targetPrice: Number(targetPrice) }) : null;
  return (
    <div className="risk-card glass-card reveal">
      <MarketContextBar module="Risk reward" />
      <h3>
        {t("risk.rr.title")}
        <InfoTip term="glossary.riskRewardTool" />
      </h3>
      <p className="card-hint">{t("risk.rr.hint")}</p>
      <Field label={t("risk.rr.entry")} value={entryPrice} onChange={setEntryPrice} type="number" step="any" />
      <Field label={t("risk.rr.stop")} value={stopPrice} onChange={setStopPrice} type="number" step="any" />
      <Field label={t("risk.rr.target")} value={targetPrice} onChange={setTargetPrice} type="number" step="any" />
      {ratio != null && (
        <div className="result-box">
          <Row label={t("risk.rr.ratio")} value={`1 : ${ratio.toFixed(2)}`} />
          <Row label="Entry" value={formatUsd(entryPrice, market.precision, { mode: "trading" })} />
          <Row label="Stop" value={formatUsd(stopPrice, market.precision, { mode: "futures" })} />
          <Row label="Target" value={formatUsd(targetPrice, market.precision, { mode: "futures" })} />
          <p className="card-hint">{ratio >= 2 ? t("risk.rr.good") : t("risk.rr.bad")}</p>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = "text", step }) {
  return (
    <div className="control-group">
      <label>{label}</label>
      <input type={type} step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="result-row">
      <span>{label}</span>
      <span className="num">{value}</span>
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
