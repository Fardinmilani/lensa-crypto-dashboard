import { useState } from "react";
import { STRATEGIES } from "../lib/strategies";
import { useI18n } from "../i18n/langStore";

// Rich documentation for every strategy in STRATEGIES. Supplements the
// one-line `description` already stored on each strategy object with:
//   - how the entry/exit signal is generated (in plain words)
//   - which market conditions it works well in
//   - which market conditions it struggles in
//   - which parameters matter most and how to tune them
//   - whether it supports short direction in the backtest engine
const STRATEGY_DOCS = {
  smaCrossover: {
    category_label: { en: "Trend following", fa: "پیرو روند" },
    entry: {
      en: "Long when the fast SMA (default: 10) crosses above the slow SMA (default: 30). Exit when the fast crosses back below the slow. No short entry in the base version.",
      fa: "لانگ وقتی SMA سریع (پیش‌فرض: ۱۰) از SMA کند (پیش‌فرض: ۳۰) عبور کند. خروج در تقاطع معکوس. ورود شورت در حالت پایه وجود ندارد.",
    },
    good: {
      en: "Strong sustained trends. Works well on daily/weekly timeframes and on coins/pairs that trend cleanly for long periods.",
      fa: "روندهای قوی و طولانی. روی تایم‌فریم روزانه/هفتگی و دارایی‌هایی که روند صاف دارند بهتر عمل می‌کند.",
    },
    bad: {
      en: "Choppy, sideways or range-bound markets — whipsaws constantly. Late entry by design (lags the trend).",
      fa: "بازارهای رنج و متلاطم — مدام وارد و خارج می‌شود. ذاتاً با تأخیر وارد می‌شود.",
    },
    params: {
      en: "fastPeriod (10): smaller = more responsive but more false signals. slowPeriod (30): larger = cleaner trend filter but more lag. A popular classic pair is 50/200 (Golden Cross).",
      fa: "fastPeriod (۱۰): کمتر = حساس‌تر، سیگنال کاذب بیشتر. slowPeriod (۳۰): بزرگتر = فیلتر بهتر، تأخیر بیشتر. جفت کلاسیک ۵۰/۲۰۰ معروف است (Golden Cross).",
    },
    short: false,
  },
  emaCrossover: {
    category_label: { en: "Trend following (fast)", fa: "پیرو روند (سریع)" },
    entry: {
      en: "Same logic as SMA Crossover but using Exponential Moving Averages — EMAs weight recent candles more, so signals appear faster. Default fast: 9, slow: 21.",
      fa: "مثل SMA Crossover ولی با EMA — EMA به کندل‌های اخیر وزن بیشتر می‌دهد و سیگنال‌ها سریع‌تر می‌آیند. پیش‌فرض: ۹/۲۱.",
    },
    good: {
      en: "Shorter timeframes (1h–4h) where SMA is too slow. Early-stage trends.",
      fa: "تایم‌فریم‌های کوتاه‌تر (۱h تا ۴h) که SMA خیلی کند است. ابتدای روندها.",
    },
    bad: {
      en: "Even more whipsaw-prone than SMA in sideways markets due to higher sensitivity.",
      fa: "در بازار رنج بیشتر از SMA سیگنال کاذب می‌دهد چون حساس‌تر است.",
    },
    params: {
      en: "fastPeriod (9) / slowPeriod (21): popular EMA pair for intraday. 12/26 matches the MACD components. 9/50 for medium-term.",
      fa: "۹/۲۱: جفت محبوب برای intraday. 12/26 همسو با MACD. ۹/۵۰ برای میان‌مدت.",
    },
    short: false,
  },
  rsiThreshold: {
    category_label: { en: "Mean reversion", fa: "بازگشت به میانگین" },
    entry: {
      en: "Enter long when RSI falls below the oversold threshold (default: 30). Exit when RSI rises above the overbought threshold (default: 70). With Short direction enabled: short when RSI > overbought, cover when RSI < oversold.",
      fa: "ورود لانگ وقتی RSI زیر آستانه اشباع فروش (پیش‌فرض: ۳۰) برود. خروج وقتی RSI بالای ۷۰ برود. با شورت: ورود شورت بالای ۷۰، پوشش زیر ۳۰.",
    },
    good: {
      en: "Range-bound markets and coins that oscillate within a band. Crypto often see RSI extremes after sharp reversals.",
      fa: "بازارهای رنج و دارایی‌هایی که نوسان محدود دارند. کریپتو بعد از ریورسال‌های تند اغلب RSI افراطی می‌بیند.",
    },
    bad: {
      en: "Trending markets — an RSI of 30 in a strong downtrend is a 'falling knife', not a reversal.",
      fa: "بازارهای ترند — RSI زیر ۳۰ در یک روند نزولی قوی چاقوی در حال سقوط است، نه بازگشت.",
    },
    params: {
      en: "period (14): standard. Lower (7–9) for faster but noisier. oversold/overbought: widening to 25/75 reduces signals but improves quality. Narrowing to 40/60 for choppy markets.",
      fa: "period (۱۴): استاندارد. کمتر (۷–۹) سریع‌تر ولی پر سروصداتر. اشباع ۲۵/۷۵: کمتر ولی باکیفیت. ۴۰/۶۰ برای بازار پر نوسان.",
    },
    short: true,
  },
  macdCross: {
    category_label: { en: "Momentum", fa: "مومنتوم" },
    entry: {
      en: "Long when the MACD line (difference between fast and slow EMA) crosses above the signal line (9-period EMA of MACD). Exit on the reverse cross.",
      fa: "لانگ وقتی خط MACD (تفاوت EMA سریع و کند) از خط سیگنال (EMA 9-دوره‌ای MACD) عبور کند. خروج در تقاطع معکوس.",
    },
    good: {
      en: "Trending markets with momentum shifts. The histogram (MACD - signal) visually shows momentum strength — useful alongside the signal.",
      fa: "بازارهای ترند با تغییر مومنتوم. هیستوگرام (MACD - سیگنال) قدرت مومنتوم را نشان می‌دهد.",
    },
    bad: {
      en: "Flat, low-volatility markets. MACD lags because it's built on lagging EMAs.",
      fa: "بازارهای آرام و کم‌نوسان. MACD خود ذاتاً با تأخیر است چون روی EMA بنا شده.",
    },
    params: {
      en: "fast (12) / slow (26) / signal (9): the classic triple. A faster version is 5/13/1. Shorter timeframes benefit from smaller values.",
      fa: "۱۲/۲۶/۹: سه‌گانه کلاسیک. نسخه سریع‌تر: ۵/۱۳/۱. در تایم‌فریم کوچک‌تر از مقادیر کمتر استفاده کنید.",
    },
    short: false,
  },
  bollingerReversion: {
    category_label: { en: "Mean reversion", fa: "بازگشت به میانگین" },
    entry: {
      en: "Enter long when the closing price drops below the lower Bollinger Band (mean − N×σ). Exit when price returns to the middle band (the SMA). No short entry.",
      fa: "لانگ وقتی قیمت بسته زیر باند پایین (میانگین − N×σ) برود. خروج در برگشت به باند میانی (SMA). ورود شورت ندارد.",
    },
    good: {
      en: "Ranging markets where extreme moves snap back. Most effective when bands are tight (low volatility = compressed bands).",
      fa: "بازارهای رنج که حرکات افراطی برمی‌گردند. وقتی باندها فشرده‌اند (نوسان کم) بهتر است.",
    },
    bad: {
      en: "Trending markets — price can \"walk\" along the lower band for many candles. During high-volatility expansions, the lower band doesn't mean oversold.",
      fa: "بازارهای ترند — قیمت می‌تواند چندین کندل روی باند پایین بماند. در انبساط نوسانی بالا، پایین باند به معنای اشباع فروش نیست.",
    },
    params: {
      en: "period (20): the SMA window. mult (2): standard deviation multiplier — increase to 2.5 for fewer but cleaner entries; decrease to 1.5 for more frequent entries in tight markets.",
      fa: "period (۲۰): پنجره SMA. mult (2): ضریب انحراف معیار — ۲.۵ برای ورودهای کمتر ولی باکیفیت‌تر؛ ۱.۵ برای ورودهای بیشتر در بازار فشرده.",
    },
    short: false,
  },
  bollingerBreakout: {
    category_label: { en: "Breakout / Trend", fa: "شکست / ترند" },
    entry: {
      en: "Enter long when price closes above the upper Bollinger Band — a breakout from the range. Exit when price falls back below the middle band. With Short: short when price breaks below the lower band.",
      fa: "لانگ وقتی قیمت بالای باند بالایی بسته شود — شکست از رنج. خروج زیر باند میانی. با شورت: شورت زیر باند پایین.",
    },
    good: {
      en: "Low-volatility squeezes followed by a sharp expansion. Catching the start of a new trend after a compression period.",
      fa: "فشردگی‌های کم‌نوسان پیش از انبساط تند. گرفتن شروع ترند جدید بعد از دوره فشردگی.",
    },
    bad: {
      en: "Already-trending markets — a close above the upper band in a roaring uptrend is not a breakout signal, it's normal. Can lead to buying tops.",
      fa: "بازارهای ترند فعال — بسته شدن بالای باند در یک ترند صعودی قوی سیگنال شکست نیست، عادی است. ممکن است سقف بخرد.",
    },
    params: {
      en: "period / mult: same as Bollinger Reversion. A wider band (mult ≥ 2.5) reduces false breakouts.",
      fa: "period / mult: مثل Bollinger Reversion. باند عریض‌تر (mult ≥ ۲.۵) شکست‌های کاذب را کم می‌کند.",
    },
    short: true,
  },
  donchianBreakout: {
    category_label: { en: "Channel breakout", fa: "شکست کانال" },
    entry: {
      en: "Long when price exceeds the highest high of the last `entryPeriod` candles (default: 20). Exit when price falls below the lowest low of the last `exitPeriod` candles (default: 10). The classic Turtle Traders' system.",
      fa: "لانگ وقتی قیمت از بالاترین سقف `entryPeriod` کندل اخیر (پیش‌فرض: ۲۰) بالاتر رود. خروج زیر پایین‌ترین کف `exitPeriod` کندل اخیر (پیش‌فرض: ۱۰). سیستم کلاسیک Turtle Traders.",
    },
    good: {
      en: "Long trending markets, commodities, forex, and any asset that makes sustained directional moves. The asymmetric window (entry wider than exit) locks in gains while staying in trends.",
      fa: "بازارهای ترند طولانی، کامودیتی، فارکس و هر دارایی که حرکت جهت‌دار پایدار دارد. پنجره نامتقارن (ورود بزرگ‌تر از خروج) سود را حفظ می‌کند.",
    },
    bad: {
      en: "Ranging markets — every small range high/low triggers a false breakout. Performs worst when volatility is cyclically low.",
      fa: "بازارهای رنج — هر سقف/کف کوچک رنج یک شکست کاذب می‌سازد. در نوسان دوره‌ای پایین بدترین عملکرد را دارد.",
    },
    params: {
      en: "entryPeriod (20): larger = fewer but stronger breakouts. exitPeriod (10): smaller = tighter stop, more exits. Classic Turtle was 20/10 (System 1) and 55/20 (System 2).",
      fa: "entryPeriod (۲۰): بزرگتر = کمتر ولی قوی‌تر. exitPeriod (۱۰): کمتر = استاپ تنگ‌تر. سیستم کلاسیک Turtle: ۲۰/۱۰ (سیستم ۱) و ۵۵/۲۰ (سیستم ۲).",
    },
    short: true,
  },
  momentum: {
    category_label: { en: "Momentum (Rate of Change)", fa: "مومنتوم (نرخ تغییر)" },
    entry: {
      en: "Long while the N-period rate-of-change (ROC = (close − close[N]) / close[N] × 100) is positive and above the threshold (default: 0%). Exit when ROC drops below the threshold.",
      fa: "لانگ تا زمانی که نرخ تغییر N-دوره‌ای (ROC = (close − close[N]) / close[N] × ۱۰۰) مثبت و بالای آستانه (پیش‌فرض: ۰٪) باشد. خروج زیر آستانه.",
    },
    good: {
      en: "Markets with clear, persistent momentum cycles. Works on crypto and forex on daily–weekly timeframes where momentum autocorrelation is observed.",
      fa: "بازارهای با چرخه‌های مومنتوم واضح. کریپتو و فارکس روی تایم‌فریم روزانه-هفتگی که اتوکرلاسیون مومنتوم دیده می‌شود.",
    },
    bad: {
      en: "Markets with sharp reversals or frequent choppy consolidations.",
      fa: "بازارهایی با ریورسال‌های تند یا تراکم مکرر.",
    },
    params: {
      en: "period (14): the lookback for ROC. Higher = smoother, fewer trades. threshold (0): raise to 2–5 to filter out weak momentum and reduce over-trading.",
      fa: "period (۱۴): دوره ROC. بزرگتر = هموارتر، کمتر معامله. threshold (0): تا ۲–۵ بالا ببرید تا مومنتوم ضعیف حذف شود.",
    },
    short: false,
  },
  trendMomentumHybrid: {
    category_label: { en: "Hybrid: Trend + Momentum", fa: "ترکیبی: روند + مومنتوم" },
    entry: {
      en: "AND gate: enter long only when BOTH conditions hold — fast EMA above slow EMA (trend filter) AND RSI above its floor (default: 50, confirming momentum). Exit when either condition fails.",
      fa: "دروازه AND: ورود لانگ فقط وقتی هر دو شرط برقرار باشند — EMA سریع بالای کند (فیلتر روند) AND RSI بالای آستانه (پیش‌فرض: ۵۰). خروج وقتی یکی رد شود.",
    },
    good: {
      en: "Markets with defined trends. The dual filter dramatically cuts false signals that plague single-indicator strategies — particularly useful on noisy lower timeframes.",
      fa: "بازارهای با روند مشخص. فیلتر دوگانه سیگنال کاذب را به شدت کم می‌کند — مخصوصاً روی تایم‌فریم‌های پر سروصدای پایین‌تر.",
    },
    bad: {
      en: "Slow, ranging markets where both conditions may never align long enough to generate any trades. Can have long flat (unexposed) periods.",
      fa: "بازارهای رنج آهسته که ممکن است هر دو شرط هیچ‌وقت کافی هم‌راستا نشوند. ممکن است دوره‌های فلت طولانی داشته باشد.",
    },
    params: {
      en: "fastPeriod/slowPeriod: EMA pair (9/21 default). rsiPeriod (14): RSI window. rsiFloor (50): the momentum cutoff — raise to 55–60 for stricter confirmation.",
      fa: "fastPeriod/slowPeriod: جفت EMA (پیش‌فرض ۹/۲۱). rsiPeriod (۱۴): پنجره RSI. rsiFloor (۵۰): آستانه مومنتوم — تا ۵۵–۶۰ بالا ببرید برای تأیید سخت‌تر.",
    },
    short: false,
  },
  macdRsiHybrid: {
    category_label: { en: "Hybrid: MACD + RSI", fa: "ترکیبی: MACD + RSI" },
    entry: {
      en: "Long when MACD line crosses above signal AND RSI is at or above rsiFloor (default: 45, preventing entries when oversold momentum is still weak). Exit when MACD crosses below signal.",
      fa: "لانگ وقتی MACD از سیگنال بالا رود AND RSI بالای rsiFloor (پیش‌فرض: ۴۵) باشد تا مومنتوم خیلی ضعیف وارد نشود. خروج در تقاطع معکوس MACD.",
    },
    good: {
      en: "Medium-term timeframes (4h, daily). Good at catching momentum surges after genuine bottoms rather than false-bottom MACD crosses in downtrends.",
      fa: "تایم‌فریم میان‌مدت (۴h، روزانه). خوب است برای گرفتن سرج مومنتوم بعد از کف واقعی نه تقاطع MACD کاذب در روند نزولی.",
    },
    bad: {
      en: "Can miss early entries in strong trending markets if RSI hasn't cooled to rsiFloor first.",
      fa: "ممکن است ورودهای اولیه در ترندهای قوی را از دست بدهد اگر RSI هنوز تا rsiFloor سرد نشده باشد.",
    },
    params: {
      en: "fast/slow/signal (12/26/9): MACD params. rsiPeriod (14). rsiFloor (45): lower = more entries (less restrictive); 50+ = only enters when momentum is genuinely building.",
      fa: "fast/slow/signal (۱۲/۲۶/۹): پارامترهای MACD. rsiPeriod (۱۴). rsiFloor (۴۵): کمتر = ورودهای بیشتر؛ ۵۰+ = فقط ورود با مومنتوم واقعی.",
    },
    short: false,
  },
  tripleConfluence: {
    category_label: { en: "Hybrid: Triple Confluence", fa: "ترکیبی: هم‌گرایی سه‌گانه" },
    entry: {
      en: "Three simultaneous conditions required — (1) price above a long SMA (trend), (2) positive MACD histogram (momentum), (3) RSI between rsiFloor (48) and rsiCap (78) (avoiding extremes). Exit when any fails.",
      fa: "سه شرط همزمان لازم است — (۱) قیمت بالای SMA بلند (روند)، (۲) هیستوگرام MACD مثبت (مومنتوم)، (۳) RSI بین ۴۸ و ۷۸ (اجتناب از افراط). خروج با خرابی هر کدام.",
    },
    good: {
      en: "Conservative traders who prioritize low drawdown over maximum return. Generates fewer trades but each has multiple confirming factors behind it.",
      fa: "معامله‌گران محافظه‌کار که کاهش سرمایه کم را به بازده حداکثری ترجیح می‌دهند. معاملات کمتر ولی هر کدام چندین تأیید دارند.",
    },
    bad: {
      en: "Fast-moving or very short timeframe markets where the three conditions rarely converge in time. Low exposure means low return even when right.",
      fa: "بازارهای سریع یا تایم‌فریم خیلی کوتاه که سه شرط به ندرت همزمان می‌شوند. exposure پایین = بازده پایین حتی با سیگنال درست.",
    },
    params: {
      en: "trendPeriod (50): SMA length for the trend filter. rsiPeriod (14). rsiFloor/rsiCap (48/78): the RSI window that's considered 'normal' — widen to 40/80 for more trades.",
      fa: "trendPeriod (۵۰): طول SMA روند. rsiPeriod (۱۴). rsiFloor/rsiCap (۴۸/۷۸): پنجره RSI 'نرمال' — تا ۴۰/۸۰ گشادتر کنید برای معامله بیشتر.",
    },
    short: false,
  },
  buyAndHold: {
    category_label: { en: "Benchmark", fa: "معیار مقایسه" },
    entry: {
      en: "Buys at the first candle and holds until the final candle of the lookback window. No signal logic whatsoever — it is the passive investment baseline.",
      fa: "از اولین کندل می‌خرد و تا آخرین کندل بازه نگه می‌دارد. هیچ منطق سیگنالی ندارد — این خط پایه سرمایه‌گذاری غیرفعال است.",
    },
    good: {
      en: "Any asset in a long-term uptrend. The strategy to beat — if yours can't beat buy-and-hold, it's just adding complexity for nothing.",
      fa: "هر دارایی در ترند صعودی بلندمدت. این استراتژی را باید شکست داد — اگر استراتژی شما از آن بهتر نیست، فقط پیچیدگی اضافه کرده‌اید.",
    },
    bad: {
      en: "Drawdowns during bear markets are fully exposed — no stop-loss, no exit. For the backtest, it's only a reference comparison, not a tradeable strategy.",
      fa: "در بازارهای نزولی کاملاً در معرض ریزش است — بدون استاپ. برای بک‌تست فقط مرجع مقایسه است، نه استراتژی معاملاتی.",
    },
    params: {
      en: "No parameters.",
      fa: "پارامتری ندارد.",
    },
    short: false,
  },
};

