// lib/strategies.js
// Rule-based strategy definitions. These are textbook technical-analysis rules
// — deterministic functions of price history, not model predictions. The
// backtester applies them mechanically so results are reproducible/auditable.
//
// generateSignals(candles, params) — long signal: 1 = enter/hold long, 0 = flat.
//   Used as-is for Spot (which can only ever go long) and for the "Long only"
//   direction on futures.
//
// generateShortSignals(candles, params) — short signal: 1 = enter/hold short,
//   0 = flat. Optional; only meaningful for futures, where shorting is
//   possible. Each strategy below defines its own short rule as the
//   deliberate mirror-image of its long rule (e.g. "breaks below the lower
//   band" mirrors "breaks above the upper band") rather than a blind
//   inversion of the long signal — a strategy being flat is not the same
//   claim as a strategy actively expecting price to fall, so "not long" and
//   "should be short" are kept as distinct, separately-justified rules.
//   Strategies without a natural short counterpart (e.g. the Buy & Hold
//   benchmark) simply omit it.
//
// combineDirectionalSignals() below merges the two into a single -1/0/1
// position series according to the user's chosen direction mode.

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = i < period - 1 ? null : prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const validFrom = macdLine.findIndex((v) => v != null);
  const compact = macdLine.slice(validFrom).map((v) => v ?? 0);
  const signalCompact = ema(compact, signal);
  const signalLine = new Array(values.length).fill(null);
  for (let i = 0; i < signalCompact.length; i++) {
    signalLine[validFrom + i] = signalCompact[i];
  }
  const hist = values.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

export function roc(values, period = 10) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    out[i] = ((values[i] - values[i - period]) / values[i - period]) * 100;
  }
  return out;
}

/**
 * Rolling max/min over the *previous* `period` values (exclusive of the
 * current index), using a monotonic deque. This is the O(n) replacement for
 * repeatedly slicing the array and spreading into Math.max/Math.min at every
 * index, which is O(n * period) and allocates a short-lived array per index —
 * negligible on a few hundred candles, but a real bottleneck on tens of
 * thousands (e.g. low timeframes over a long lookback).
 * out[i] is null until i >= period (matching the "last N candles before i" window).
 */
function rollingMaxExclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = []; // indices < current i, values decreasing front-to-back
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] < i - period) deque.shift();
    if (i >= period) out[i] = values[deque[0]];
    while (deque.length && values[deque[deque.length - 1]] <= values[i]) deque.pop();
    deque.push(i);
  }
  return out;
}

function rollingMinExclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = []; // indices < current i, values increasing front-to-back
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] < i - period) deque.shift();
    if (i >= period) out[i] = values[deque[0]];
    while (deque.length && values[deque[deque.length - 1]] >= values[i]) deque.pop();
    deque.push(i);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

