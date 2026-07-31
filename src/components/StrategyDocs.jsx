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
  smaCrossover1226: {
    category_label: { en: "Trend following", fa: "پیرو روند" },
    entry: {
      en: "Identical mechanics to SMA Crossover, fixed at the 12/26 pair — MACD's own periods applied straight to price instead of to EMAs. Long while the 12-SMA is above the 26-SMA, flat otherwise.",
      fa: "همان مکانیک SMA Crossover، این‌بار ثابت روی جفت ۱۲/۲۶ — همان دوره‌های MACD، مستقیم روی قیمت به‌جای EMA. تا وقتی SMA-۱۲ بالای SMA-۲۶ باشد لانگ، در غیر این‌صورت فلت.",
    },
    good: {
      en: "The same conditions SMA Crossover likes — sustained trends — but with a specific, widely-recognized period pair some traders prefer to test alongside the EMA 12/26 (MACD) version.",
      fa: "همان شرایطی که SMA Crossover دوست دارد — روندهای پایدار — ولی با جفت‌دوره‌ای مشخص و شناخته‌شده که برخی معامله‌گران دوست دارند کنار نسخه‌ی EMA ۱۲/۲۶ (MACD) تست کنند.",
    },
    bad: {
      en: "Same weaknesses as any SMA cross: whipsaws in ranging markets, lag on reversals.",
      fa: "همان ضعف‌های هر تقاطع SMA: سیگنال کاذب در بازار رنج، تأخیر در بازگشت‌ها.",
    },
    params: {
      en: "fastPeriod (12) / slowPeriod (26): fixed to MACD's periods by default, but still tunable like any other strategy here.",
      fa: "fastPeriod (۱۲) / slowPeriod (۲۶): پیش‌فرض همان دوره‌های MACD، ولی مثل هر استراتژی دیگر این‌جا قابل تنظیم است.",
    },
    short: true,
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
  stochasticOscillator: {
    category_label: { en: "Momentum / oscillator", fa: "مومنتوم / نوسان‌گر" },
    entry: {
      en: "Long when %K crosses above %D while %K was below the oversold line (default: 20). Exit when %K crosses back below %D while %K was above the overbought line (default: 80). With Short: the mirrored crosses at the opposite extreme.",
      fa: "لانگ وقتی %K از %D عبور کند در حالی که %K زیر خط اشباع فروش (پیش‌فرض: ۲۰) بوده. خروج با تقاطع معکوس وقتی %K بالای اشباع خرید (پیش‌فرض: ۸۰) بوده. با شورت: تقاطع‌های آینه‌ای در سمت مقابل.",
    },
    good: {
      en: "Range-bound, oscillating markets — the same conditions RSI Threshold likes, but the %K/%D cross adds a timing confirmation instead of a bare threshold touch.",
      fa: "بازارهای رنج و نوسانی — همان شرایطی که RSI Threshold دوست دارد، ولی تقاطع %K/%D یک تأیید زمانی اضافه اضافه می‌کند به‌جای صرفاً لمس آستانه.",
    },
    bad: {
      en: "Strong trends — the oscillator can sit pinned near an extreme for a long stretch without producing the confirming cross.",
      fa: "روندهای قوی — نوسان‌گر می‌تواند مدت زیادی نزدیک یک انتها بماند بدون این‌که تقاطع تأییدی رخ دهد.",
    },
    params: {
      en: "kPeriod (14) / dPeriod (3): the classic \"slow stochastic\" pair. oversold/overbought (20/80): widen to 10/90 for fewer, higher-conviction signals.",
      fa: "kPeriod (۱۴) / dPeriod (۳): جفت کلاسیک «استوکاستیک آهسته». oversold/overbought (۲۰/۸۰): تا ۱۰/۹۰ برای سیگنال‌های کمتر ولی مطمئن‌تر.",
    },
    short: true,
  },
  connorsRsi2: {
    category_label: { en: "Mean reversion", fa: "بازگشت به میانگین" },
    entry: {
      en: "Long when a very fast RSI(2) drops below oversold (default: 10) while price is above a long-term trend filter (default: SMA 200) — buying a dip inside an uptrend. Exit once RSI(2) recovers past the exit level (default: 70). With Short: the mirrored condition below the trend filter.",
      fa: "لانگ وقتی RSI(2) بسیار سریع زیر اشباع فروش (پیش‌فرض: ۱۰) برود در حالی که قیمت بالای فیلتر روند بلندمدت (پیش‌فرض: SMA ۲۰۰) باشد — خرید افت داخل روند صعودی. با بازگشت RSI(2) بالای سطح خروج (پیش‌فرض: ۷۰) خارج می‌شود. با شورت: شرط آینه‌ای زیر فیلتر روند.",
    },
    good: {
      en: "Well-documented (Connors & Alvarez) short-term edge in liquid markets that trend gently upward with regular pullbacks. Designed for daily timeframes originally, though it can be tried on others.",
      fa: "یک edge کوتاه‌مدت مستندشده (کانرز و آلوارز) در بازارهای نقدشونده که به‌آرامی صعودی هستند و پولبک منظم دارند. اصالتاً برای تایم‌فریم روزانه طراحی شده، هرچند روی بقیه هم قابل تست است.",
    },
    bad: {
      en: "Bear markets or assets without a genuine long-term uptrend — the trend filter (price above SMA 200) rarely passes, so the strategy simply stays out for long stretches.",
      fa: "بازارهای نزولی یا دارایی‌هایی بدون روند صعودی بلندمدت واقعی — فیلتر روند (قیمت بالای SMA ۲۰۰) به‌ندرت برقرار می‌شود و استراتژی مدت زیادی بیرون می‌ماند.",
    },
    params: {
      en: "rsiPeriod (2): deliberately very short/reactive — this is the core of Connors' method, not a typo. oversold (10) / exitRsi (70): the entry/exit RSI levels. trendPeriod (200): the trend filter's SMA length.",
      fa: "rsiPeriod (۲): عمداً بسیار کوتاه/واکنشی — این هسته‌ی روش کانرز است، اشتباه تایپی نیست. oversold (۱۰) / exitRsi (۷۰): سطوح ورود/خروج RSI. trendPeriod (۲۰۰): طول SMA فیلتر روند.",
    },
    short: true,
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
  supertrend: {
    category_label: { en: "Trend following (ATR)", fa: "پیرو روند (ATR)" },
    entry: {
      en: "Long while price closes above the Supertrend line, short while below. The line is an ATR-scaled trailing band that only ever tightens toward price during a trend, and flips the instant a close breaks through it.",
      fa: "تا وقتی قیمت بالای خط سوپرترند بسته شود لانگ، زیر آن شورت. این خط یک باند پیرو با مقیاس ATR است که در طول روند فقط به قیمت نزدیک‌تر می‌شود، و به‌محض شکسته‌شدن با یک بسته‌شدن، طرف عوض می‌کند.",
    },
    good: {
      en: "Trending markets, especially on crypto's more volatile pairs where a fixed-percentage stop would get hit constantly — the ATR scaling adapts the stop distance to current volatility automatically.",
      fa: "بازارهای ترند، به‌خصوص جفت‌ارزهای پرنوسان‌تر کریپتو که استاپ درصدی ثابت مدام فعال می‌شود — مقیاس ATR فاصله‌ی استاپ را خودکار با نوسان فعلی وفق می‌دهد.",
    },
    bad: {
      en: "Choppy, range-bound markets — frequent flips generate repeated small losses, the classic weakness of any stop-and-reverse system.",
      fa: "بازارهای رنج و متلاطم — تغییرات مکرر ضررهای کوچک تکراری می‌سازد، ضعف کلاسیک هر سیستم توقف-و-معکوس.",
    },
    params: {
      en: "atrPeriod (10): the ATR smoothing length. atrMult (3): larger = wider band, fewer whipsaws but later flips; smaller = tighter, faster flips but more noise.",
      fa: "atrPeriod (۱۰): طول هموارسازی ATR. atrMult (۳): بزرگتر = باند عریض‌تر، سیگنال کاذب کمتر ولی تغییر دیرتر؛ کوچکتر = باند تنگ‌تر، تغییر سریع‌تر ولی نویز بیشتر.",
    },
    short: true,
  },
  keltnerBreakout: {
    category_label: { en: "Breakout / Trend", fa: "شکست / ترند" },
    entry: {
      en: "Enter long when price closes above the upper Keltner band (EMA midline + atrMult×ATR). Exit when price falls back below the midline. With Short: short below the lower band, cover back at the midline.",
      fa: "لانگ وقتی قیمت بالای باند بالایی کلتنر (خط میانی EMA + atrMult×ATR) بسته شود. خروج زیر خط میانی. با شورت: شورت زیر باند پایین، پوشش در بازگشت به خط میانی.",
    },
    good: {
      en: "The same low-volatility-squeeze-then-expansion setup Bollinger Breakout likes, but ATR's true-range basis reacts faster to gap-heavy or wick-heavy candles than standard deviation does.",
      fa: "همان فشردگیِ کم‌نوسان و سپس انبساط که Bollinger Breakout دوست دارد، ولی مبنای دامنه‌ی واقعی ATR به کندل‌های شکاف‌دار یا سایه‌دار سریع‌تر از انحراف معیار واکنش می‌دهد.",
    },
    bad: {
      en: "Already-trending markets — same risk as Bollinger Breakout of buying an extended move rather than a genuine new breakout.",
      fa: "بازارهای از قبل ترند — همان ریسک Bollinger Breakout: خرید یک حرکت کشیده‌شده به‌جای شکست واقعی جدید.",
    },
    params: {
      en: "emaPeriod (20): the channel's midline. atrPeriod (10) / atrMult (2): the ATR band width — widen atrMult to 2.5–3 to cut down false breakouts.",
      fa: "emaPeriod (۲۰): خط میانی کانال. atrPeriod (۱۰) / atrMult (۲): عرض باند ATR — تا ۲.۵–۳ افزایش دهید تا شکست‌های کاذب کم شوند.",
    },
    short: true,
  },
  ichimokuCloud: {
    category_label: { en: "Trend following (Ichimoku)", fa: "پیرو روند (ایچیموکو)" },
    entry: {
      en: "Long when the Tenkan-sen (fast midpoint line) crosses above the Kijun-sen (slow midpoint line) while price trades above the Kumo (cloud). Short on the mirrored cross below the cloud. Chikou span is not used — this is the TK-cross-with-cloud-filter subset of the full system.",
      fa: "لانگ وقتی تنکان‌سن (خط میانی سریع) از کیجون‌سن (خط میانی کند) بالاتر برود و قیمت بالای کومو (ابر) معامله شود. شورت با تقاطع آینه‌ای زیر ابر. چیکو اسپن استفاده نمی‌شود — این زیرمجموعه‌ی تقاطع تنکان/کیجون با فیلتر ابر از کل سیستم است.",
    },
    good: {
      en: "Well-trending markets on 4h–daily timeframes, where the wide Kumo acts as a strong support/resistance zone rather than just a lagging average.",
      fa: "بازارهای با روند خوب روی تایم‌فریم ۴h تا روزانه، جایی که کومو عریض به‌عنوان یک ناحیه‌ی حمایت/مقاومت قوی عمل می‌کند، نه فقط یک میانگین با تأخیر.",
    },
    bad: {
      en: "Requires a long history before the first signal (52 + 26 candles minimum) and reacts slowly — three separate lookback windows means real lag by design.",
      fa: "به تاریخچه‌ی طولانی قبل از اولین سیگنال نیاز دارد (حداقل ۵۲ + ۲۶ کندل) و کند واکنش می‌دهد — سه پنجره‌ی نگاه‌به‌گذشته‌ی جدا یعنی تأخیر واقعی از طراحی.",
    },
    params: {
      en: "tenkanPeriod (9) / kijunPeriod (26) / senkouBPeriod (52): the standard Ichimoku triple. Rarely changed, since these periods were chosen to map to a 6-day trading week historically.",
      fa: "tenkanPeriod (۹) / kijunPeriod (۲۶) / senkouBPeriod (۵۲): سه‌گانه‌ی استاندارد ایچیموکو. به‌ندرت تغییر می‌کند چون این دوره‌ها تاریخاً برای هفته‌ی معاملاتی ۶-روزه انتخاب شده‌اند.",
    },
    short: true,
  },
  parabolicSar: {
    category_label: { en: "Trend following / reversal", fa: "پیرو روند / بازگشتی" },
    entry: {
      en: "Long while the SAR dot sits below price, short while above. The dot accelerates toward price as a trend ages, so a flip after a long, mature trend arrives sooner than one after a fresh trend.",
      fa: "تا وقتی نقطه‌ی SAR زیر قیمت باشد لانگ، بالای قیمت شورت. نقطه هرچه روند مسن‌تر شود سریع‌تر به قیمت نزدیک می‌شود، پس تغییر بعد از یک روند طولانی و بالغ زودتر از یک روند تازه می‌رسد.",
    },
    good: {
      en: "Strong, sustained directional moves — Wilder designed this specifically as a trailing-stop system for an existing trend, not an entry timer for a new one.",
      fa: "حرکات جهت‌دار قوی و پایدار — وایلدر این را دقیقاً به‌عنوان یک سیستم استاپ پیرو برای روند موجود طراحی کرد، نه یک تایمر ورود برای روند جدید.",
    },
    bad: {
      en: "Sideways or choppy markets — the accelerating dot flips back and forth rapidly, and each flip in this backtest is a full position reversal, so costs compound quickly.",
      fa: "بازارهای رنج یا متلاطم — نقطه‌ی شتاب‌گیرنده مدام جلو و عقب می‌رود، و هر تغییر در این بک‌تست یک معکوس‌سازی کامل پوزیشن است، پس هزینه‌ها سریع جمع می‌شوند.",
    },
    params: {
      en: "afStart (0.02) / afStep (0.02) / afMax (0.2): Wilder's original defaults. Lowering afMax slows down how aggressively the stop tightens in a long trend, giving it more room.",
      fa: "afStart (۰.۰۲) / afStep (۰.۰۲) / afMax (۰.۲): پیش‌فرض‌های اصلی وایلدر. کاهش afMax سرعت تنگ‌شدن استاپ در یک روند طولانی را کم می‌کند و فضای بیشتری می‌دهد.",
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
  atrVolatilityBreakout: {
    category_label: { en: "Volatility breakout", fa: "شکست نوسانی" },
    entry: {
      en: "Long the instant one candle's close moves further than atrMult×ATR from the previous close (a genuine volatility expansion, not just a big percentage move). Flat/short on the opposite move. With Short: the mirrored downside breakout.",
      fa: "به‌محض این‌که بسته‌شدن یک کندل بیش از atrMult×ATR از بسته‌شدن قبلی حرکت کند لانگ می‌شود (انبساط نوسانی واقعی، نه صرفاً یک حرکت درصدی بزرگ). با حرکت معکوس فلت/شورت. با شورت: شکست نزولی آینه‌ای.",
    },
    good: {
      en: "Sudden regime changes — news-driven spikes, the start of a squeeze release — where a single candle's range genuinely dwarfs its recent neighbors, on any asset/timeframe (the ATR normalization makes it self-adjusting).",
      fa: "تغییرات ناگهانی رژیم — جهش‌های خبری، شروع رهاسازی فشردگی — جایی که دامنه‌ی یک کندل واقعاً از همسایه‌های اخیرش بزرگ‌تر است، روی هر دارایی/تایم‌فریمی (نرمال‌سازی ATR آن را خودتنظیم می‌کند).",
    },
    bad: {
      en: "Steadily choppy markets with no real volatility expansions — every random bar-to-bar wobble that happens to exceed the ATR multiple triggers a flip, with no underlying regime change behind it.",
      fa: "بازارهای دائماً پرنوسان بدون انبساط واقعی — هر نوسان تصادفی کندل‌به‌کندل که تصادفاً از ضریب ATR بگذرد یک تغییر ایجاد می‌کند، بدون تغییر رژیم واقعی پشت آن.",
    },
    params: {
      en: "atrPeriod (14): ATR smoothing length. atrMult (1): higher = requires a bigger, rarer expansion to trigger; lower = more sensitive, more frequent flips.",
      fa: "atrPeriod (۱۴): طول هموارسازی ATR. atrMult (۱): بالاتر = نیاز به انبساط بزرگ‌تر و کمیاب‌تر برای فعال‌شدن؛ پایین‌تر = حساس‌تر، تغییرات مکررتر.",
    },
    short: true,
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
  monteCarloProbability: {
    category_label: { en: "Quant / Simulation", fa: "کمّی / شبیه‌سازی" },
    entry: {
      en: "At every recalculation point, re-runs this app's own block-bootstrap Monte Carlo forecaster (the same engine behind the Forecast page) using only price history available up to that candle, projecting `horizon` candles ahead. Long while the simulated probability of a higher price clears longThreshold, short while it drops below shortThreshold, flat in between.",
      fa: "در هر نقطه‌ی بازمحاسبه، همان موتور پیش‌بینیِ مونت‌کارلوی بلوک-بوت‌استرپ این ابزار (همان موتور پشت صفحه‌ی پیش‌بینی) را با فقط تاریخچه‌ی قیمت در دسترس تا همان کندل دوباره اجرا می‌کند و `horizon` کندل جلوتر را پیش‌بینی می‌کند. تا وقتی احتمال شبیه‌سازی‌شده‌ی صعود از longThreshold بگذرد لانگ، زیر shortThreshold شورت، در میانه فلت.",
    },
    good: {
      en: "Assets with a persistent statistical edge in their historical return distribution (a real drift, or return clustering that block bootstrap preserves). A genuinely different kind of signal from every rule-based strategy above — worth comparing against them rather than only itself.",
      fa: "دارایی‌هایی با یک برتری آماری پایدار در توزیع بازده تاریخی‌شان (drift واقعی، یا خوشه‌بندی بازدهی که بلوک-بوت‌استرپ حفظ می‌کند). نوع کاملاً متفاوتی از سیگنال نسبت به همه‌ی استراتژی‌های قانون‌محور بالا — ارزش دارد کنار آن‌ها مقایسه شود، نه فقط با خودش.",
    },
    bad: {
      en: "Assets whose future genuinely departs from their own past return distribution (regime changes, structural breaks) — like any bootstrap method, it assumes history is a fair sample of what comes next. Also the heaviest strategy here computationally: expect a run to take noticeably longer than any rule-based strategy, especially with a long lookback and low recalcEvery.",
      fa: "دارایی‌هایی که آینده‌شان واقعاً از توزیع بازده گذشته‌ی خودشان فاصله می‌گیرد (تغییر رژیم، شکست ساختاری) — مثل هر روش بوت‌استرپ، فرض می‌کند تاریخچه نمونه‌ی منصفانه‌ای از آینده است. همچنین سنگین‌ترین استراتژی این‌جا از نظر محاسباتی: انتظار داشته باشید اجرا محسوسا بیشتر از هر استراتژی قانون‌محور طول بکشد، به‌خصوص با پنجره‌ی تاریخچه‌ی بلند و recalcEvery پایین.",
    },
    params: {
      en: "horizon (10) / sims (300) / blockSize (5): the simulation itself — more sims = smoother probability estimate but slower. lookback (150): how much history feeds each simulation window. recalcEvery (10): re-simulate every N candles instead of every single one — lower is more responsive but proportionally slower. longThreshold/shortThreshold (0.55/0.45): how confident the simulation must be before acting. seed (12345): kept fixed for reproducible results.",
      fa: "horizon (۱۰) / sims (۳۰۰) / blockSize (۵): خود شبیه‌سازی — sims بیشتر یعنی تخمین احتمال هموارتر ولی کندتر. lookback (۱۵۰): چقدر تاریخچه هر پنجره‌ی شبیه‌سازی را تغذیه کند. recalcEvery (۱۰): هر N کندل یک‌بار بازمحاسبه به‌جای هر کندل — کمتر یعنی واکنش‌پذیرتر ولی متناسباً کندتر. longThreshold/shortThreshold (۰.۵۵/۰.۴۵): شبیه‌سازی چقدر باید مطمئن باشد تا وارد عمل شود. seed (۱۲۳۴۵): برای نتایج قابل‌بازتولید ثابت نگه داشته شده.",
    },
    short: true,
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
  quant: "#f472b6",
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