const CATEGORY_COLORS = {
  trend: "var(--gold, #d4af37)",
  reversion: "var(--cyan, #06b6d4)",
  momentum: "#a78bfa",
  hybrid: "#34d399",
  benchmark: "var(--text-muted)",
};

export default function StrategyDocs({ activeStrategyKey }) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(activeStrategyKey || null);

  const strategies = Object.entries(STRATEGIES).filter(([k]) => k !== "buyAndHold");
  const benchmark = Object.entries(STRATEGIES).filter(([k]) => k === "buyAndHold");
  const all = [...strategies, ...benchmark];

  function getLabel(obj) {
    return typeof obj === "object" ? (obj[lang] ?? obj.en ?? String(obj)) : obj;
  }

  return (
    <div className="strategy-docs">
      <p className="strategy-docs__intro">
        {t("bt.docs.intro")}
      </p>
      {all.map(([key, strategy]) => {
        const doc = STRATEGY_DOCS[key];
        const isOpen = expanded === key;
        const isActive = activeStrategyKey === key;
        const catColor = CATEGORY_COLORS[strategy.category] ?? "var(--text-muted)";

        return (
          <div
            key={key}
            className={`strategy-doc-card${isActive ? " strategy-doc-card--active" : ""}`}
          >
            <button
              className="strategy-doc-card__header"
              onClick={() => setExpanded(isOpen ? null : key)}
              aria-expanded={isOpen}
            >
              <span
                className="strategy-doc-card__cat"
                style={{ color: catColor }}
              >
                {getLabel(doc?.category_label)}
              </span>
              <span className="strategy-doc-card__name">
                {getLabel(strategy.label)}
                {isActive && <span className="strategy-doc-card__active-badge">{t("bt.docs.active")}</span>}
              </span>
              <span className="strategy-doc-card__chevron">{isOpen ? "▾" : "▸"}</span>
            </button>

            {isOpen && doc && (
              <div className="strategy-doc-card__body">
                <p className="strategy-doc-card__desc">{getLabel(strategy.description)}</p>

                <div className="strategy-doc-card__section">
                  <h5>{t("bt.docs.entry")}</h5>
                  <p>{getLabel(doc.entry)}</p>
                </div>

                <div className="strategy-doc-card__row">
                  <div className="strategy-doc-card__section strategy-doc-card__section--good">
                    <h5>✓ {t("bt.docs.good")}</h5>
                    <p>{getLabel(doc.good)}</p>
                  </div>
                  <div className="strategy-doc-card__section strategy-doc-card__section--bad">
                    <h5>✗ {t("bt.docs.bad")}</h5>
                    <p>{getLabel(doc.bad)}</p>
                  </div>
                </div>

                <div className="strategy-doc-card__section">
                  <h5>{t("bt.docs.params")}</h5>
                  <p>{getLabel(doc.params)}</p>
                </div>

                <div className="strategy-doc-card__footer">
                  <span className={`strategy-doc-card__short strategy-doc-card__short--${doc.short ? "yes" : "no"}`}>
                    {doc.short ? `✓ ${t("bt.docs.shortSupport")}` : `✗ ${t("bt.docs.noShort")}`}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