export const STRATEGIES = {
  smaCrossover: {
    label: { en: "SMA Crossover", fa: "تقاطع میانگین متحرک (SMA)" },
    category: "trend",
    description: {
      en: "Goes long when the short-term moving average rises above the long-term one; exits on the reverse cross.",
      fa: "وقتی میانگین متحرک کوتاه‌مدت از بلندمدت بالاتر می‌رود لانگ باز می‌شود؛ در تقاطع معکوس بسته می‌شود.",
    },
    params: { fastPeriod: 10, slowPeriod: 30 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] > slow[i] ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] < slow[i] ? 1 : 0));
    },
  },

  emaCrossover: {
    label: { en: "EMA Crossover (faster)", fa: "تقاطع EMA (واکنش سریع‌تر)" },
    category: "trend",
    description: {
      en: "A faster-reacting moving-average cross using EMAs, which weight recent prices more — suited to lower timeframes.",
      fa: "نسخه‌ی واکنش‌سریع‌تر تقاطع میانگین؛ از EMA استفاده می‌کند که به قیمت‌های اخیر وزن بیشتری می‌دهد — مناسب تایم‌فریم پایین‌تر.",
    },
    params: { fastPeriod: 9, slowPeriod: 21 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] > slow[i] ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] < slow[i] ? 1 : 0));
    },
  },

  rsiThreshold: {
    label: { en: "RSI Threshold (mean-reversion)", fa: "آستانه RSI (بازگشت به میانگین)" },
    category: "reversion",
    description: {
      en: "Enters when RSI drops below oversold and exits at overbought — a mean-reversion approach.",
      fa: "وقتی RSI زیر اشباع فروش می‌رود وارد می‌شود و در اشباع خرید خارج می‌شود — استراتژی بازگشت به میانگین.",
    },
    params: { period: 14, oversold: 30, overbought: 70 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.period);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null) continue;
        if (!inPos && r[i] < p.oversold) inPos = true;
        else if (inPos && r[i] > p.overbought) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.period);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null) continue;
        if (!inPos && r[i] > p.overbought) inPos = true;
        else if (inPos && r[i] < p.oversold) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  macdCross: {
    label: { en: "MACD Crossover", fa: "تقاطع MACD" },
    category: "momentum",
    description: {
      en: "Goes long when the MACD line crosses above its signal line, and flat on the reverse cross.",
      fa: "وقتی خط MACD از خط سیگنال بالاتر می‌رود لانگ، و در تقاطع معکوس فلت می‌شود.",
    },
    params: { fast: 12, slow: 26, signal: 9 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      return c.map((_, i) =>
        macdLine[i] != null && signalLine[i] != null && macdLine[i] > signalLine[i] ? 1 : 0
      );
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      return c.map((_, i) =>
        macdLine[i] != null && signalLine[i] != null && macdLine[i] < signalLine[i] ? 1 : 0
      );
    },
  },

  bollingerReversion: {
    label: { en: "Bollinger Reversion", fa: "بازگشت باند بولینگر" },
    category: "reversion",
    description: {
      en: "Enters when price closes below the lower band (oversold) and exits when it returns to the middle band.",
      fa: "وقتی قیمت زیر باند پایین بسته می‌شود (فروش افراطی) وارد می‌شود و در رسیدن به خط میانی خارج می‌شود.",
    },
    params: { period: 20, mult: 2 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, lower } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (lower[i] == null) continue;
        if (!inPos && c[i] < lower[i]) inPos = true;
        else if (inPos && c[i] >= mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, upper } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (upper[i] == null) continue;
        if (!inPos && c[i] > upper[i]) inPos = true;
        else if (inPos && c[i] <= mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  bollingerBreakout: {
    label: { en: "Bollinger Breakout", fa: "شکست باند بولینگر" },
    category: "trend",
    description: {
      en: "Enters an uptrend when price closes above the upper band and exits when it falls back below the middle band.",
      fa: "وقتی قیمت بالای باند بالایی بسته می‌شود وارد روند صعودی و وقتی زیر خط میانی برگردد خارج می‌شود.",
    },
    params: { period: 20, mult: 2 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, upper } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (upper[i] == null) continue;
        if (!inPos && c[i] > upper[i]) inPos = true;
        else if (inPos && c[i] < mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, lower } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (lower[i] == null) continue;
        if (!inPos && c[i] < lower[i]) inPos = true;
        else if (inPos && c[i] > mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  donchianBreakout: {
    label: { en: "Donchian Channel Breakout", fa: "شکست کانال دونچیان" },
    category: "trend",
    description: {
      en: "A classic trend-following system: breaking the highest high of the last N candles is entry; breaking the low is exit.",
      fa: "سیستم کلاسیک پیرو روند: شکست بالاترین سقف N کندل اخیر ورود، و شکست کف خروج است.",
    },
    params: { entryPeriod: 20, exitPeriod: 10 },
    generateSignals(candles, p) {
      const highs = candles.map((x) => x.high);
      const lows = candles.map((x) => x.low);
      const highN = rollingMaxExclusive(highs, p.entryPeriod);
      const lowM = rollingMinExclusive(lows, p.exitPeriod);
      // Original semantics: the exit window was Math.max(0, i - exitPeriod),
      // i.e. a growing window from the start of the array whenever
      // exitPeriod hadn't fully elapsed yet. rollingMinExclusive only starts
      // producing values once i >= exitPeriod, so backfill the early indices
      // (only reachable when exitPeriod > entryPeriod, since the main loop
      // below never looks at lowM before i = entryPeriod otherwise).
      let growingMin = Infinity;
      for (let i = 0; i < candles.length && i < p.exitPeriod; i++) {
        if (i > 0) growingMin = Math.min(growingMin, lows[i - 1]);
        lowM[i] = growingMin === Infinity ? lows[0] : growingMin;
      }
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 0; i < candles.length; i++) {
        if (i < p.entryPeriod) continue;
        if (!inPos && candles[i].close > highN[i]) inPos = true;
        else if (inPos && candles[i].close < lowM[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const highs = candles.map((x) => x.high);
      const lows = candles.map((x) => x.low);
      const lowN = rollingMinExclusive(lows, p.entryPeriod);
      const highM = rollingMaxExclusive(highs, p.exitPeriod);
      let growingMax = -Infinity;
      for (let i = 0; i < candles.length && i < p.exitPeriod; i++) {
        if (i > 0) growingMax = Math.max(growingMax, highs[i - 1]);
        highM[i] = growingMax === -Infinity ? highs[0] : growingMax;
      }
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 0; i < candles.length; i++) {
        if (i < p.entryPeriod) continue;
        if (!inPos && candles[i].close < lowN[i]) inPos = true;
        else if (inPos && candles[i].close > highM[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  momentum: {
    label: { en: "Momentum (Rate of Change)", fa: "مومنتوم (نرخ تغییر)" },
    category: "momentum",
    description: {
      en: "Stays long while the return over the last N candles is positive and above a threshold — simple trend-following.",
      fa: "اگر بازده N کندل اخیر مثبت و بالای آستانه باشد لانگ می‌ماند؛ سادگیِ پیرو روند.",
    },
    params: { period: 14, threshold: 0 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = roc(c, p.period);
      return c.map((_, i) => (r[i] != null && r[i] > p.threshold ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = roc(c, p.period);
      return c.map((_, i) => (r[i] != null && r[i] < -p.threshold ? 1 : 0));
    },
  },

  /* --------------------- Hybrid / combined --------------------- */

  trendMomentumHybrid: {
    label: { en: "Hybrid: Trend + Momentum", fa: "ترکیبی: روند + مومنتوم" },
    category: "hybrid",
    description: {
      en: "Goes long only when the trend is up (fast EMA above slow) AND RSI confirms (above 50). The dual filter removes weak signals.",
      fa: "فقط زمانی لانگ می‌شود که هم روند صعودی باشد (EMA سریع بالای کند) و هم RSI تأیید کند (بالای ۵۰). فیلتر دوگانه سیگنال‌های ضعیف را حذف می‌کند.",
    },
    params: { fastPeriod: 9, slowPeriod: 21, rsiPeriod: 14, rsiFloor: 50 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (fast[i] == null || slow[i] == null || r[i] == null) return 0;
        return fast[i] > slow[i] && r[i] > p.rsiFloor ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (fast[i] == null || slow[i] == null || r[i] == null) return 0;
        return fast[i] < slow[i] && r[i] < p.rsiFloor ? 1 : 0;
      });
    },
  },

  macdRsiHybrid: {
    label: { en: "Hybrid: MACD + RSI confirmation", fa: "ترکیبی: MACD + تأیید RSI" },
    category: "hybrid",
    description: {
      en: "A bullish MACD cross as the trigger, confirmed by RSI not being in oversold territory — fewer premature entries.",
      fa: "تقاطع صعودی MACD به‌عنوان ماشه، با تأیید RSI که در ناحیه‌ی فروش افراطی نباشد — کاهش ورودهای زودهنگام.",
    },
    params: { fast: 12, slow: 26, signal: 9, rsiPeriod: 14, rsiFloor: 45 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (macdLine[i] == null || signalLine[i] == null || r[i] == null) return 0;
        return macdLine[i] > signalLine[i] && r[i] > p.rsiFloor ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      const r = rsi(c, p.rsiPeriod);
      const rsiCeiling = 100 - p.rsiFloor;
      return c.map((_, i) => {
        if (macdLine[i] == null || signalLine[i] == null || r[i] == null) return 0;
        return macdLine[i] < signalLine[i] && r[i] < rsiCeiling ? 1 : 0;
      });
    },
  },

  tripleConfluence: {
    label: { en: "Hybrid: Triple Confluence", fa: "ترکیبی: هم‌گرایی سه‌گانه" },
    category: "hybrid",
    description: {
      en: "Enters only when three conditions align: trend (price above a long SMA), momentum (positive MACD) and a mid-range RSI. Conservative but high-quality.",
      fa: "ورود فقط با هم‌راستایی سه شرط: روند (قیمت بالای SMA بلند)، مومنتوم (MACD مثبت) و RSI میانه. محافظه‌کارانه ولی باکیفیت.",
    },
    params: { trendPeriod: 50, rsiPeriod: 14, rsiFloor: 48, rsiCap: 78 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const trend = sma(c, p.trendPeriod);
      const { hist } = macd(c, 12, 26, 9);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (trend[i] == null || hist[i] == null || r[i] == null) return 0;
        const trendOk = c[i] > trend[i];
        const momoOk = hist[i] > 0;
        const rsiOk = r[i] > p.rsiFloor && r[i] < p.rsiCap;
        return trendOk && momoOk && rsiOk ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const trend = sma(c, p.trendPeriod);
      const { hist } = macd(c, 12, 26, 9);
      const r = rsi(c, p.rsiPeriod);
      const rsiFloorMirror = 100 - p.rsiCap;
      const rsiCapMirror = 100 - p.rsiFloor;
      return c.map((_, i) => {
        if (trend[i] == null || hist[i] == null || r[i] == null) return 0;
        const trendOk = c[i] < trend[i];
        const momoOk = hist[i] < 0;
        const rsiOk = r[i] > rsiFloorMirror && r[i] < rsiCapMirror;
        return trendOk && momoOk && rsiOk ? 1 : 0;
      });
    },
  },

  buyAndHold: {
    label: { en: "Buy & Hold (Benchmark)", fa: "خرید و نگهداری (Benchmark)" },
    category: "benchmark",
    description: {
      en: "The comparison line: buy at the first candle and hold until the end of the range.",
      fa: "خط مقایسه: از کندل اول خریداری و تا پایان بازه نگه‌داری می‌شود.",
    },
    params: {},
    generateSignals(candles) {
      return candles.map(() => 1);
    },
  },
};

// Direction modes available for futures (Spot can only ever be "long").
// "both" requires the strategy to define generateShortSignals; if it
// doesn't, combineDirectionalSignals below silently falls back to long-only
// for that strategy rather than throwing, since some strategies legitimately
// have no natural short counterpart (the Buy & Hold benchmark).
export const DIRECTION_MODES = ["long", "short", "both"];

/**
 * Merge a strategy's long/short signal channels into a single position
 * series using -1 (short), 0 (flat), 1 (long), according to `direction`.
 * When both a long and short condition would otherwise be active on the
 * same candle (only possible for strategies whose long/short rules aren't
 * perfectly complementary), long takes priority and the short is dropped,
 * since holding both directions at once nets to a smaller position than
 * either alone and isn't a real trading decision.
 */
export function combineDirectionalSignals(strategy, candles, params, direction = "long") {
  const longSignals = strategy.generateSignals(candles, params);
  if (direction === "long") return longSignals;

  const hasShort = typeof strategy.generateShortSignals === "function";
  if (!hasShort) {
    // No short rule defined for this strategy: "short" mode has nothing to
    // produce (flat throughout), and "both" degrades to long-only.
    return direction === "short" ? longSignals.map(() => 0) : longSignals;
  }

  const shortSignals = strategy.generateShortSignals(candles, params);
  if (direction === "short") return shortSignals.map((s) => (s ? -1 : 0));

  // direction === "both"
  return longSignals.map((longOn, i) => {
    if (longOn) return 1;
    if (shortSignals[i]) return -1;
    return 0;
  });
}

// Bilingual labels for tunable parameters.
export const PARAM_LABELS = {
  fastPeriod: { en: "Fast period", fa: "دوره سریع" },
  slowPeriod: { en: "Slow period", fa: "دوره کند" },
  period: { en: "Period", fa: "دوره" },
  oversold: { en: "Oversold", fa: "اشباع فروش" },
  overbought: { en: "Overbought", fa: "اشباع خرید" },
  fast: { en: "Fast EMA", fa: "EMA سریع" },
  slow: { en: "Slow EMA", fa: "EMA کند" },
  signal: { en: "Signal line", fa: "خط سیگنال" },
  mult: { en: "Std-dev multiple", fa: "ضریب انحراف" },
  entryPeriod: { en: "Entry period", fa: "دوره ورود" },
  exitPeriod: { en: "Exit period", fa: "دوره خروج" },
  threshold: { en: "Threshold", fa: "آستانه" },
  rsiPeriod: { en: "RSI period", fa: "دوره RSI" },
  rsiFloor: { en: "RSI floor", fa: "کف RSI" },
  rsiCap: { en: "RSI cap", fa: "سقف RSI" },
  trendPeriod: { en: "Trend period", fa: "دوره روند" },
};
