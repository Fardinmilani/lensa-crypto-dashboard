import { useState } from "react";
import { STRATEGIES, PARAM_LABELS } from "../lib/strategies";
import { runBacktest } from "../lib/backtest";
import { getCandles } from "../lib/coingecko";
import EquityChart from "../components/EquityChart";
import TimeframePicker from "../components/TimeframePicker";
import { useCoin } from "../context/coinStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";

const CATEGORY_ORDER = ["روند", "مومنتوم", "بازگشتی", "ترکیبی"];

export default function Backtest() {
  const { coin } = useCoin();
  const [strategyKey, setStrategyKey] = useState("trendMomentumHybrid");
  const [days, setDays] = useState(180);
  const [params, setParams] = useState(STRATEGIES.trendMomentumHybrid.params);
  const [fee, setFee] = useState(0.1);
  const [result, setResult] = useState(null);
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reveal = useStaggerReveal([result, error]);

  const strategy = STRATEGIES[strategyKey];

  function handleStrategyChange(key) {
    setStrategyKey(key);
    setParams(STRATEGIES[key].params);
    setResult(null);
  }

  function handleParamChange(name, value) {
    setParams((prev) => ({ ...prev, [name]: Number(value) }));
  }

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const candles = await getCandles(coin.id, days);
      if (candles.length < 30) throw new Error("داده‌ی تاریخی کافی برای این بازه دریافت نشد.");
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
    } finally {
      setLoading(false);
    }
  }

  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: Object.entries(STRATEGIES).filter(([, s]) => s.category === cat),
  }));

  return (
    <div className="backtest-page" ref={reveal}>
      <div className="disclaimer-banner reveal">
        نتایج بک‌تست عملکرد یک قانون مشخص را روی داده‌های <strong>گذشته</strong> نشان می‌دهد.
        این پیش‌بینی عملکرد آینده نیست و نباید مستقیماً مبنای تصمیم معاملاتی قرار گیرد.
      </div>

      <div className="backtest-controls glass-card reveal">
        <div className="control-group control-group--wide">
          <label>رمزارز فعال</label>
          <div className="active-coin-chip">
            {coin.thumb && <img src={coin.thumb} alt="" width="18" height="18" />}
            <strong>{coin.symbol}</strong>
            <span>{coin.name}</span>
            <span className="active-coin-chip__hint">از نوار بالا قابل تغییر است</span>
          </div>
        </div>

        <div className="control-group control-group--wide">
          <label>استراتژی</label>
          <select value={strategyKey} onChange={(e) => handleStrategyChange(e.target.value)}>
            {grouped.map((g) => (
              <optgroup key={g.cat} label={g.cat}>
                {g.items.map(([key, s]) => (
                  <option key={key} value={key}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>کارمزد هر معامله (%)</label>
          <input type="number" step="0.05" value={fee} onChange={(e) => setFee(e.target.value)} />
        </div>

        {Object.entries(params).map(([name, value]) => (
          <div className="control-group" key={name}>
            <label>{PARAM_LABELS[name] || name}</label>
            <input type="number" value={value} onChange={(e) => handleParamChange(name, e.target.value)} />
          </div>
        ))}

        <div className="control-group control-group--full">
          <label>بازه زمانی (هر مقداری مجاز است)</label>
          <TimeframePicker value={days} onChange={setDays} />
        </div>

        <button className="run-btn" onClick={handleRun} disabled={loading}>
          {loading ? "در حال اجرا…" : "اجرای بک‌تست"}
        </button>
      </div>

      <p className="strategy-description reveal">{strategy.description}</p>

      {error && <p className="news-error reveal">{error}</p>}

      {result && (
        <div className="backtest-results">
          <div className="stats-grid">
            <Stat label="بازده استراتژی" value={result.totalReturnPercent} suffix="%" tone={result.totalReturnPercent >= 0 ? "up" : "down"} />
            <Stat label="خرید و نگهداری" value={result.benchmarkReturnPercent} suffix="%" tone={result.benchmarkReturnPercent >= 0 ? "up" : "down"} />
            <Stat label="بیشینه افت" value={result.maxDrawdownPercent} suffix="%" tone="down" prefix="−" abs />
            <Stat label="نرخ برد" value={result.winRate} suffix="%" decimals={0} />
            <Stat label="نسبت شارپ" value={result.sharpe} decimals={2} tone={result.sharpe >= 1 ? "up" : ""} />
            <Stat label="نسبت سورتینو" value={result.sortino} decimals={2} />
            <Stat label="فاکتور سود" value={isFinite(result.profitFactor) ? result.profitFactor : null} decimals={2} fallback={result.profitFactor === Infinity ? "∞" : "—"} />
            <Stat label="امید ریاضی/معامله" value={result.expectancy} suffix="%" decimals={2} tone={(result.expectancy ?? 0) >= 0 ? "up" : "down"} />
            <Stat label="میانگین برد" value={result.avgWin} suffix="%" decimals={2} tone="up" />
            <Stat label="میانگین باخت" value={result.avgLoss} suffix="%" decimals={2} tone="down" />
            <Stat label="تعداد معاملات" value={result.tradeCount} decimals={0} />
            <Stat label="زمان در بازار" value={result.exposurePercent} suffix="%" decimals={0} />
          </div>

          <div className="glass-card chart-card">
            <div className="panel-header"><h2>منحنی سرمایه</h2></div>
            <EquityChart equityCurve={result.equityCurve} benchmarkCurve={benchmarkResult?.equityCurve} />
          </div>

          {result.trades.length > 0 && (
            <div className="glass-card table-card">
              <div className="panel-header"><h2>معاملات ({result.tradeCount})</h2></div>
              <div className="table-scroll">
                <table className="trades-table">
                  <thead>
                    <tr>
                      <th>ورود</th>
                      <th>خروج</th>
                      <th>قیمت ورود</th>
                      <th>قیمت خروج</th>
                      <th>سود/ضرر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i}>
                        <td className="num">{new Date(t.entryTime * 1000).toLocaleDateString("fa-IR")}</td>
                        <td className="num">{new Date(t.exitTime * 1000).toLocaleDateString("fa-IR")}</td>
                        <td className="num">${t.entryPrice.toFixed(2)}</td>
                        <td className="num">${t.exitPrice.toFixed(2)}</td>
                        <td className={`num ${t.pnlPercent >= 0 ? "up" : "down"}`}>
                          {t.pnlPercent >= 0 ? "+" : ""}{t.pnlPercent.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, suffix = "", prefix = "", decimals = 1, tone = "", abs = false, fallback = "—" }) {
  const animated = useCountUp(Number.isFinite(value) ? (abs ? Math.abs(value) : value) : 0, { decimals });
  const display = Number.isFinite(value) ? `${prefix}${animated.toFixed(decimals)}${suffix}` : fallback;
  return (
    <div className="stat-card reveal">
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${tone}`}>{display}</span>
    </div>
  );
}
