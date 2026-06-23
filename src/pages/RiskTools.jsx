import { useState } from "react";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../lib/risk";
import { getCandles } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";

export default function RiskTools() {
  const { t } = useI18n();
  const reveal = useStaggerReveal([]);
  return (
    <div className="risk-page" ref={reveal}>
      <div className="disclaimer-banner reveal">{t("risk.disclaimer")}</div>
      <div className="risk-grid">
        <PositionSizeCalculator />
        <ATRStopCalculator />
        <RiskRewardCalculator />
      </div>
    </div>
  );
}

function PositionSizeCalculator() {
  const { t } = useI18n();
  const [accountSize, setAccountSize] = useState(1000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const result =
    entryPrice && stopPrice
      ? positionSize({
          accountSize: Number(accountSize),
          riskPercent: Number(riskPercent),
          entryPrice: Number(entryPrice),
          stopPrice: Number(stopPrice),
        })
      : null;

  return (
    <div className="risk-card glass-card reveal">
      <h3>{t("risk.pos.title")}</h3>
      <p className="card-hint">{t("risk.pos.hint")}</p>

      <Field label={t("risk.pos.account")} value={accountSize} onChange={setAccountSize} type="number" />
      <Field label={t("risk.pos.riskPct")} value={riskPercent} onChange={setRiskPercent} type="number" step="0.1" />
      <Field label={t("risk.pos.entry")} value={entryPrice} onChange={setEntryPrice} type="number" />
      <Field label={t("risk.pos.stop")} value={stopPrice} onChange={setStopPrice} type="number" />

      {result && !result.error && (
        <div className="result-box">
          <Row label={t("risk.pos.riskAmt")} value={`$${result.riskAmount.toFixed(2)}`} />
          <Row label={t("risk.pos.units")} value={`${result.units.toFixed(6)} ${t("risk.pos.units.suffix")}`} />
          <Row label={t("risk.pos.value")} value={`$${result.positionValue.toFixed(2)}`} />
          <Row label={t("risk.pos.pctAcct")} value={`${result.positionPercentOfAccount.toFixed(1)}%`} />
        </div>
      )}
      {result?.error && <p className="news-error">{result.error}</p>}
    </div>
  );
}

function ATRStopCalculator() {
  const { coin } = useCoin();
  const { t } = useI18n();
  const [entryPrice, setEntryPrice] = useState("");
  const [multiplier, setMultiplier] = useState(2);
  const [direction, setDirection] = useState("long");
  const [atr, setAtr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleCalculate() {
    setLoading(true);
    setError(null);
    try {
      const candles = await getCandles(coin.id, 30);
      setAtr(calculateATR(candles, 14));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const suggestion =
    atr && entryPrice
      ? atrStopSuggestion({ entryPrice: Number(entryPrice), atr, multiplier: Number(multiplier), direction })
      : null;

  return (
    <div className="risk-card glass-card reveal">
      <h3>{t("risk.atr.title")}</h3>
      <p className="card-hint">{t("risk.atr.hint")}</p>

      <button className="run-btn" onClick={handleCalculate} disabled={loading}>
        {loading ? t("risk.atr.calculating") : t("risk.atr.get", { sym: coin.symbol })}
      </button>
      {error && <p className="news-error">{error}</p>}
      {atr && <Row label={t("risk.atr.value")} value={`$${atr.toFixed(2)}`} />}

      <Field label={t("risk.atr.entry")} value={entryPrice} onChange={setEntryPrice} type="number" />
      <div className="control-group">
        <label>{t("risk.atr.mult")}</label>
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
          <Row label={t("risk.atr.dist")} value={`$${suggestion.distance.toFixed(2)}`} />
          <Row label={t("risk.atr.stop")} value={`$${suggestion.stopPrice.toFixed(2)}`} />
        </div>
      )}
    </div>
  );
}

function RiskRewardCalculator() {
  const { t } = useI18n();
  const [entryPrice, setEntryPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");

  const ratio =
    entryPrice && stopPrice && targetPrice
      ? riskRewardRatio({
          entryPrice: Number(entryPrice),
          stopPrice: Number(stopPrice),
          targetPrice: Number(targetPrice),
        })
      : null;

  return (
    <div className="risk-card glass-card reveal">
      <h3>{t("risk.rr.title")}</h3>
      <p className="card-hint">{t("risk.rr.hint")}</p>

      <Field label={t("risk.rr.entry")} value={entryPrice} onChange={setEntryPrice} type="number" />
      <Field label={t("risk.rr.stop")} value={stopPrice} onChange={setStopPrice} type="number" />
      <Field label={t("risk.rr.target")} value={targetPrice} onChange={setTargetPrice} type="number" />

      {ratio != null && (
        <div className="result-box">
          <Row label={t("risk.rr.ratio")} value={`1 : ${ratio.toFixed(2)}`} />
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
