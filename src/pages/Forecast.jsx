import { useState } from "react";
import { getCandles } from "../lib/coingecko";
import { monteCarlo, outcomeZones, tradeSetups, annualizedVol } from "../lib/forecast";
import ConeChart from "../components/ConeChart";
import TimeframePicker from "../components/TimeframePicker";
import { useCoin } from "../context/coinStore";
import { useStaggerReveal, useCountUp } from "../hooks/useAnimations";

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
  { label: "سریع", sims: 1000 },
  { label: "متعادل", sims: 3000 },
  { label: "دقیق", sims: 8000 },
];

export default function Forecast() {
  const { coin } = useCoin();
  const [days, setDays] = useState(90);
  const [horizon, setHorizon] = useState(30);
  const [method, setMethod] = useState("bootstrap");
  const [driftMode, setDriftMode] = useState("historical");
  const [sims, setSims] = useState(3000);
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
      if (candles.length < 20) throw new Error("داده‌ی کافی برای شبیه‌سازی موجود نیست.");
      const closes = candles.map((c) => c.close);
      const stepSeconds = Math.max(1, candles[1].time - candles[0].time);

      const sim = monteCarlo({ closes, horizon: Number(horizon), sims, method, driftMode });
      if (sim.error) throw new Error(sim.error);

      const periodsPerYear = (365 * 86400) / stepSeconds;
      const histTail = candles.slice(-Math.min(candles.length, Math.max(40, horizon)));
      setMc(sim);
      setExtra({
        zones: outcomeZones(sim, 7),
        setups: tradeSetups(sim),
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

  return (
    <div className="forecast-page" ref={reveal}>
      <div className="disclaimer-banner reveal">
        این بخش یک <strong>توزیع احتمالی</strong> از مسیرهای ممکن قیمت را با شبیه‌سازی مونت‌کارلو بر پایه‌ی
        نوسان تاریخی همین دارایی می‌سازد. هیچ عددی «پیش‌بینی قطعی» نیست؛ آینده می‌تواند خارج از هر بازه‌ی
        شبیه‌سازی‌شده رخ دهد. صرفاً ابزار آموزشی و تحلیلی است، نه توصیه‌ی مالی.
      </div>

      <div className="backtest-controls glass-card reveal">
        <div className="control-group control-group--wide">
          <label>رمزارز فعال</label>
          <div className="active-coin-chip">
            {coin.thumb && <img src={coin.thumb} alt="" width="18" height="18" />}
            <strong>{coin.symbol}</strong>
            <span>{coin.name}</span>
          </div>
        </div>

        <div className="control-group">
          <label>افق پیش‌بینی (تعداد کندل)</label>
          <input type="number" min="5" max="365" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
        </div>

        <div className="control-group">
          <label>روش شبیه‌سازی</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="bootstrap">بوت‌استرپ تاریخی</option>
            <option value="gbm">حرکت براونی هندسی (نرمال)</option>
          </select>
        </div>

        <div className="control-group">
          <label>روند (drift)</label>
          <select value={driftMode} onChange={(e) => setDriftMode(e.target.value)}>
            <option value="historical">بر پایه روند تاریخی</option>
            <option value="zero">بدون فرض روند (محافظه‌کار)</option>
          </select>
        </div>

        <div className="control-group">
          <label>دقت</label>
          <select value={sims} onChange={(e) => setSims(Number(e.target.value))}>
            {PRECISION.map((p) => (
              <option key={p.sims} value={p.sims}>{p.label} ({p.sims.toLocaleString("en-US")} مسیر)</option>
            ))}
          </select>
        </div>

        <div className="control-group control-group--full">
          <label>بازه داده‌ی تاریخی (تخمین نوسان) — هر تایم‌فریمی</label>
          <TimeframePicker value={days} onChange={setDays} />
        </div>

        <button className="run-btn" onClick={handleRun} disabled={loading}>
          {loading ? "در حال شبیه‌سازی…" : "اجرای شبیه‌سازی"}
        </button>
      </div>

      {error && <p className="news-error reveal">{error}</p>}

      {mc && extra && (
        <>
          <div className="forecast-hl">
            <HlCard label="احتمال سود" value={mc.probProfit * 100} suffix="%" decimals={0} tone={mc.probProfit >= 0.5 ? "up" : "down"} hint={`در افق ~${extra.horizonDaysApprox.toFixed(1)} روز`} />
            <HlCard label="بازده مورد انتظار" value={mc.expectedReturnPct} suffix="%" decimals={1} tone={mc.expectedReturnPct >= 0 ? "up" : "down"} hint="میانگین همه مسیرها" />
            <HlCard label="سناریو خوش‌بینانه (P95)" value={mc.upside95Pct} suffix="%" decimals={1} tone="up" hint={fmtPrice(mc.dist.p95)} />
            <HlCard label="ریسک نزولی (P5 / VaR)" value={mc.var5Pct} suffix="%" decimals={1} tone="down" hint={fmtPrice(mc.dist.p5)} />
            <HlCard label="نوسان سالانه" value={extra.annVol} suffix="%" decimals={0} hint="نوسان واقعی‌شده" />
          </div>

          <div className="glass-card chart-card reveal">
            <div className="panel-header">
              <div>
                <h2>مخروط احتمال قیمت</h2>
                <span className="panel-subtitle">باند بنفش = محدوده‌ی محتمل (۲۵٪ تا ۷۵٪)، خط‌چین = ۵٪ تا ۹۵٪، خط طلایی = میانه</span>
              </div>
            </div>
            <ConeChart history={extra.history} cone={mc.cone} stepSeconds={extra.stepSeconds} />
          </div>

          <div className="forecast-cols">
            <div className="glass-card reveal">
              <div className="panel-header">
                <div>
                  <h2>ناحیه‌بندی و احتمال وقوع</h2>
                  <span className="panel-subtitle">احتمال اینکه قیمت پایانی در هر ناحیه قرار بگیرد</span>
                </div>
              </div>
              <div className="zones">
                {extra.zones.map((z, i) => (
                  <div className="zone-row" key={i}>
                    <span className={`zone-range num ${z.changePct >= 0 ? "up" : "down"}`}>
                      {fmtPrice(z.mid)} <small>({pct(z.changePct, 0)})</small>
                    </span>
                    <div className="zone-bar-track">
                      <div
                        className={`zone-bar ${z.changePct >= 0 ? "zone-bar--up" : "zone-bar--down"}`}
                        style={{ width: `${Math.max(2, z.probability * 100)}%` }}
                      />
                    </div>
                    <span className="zone-prob num">{(z.probability * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass-card reveal">
              <div className="panel-header">
                <div>
                  <h2>ستاپ‌های ریسک‌به‌ریوارد</h2>
                  <span className="panel-subtitle">حد سود/ضرر بر پایه‌ی نوسان، با احتمال لمس هر سطح</span>
                </div>
              </div>
              <div className="table-scroll">
                <table className="trades-table setups-table">
                  <thead>
                    <tr>
                      <th>هدف</th>
                      <th>حد ضرر</th>
                      <th>R:R</th>
                      <th>P(هدف)</th>
                      <th>P(ضرر)</th>
                      <th>ارزش مورد انتظار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extra.setups.map((s, i) => (
                      <tr key={i}>
                        <td className="num up">{fmtPrice(s.target)}<br /><small>{pct(s.targetPct)}</small></td>
                        <td className="num down">{fmtPrice(s.stop)}<br /><small>{pct(s.stopPct)}</small></td>
                        <td className="num"><strong>۱:{s.rr?.toFixed(2)}</strong></td>
                        <td className="num up">{(s.pTarget * 100).toFixed(0)}%</td>
                        <td className="num down">{(s.pStop * 100).toFixed(0)}%</td>
                        <td className={`num ${(s.ev ?? 0) >= 0 ? "up" : "down"}`}>{s.ev?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="card-hint">
                «ارزش مورد انتظار» = احتمال رسیدن به هدف × R:R منهای احتمال خوردن حد ضرر. مقدار مثبت یعنی
                ستاپ از منظر آماری به‌صرفه‌تر است (نه تضمین سود).
              </p>
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
