import { useState } from "react";
import { positionSize, riskRewardRatio, calculateATR, atrStopSuggestion } from "../lib/risk";
import { getCandles } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";
import { useStaggerReveal } from "../hooks/useAnimations";

export default function RiskTools() {
  const reveal = useStaggerReveal([]);
  return (
    <div className="risk-page" ref={reveal}>
      <div className="disclaimer-banner reveal">
        این ابزارها فقط محاسبات ریاضی استاندارد مدیریت ریسک را انجام می‌دهند — هیچ‌کدام پیش‌بینی
        قیمت یا توصیه‌ی معاملاتی ارائه نمی‌دهند. تمام اعداد ورودی را خودتان تعیین می‌کنید.
      </div>
      <div className="risk-grid">
        <PositionSizeCalculator />
        <ATRStopCalculator />
        <RiskRewardCalculator />
      </div>
    </div>
  );
}

function PositionSizeCalculator() {
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
      <h3>محاسبه‌گر حجم پوزیشن</h3>
      <p className="card-hint">بر اساس درصد ریسک ثابت از کل حساب</p>

      <Field label="حجم کل حساب ($)" value={accountSize} onChange={setAccountSize} type="number" />
      <Field label="درصد ریسک در این معامله (%)" value={riskPercent} onChange={setRiskPercent} type="number" step="0.1" />
      <Field label="قیمت ورود ($)" value={entryPrice} onChange={setEntryPrice} type="number" />
      <Field label="قیمت حد ضرر ($)" value={stopPrice} onChange={setStopPrice} type="number" />

      {result && !result.error && (
        <div className="result-box">
          <Row label="مقدار ریسک" value={`$${result.riskAmount.toFixed(2)}`} />
          <Row label="حجم قابل خرید" value={`${result.units.toFixed(6)} واحد`} />
          <Row label="ارزش پوزیشن" value={`$${result.positionValue.toFixed(2)}`} />
          <Row label="درصد از کل حساب" value={`${result.positionPercentOfAccount.toFixed(1)}%`} />
        </div>
      )}
      {result?.error && <p className="news-error">{result.error}</p>}
    </div>
  );
}

function ATRStopCalculator() {
  const { coin } = useCoin();
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
      <h3>پیشنهاد حد ضرر بر اساس نوسان (ATR)</h3>
      <p className="card-hint">حد ضرر متناسب با نوسان واقعی بازار، نه درصد دلخواه</p>

      <button className="run-btn" onClick={handleCalculate} disabled={loading}>
        {loading ? "در حال محاسبه…" : `دریافت ATR برای ${coin.symbol}`}
      </button>
      {error && <p className="news-error">{error}</p>}
      {atr && <Row label="ATR (۱۴ دوره)" value={`$${atr.toFixed(2)}`} />}

      <Field label="قیمت ورود ($)" value={entryPrice} onChange={setEntryPrice} type="number" />
      <div className="control-group">
        <label>ضریب ATR</label>
        <input type="number" step="0.5" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
      </div>
      <div className="control-group">
        <label>جهت پوزیشن</label>
        <select value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="long">لانگ (خرید)</option>
          <option value="short">شورت (فروش)</option>
        </select>
      </div>

      {suggestion && (
        <div className="result-box">
          <Row label="فاصله پیشنهادی" value={`$${suggestion.distance.toFixed(2)}`} />
          <Row label="قیمت حد ضرر پیشنهادی" value={`$${suggestion.stopPrice.toFixed(2)}`} />
        </div>
      )}
    </div>
  );
}

function RiskRewardCalculator() {
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
      <h3>نسبت ریسک به ریوارد</h3>
      <p className="card-hint">آیا پتانسیل سود این معامله نسبت به ریسکش منطقی است؟</p>

      <Field label="قیمت ورود ($)" value={entryPrice} onChange={setEntryPrice} type="number" />
      <Field label="قیمت حد ضرر ($)" value={stopPrice} onChange={setStopPrice} type="number" />
      <Field label="قیمت هدف ($)" value={targetPrice} onChange={setTargetPrice} type="number" />

      {ratio != null && (
        <div className="result-box">
          <Row label="نسبت R:R" value={`۱ : ${ratio.toFixed(2)}`} />
          <p className="card-hint">
            {ratio >= 2
              ? "نسبت قابل‌قبول — ریوارد حداقل دو برابر ریسک است (معیار رایج، نه قانون قطعی)."
              : "نسبت کمتر از معیار رایج ۱:۲ — بسته به نرخ برد استراتژی ممکن است منطقی باشد یا نباشد."}
          </p>
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
