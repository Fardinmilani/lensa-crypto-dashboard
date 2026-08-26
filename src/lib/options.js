// lib/options.js
// Black-Scholes European option pricing plus a periodic option-roll
// backtest engine, generalized to any fixed set of option "legs" so the
// same mark-to-market machinery covers single-leg income/hedge strategies
// (Covered Call, Protective Put, Cash-Secured Put), undefined-risk
// volatility bets (Short Straddle), and defined-risk multi-leg spreads
// (Bull/Bear Call/Put Spread, Iron Condor) — nine total.
//
// IMPORTANT SIMPLIFICATION, disclosed here once rather than in every
// comment below: this app has historical OHLC candles, not a real options
// chain or an implied-volatility surface. Every premium computed here is
// priced off REALIZED historical volatility (a rolling window of the
// underlying's own past log returns) as a stand-in for implied volatility.
// That is the standard, disclosed approximation any backtest without real
// options market data has to make — real option premiums also bake in a
// volatility risk premium (implied vol tends to run above what later
// realizes), which this simulation cannot capture. Treat results as an
// illustration of the *mechanics and shape* of each strategy's payoff over
// time, not as a forecast of real tradeable premiums.

/**
 * Abramowitz & Stegun 7.1.26 approximation of the error function, accurate
 * to ~1.5e-7 — plenty for option pricing (vs. the market-quote precision
 * this simulation can never have anyway, given the vol caveat above).
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Black-Scholes price and delta for a European call or put. No dividend
 * yield — appropriate for crypto, and a standard simplification for forex
 * (a full Garman-Kohlhagen model would also need the foreign risk-free
 * rate, which this app has no data source for). T is time to expiry in
 * YEARS; T <= 0 collapses cleanly to the intrinsic value.
 */
export function blackScholes({ spot, strike, T, sigma, r = 0, type = "call" }) {
  const intrinsic = type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  if (T <= 0 || spot <= 0 || strike <= 0 || sigma <= 0) {
    const delta = type === "call" ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0);
    return { price: intrinsic, delta };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discK = strike * Math.exp(-r * T);
  if (type === "call") {
    return { price: spot * normCdf(d1) - discK * normCdf(d2), delta: normCdf(d1) };
  }
  return { price: discK * normCdf(-d2) - spot * normCdf(-d1), delta: normCdf(d1) - 1 };
}

function periodsPerYearOf(candles) {
  if (candles.length < 2) return 365;
  const dtSeconds = candles[1].time - candles[0].time;
  if (dtSeconds <= 0) return 365;
  return (365 * 24 * 3600) / dtSeconds;
}

/**
 * Annualized realized volatility (log-return standard deviation, scaled by
 * the candle interval's own periods-per-year) over candles[fromIdx..toIdx]
 * inclusive. Returns null if the window is too short to mean anything.
 */
function realizedVol(candles, fromIdx, toIdx) {
  const rets = [];
  for (let i = Math.max(1, fromIdx + 1); i <= toIdx; i++) {
    if (candles[i - 1].close > 0) rets.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * periodsPerYearOf(candles));
}

export const OPTION_PARAM_LABELS = {
  rollPeriod: { en: "Roll every (candles)", fa: "تمدید هر (کندل)" },
  otmPercent: { en: "Strike distance (% OTM)", fa: "فاصله‌ی استرایک (% خارج از پول)" },
  innerOtmPercent: { en: "Near-leg distance (% OTM)", fa: "فاصله‌ی پایه‌ی نزدیک (% خارج از پول)" },
  widthPercent: { en: "Spread width (%)", fa: "عرض اسپرد (%)" },
  putOtmPercent: { en: "Short put distance (% below spot)", fa: "فاصله‌ی پوت فروخته‌شده (% پایین‌تر از قیمت)" },
  callOtmPercent: { en: "Short call distance (% above spot)", fa: "فاصله‌ی کال فروخته‌شده (% بالاتر از قیمت)" },
  volLookback: { en: "Volatility window (candles)", fa: "پنجره‌ی نوسان (کندل)" },
  riskFreeRate: { en: "Risk-free rate (%/yr)", fa: "نرخ بدون ریسک (%/سال)" },
};

// Each strategy is defined purely as a set of "legs" (call/put, long/short,
// and a strike distance from spot expressed in percent — positive above
// spot, negative below) plus whether it also holds the underlying. The
// engine below (runOptionsStrategy) is 100% generic over this shape: it
// doesn't know or care whether a strategy has one leg or four, so adding a
// new strategy is just adding a registry entry, never touching the engine.
export const OPTIONS_STRATEGIES = {
  coveredCall: {
    label: { en: "Covered Call", fa: "کاورد کال (Covered Call)" },
    description: {
      en: "Holds the underlying and sells an out-of-the-money call against it every roll period, collecting the premium as income. Upside is capped at the strike; downside is the same as holding the underlying outright, cushioned slightly by the premium collected. One of the most widely used real-world income strategies.",
      fa: "دارایی پایه را نگه می‌دارد و هر دوره یک کال خارج از پول روی آن می‌فروشد و پرمیوم را به‌عنوان درآمد جمع می‌کند. سقف سود در استرایک است؛ ریسک نزولی همان نگهداری مستقیم دارایی است، فقط کمی با پرمیوم جمع‌شده نرم می‌شود. یکی از پرکاربردترین استراتژی‌های درآمدی واقعی.",
    },
    category: "income",
    holdsUnderlying: true,
    params: { rollPeriod: 30, otmPercent: 5, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [{ type: "call", side: "short", offsetPercent: p.otmPercent }],
  },
  cashSecuredPut: {
    label: { en: "Cash-Secured Put", fa: "پوت با پشتوانه‌ی نقد (Cash-Secured Put)" },
    description: {
      en: "Sells an out-of-the-money put every roll period against cash held aside (no underlying position), collecting the premium as income — the classic \"get paid to place a limit buy order below the market\" strategy. If price finishes below the strike the loss mirrors having bought at the strike; this simulation settles it in cash rather than modeling the resulting share assignment.",
      fa: "هر دوره یک پوت خارج از پول در برابر نقدی که کنار گذاشته (بدون پوزیشن روی دارایی پایه) می‌فروشد و پرمیوم را به‌عنوان درآمد جمع می‌کند — همان استراتژی معروف «پول گرفتن برای گذاشتن سفارش خرید محدود زیر بازار». اگر قیمت پایین‌تر از استرایک تمام شود، ضرر مشابه خرید در همان استرایک است؛ این شبیه‌سازی آن را نقدی تسویه می‌کند نه با واگذاری واقعی سهم/کوین.",
    },
    category: "income",
    holdsUnderlying: false,
    params: { rollPeriod: 30, otmPercent: 5, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [{ type: "put", side: "short", offsetPercent: -p.otmPercent }],
  },
  protectivePut: {
    label: { en: "Protective Put", fa: "پروتکتیو پوت (Protective Put)" },
    description: {
      en: "Holds the underlying and buys an out-of-the-money put every roll period as insurance, paying the premium as a cost. Downside is floored at the strike (minus the premium paid); upside stays uncapped, reduced by that same recurring cost — the options equivalent of paying for insurance.",
      fa: "دارایی پایه را نگه می‌دارد و هر دوره یک پوت خارج از پول به‌عنوان بیمه می‌خرد و پرمیوم را به‌عنوان هزینه می‌پردازد. کف ریسک نزولی در استرایک است (منهای پرمیوم پرداختی)؛ سود صعودی سقف ندارد ولی با همین هزینه‌ی تکرارشونده کم می‌شود — معادل آپشنی خرید بیمه.",
    },
    category: "hedge",
    holdsUnderlying: true,
    params: { rollPeriod: 30, otmPercent: 5, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [{ type: "put", side: "long", offsetPercent: -p.otmPercent }],
  },
  shortStraddle: {
    label: { en: "Short Straddle (volatility harvesting)", fa: "شورت استرادل (برداشت نوسان)" },
    description: {
      en: "Sells an at-the-money call AND put every roll period with no underlying position at all — a pure bet that realized volatility comes in below what the priced-in (historical) volatility implied. Profits from time decay in quiet markets; losses grow without limit if price moves far from the strike before the roll date. Shown for illustration of the volatility-risk-premium concept — this is the highest-risk strategy in this whole tool.",
      fa: "هر دوره یک کال و یک پوت در‌پول (ATM) می‌فروشد، بدون هیچ پوزیشنی روی خود دارایی — یک شرط خالص روی این‌که نوسان واقعی کمتر از نوسان قیمت‌گذاری‌شده (تاریخی) از آب دربیاید. در بازارهای آرام از فروپاشی زمانی سود می‌برد؛ اگر قیمت قبل از تاریخ تمدید از استرایک فاصله‌ی زیادی بگیرد، ضرر بدون سقف رشد می‌کند. برای نمایش مفهوم صرف ریسک نوسان آمده — پرریسک‌ترین استراتژی این ابزار است.",
    },
    category: "volatility",
    holdsUnderlying: false,
    params: { rollPeriod: 14, volLookback: 30, riskFreeRate: 5 },
    legs: () => [
      { type: "call", side: "short", offsetPercent: 0 },
      { type: "put", side: "short", offsetPercent: 0 },
    ],
  },
  bullCallSpread: {
    label: { en: "Bull Call Spread", fa: "بول کال اسپرد (Bull Call Spread)" },
    description: {
      en: "Buys a closer-to-the-money call and sells a further out-of-the-money call every roll period, no underlying held. A defined-risk, defined-reward bet on a moderate rise: max loss is capped at the net premium paid, max gain is capped at the width between strikes minus that premium — cheaper than an outright call, but with a hard ceiling on the payoff.",
      fa: "هر دوره یک کال نزدیک‌تر به پول می‌خرد و یک کال دورتر (خارج از پول) می‌فروشد، بدون نگهداری دارایی پایه. یک شرط با ریسک و پاداش تعریف‌شده روی رشد نسبتاً محدود: حداکثر ضرر برابر پرمیوم خالص پرداختی و حداکثر سود برابر فاصله‌ی دو استرایک منهای همان پرمیوم است — ارزان‌تر از خرید مستقیم کال، اما با سقف مشخص روی سود.",
    },
    category: "spread",
    holdsUnderlying: false,
    params: { rollPeriod: 30, innerOtmPercent: 0, widthPercent: 8, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [
      { type: "call", side: "long", offsetPercent: p.innerOtmPercent },
      { type: "call", side: "short", offsetPercent: p.innerOtmPercent + p.widthPercent },
    ],
  },
  bearPutSpread: {
    label: { en: "Bear Put Spread", fa: "بیر پوت اسپرد (Bear Put Spread)" },
    description: {
      en: "Buys a closer-to-the-money put and sells a further out-of-the-money put every roll period, no underlying held. The mirror image of a Bull Call Spread for a moderate decline: defined max loss (the net premium paid) and defined max gain (the width between strikes minus that premium).",
      fa: "هر دوره یک پوت نزدیک‌تر به پول می‌خرد و یک پوت دورتر (خارج از پول) می‌فروشد، بدون نگهداری دارایی پایه. تصویر آینه‌ای بول کال اسپرد برای افت نسبتاً محدود: حداکثر ضرر تعریف‌شده (پرمیوم خالص پرداختی) و حداکثر سود تعریف‌شده (فاصله‌ی دو استرایک منهای همان پرمیوم).",
    },
    category: "spread",
    holdsUnderlying: false,
    params: { rollPeriod: 30, innerOtmPercent: 0, widthPercent: 8, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [
      { type: "put", side: "long", offsetPercent: -p.innerOtmPercent },
      { type: "put", side: "short", offsetPercent: -(p.innerOtmPercent + p.widthPercent) },
    ],
  },
  bullPutSpread: {
    label: { en: "Bull Put Spread (credit)", fa: "بول پوت اسپرد اعتباری (Bull Put Spread)" },
    description: {
      en: "Sells a closer put and buys a further out-of-the-money put every roll period for a net credit, no underlying held. Profits if price stays above the short strike through the roll date; the long put caps the otherwise-large loss if price falls hard. A defined-risk way to collect premium on a neutral-to-bullish view.",
      fa: "هر دوره یک پوت نزدیک‌تر می‌فروشد و یک پوت دورتر (خارج از پول) می‌خرد و پرمیوم خالص دریافت می‌کند، بدون نگهداری دارایی پایه. اگر قیمت تا تاریخ تمدید بالای استرایک فروخته‌شده بماند سود می‌دهد؛ پوت خریداری‌شده جلوی ضرر بزرگ در سقوط شدید قیمت را می‌گیرد. راهی با ریسک تعریف‌شده برای جمع‌آوری پرمیوم با دیدگاه خنثی تا صعودی.",
    },
    category: "spread",
    holdsUnderlying: false,
    params: { rollPeriod: 30, innerOtmPercent: 5, widthPercent: 8, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [
      { type: "put", side: "short", offsetPercent: -p.innerOtmPercent },
      { type: "put", side: "long", offsetPercent: -(p.innerOtmPercent + p.widthPercent) },
    ],
  },
  bearCallSpread: {
    label: { en: "Bear Call Spread (credit)", fa: "بیر کال اسپرد اعتباری (Bear Call Spread)" },
    description: {
      en: "Sells a closer call and buys a further out-of-the-money call every roll period for a net credit, no underlying held. Profits if price stays below the short strike through the roll date; the long call caps the otherwise-large loss if price rallies hard. A defined-risk way to collect premium on a neutral-to-bearish view.",
      fa: "هر دوره یک کال نزدیک‌تر می‌فروشد و یک کال دورتر (خارج از پول) می‌خرد و پرمیوم خالص دریافت می‌کند، بدون نگهداری دارایی پایه. اگر قیمت تا تاریخ تمدید پایین‌تر از استرایک فروخته‌شده بماند سود می‌دهد؛ کال خریداری‌شده جلوی ضرر بزرگ در رشد شدید قیمت را می‌گیرد. راهی با ریسک تعریف‌شده برای جمع‌آوری پرمیوم با دیدگاه خنثی تا نزولی.",
    },
    category: "spread",
    holdsUnderlying: false,
    params: { rollPeriod: 30, innerOtmPercent: 5, widthPercent: 8, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [
      { type: "call", side: "short", offsetPercent: p.innerOtmPercent },
      { type: "call", side: "long", offsetPercent: p.innerOtmPercent + p.widthPercent },
    ],
  },
  ironCondor: {
    label: { en: "Iron Condor", fa: "آیرون کاندور (Iron Condor)" },
    description: {
      en: "Combines a Bull Put Spread and a Bear Call Spread every roll period for a net credit, no underlying held — profits if price stays inside the two short strikes through the roll date, with defined max loss on either side if it doesn't. The classic \"range-bound, sell the wings\" premium-collection strategy.",
      fa: "هر دوره یک بول پوت اسپرد و یک بیر کال اسپرد را با هم ترکیب می‌کند و پرمیوم خالص دریافت می‌کند، بدون نگهداری دارایی پایه — اگر قیمت تا تاریخ تمدید بین دو استرایک فروخته‌شده بماند سود می‌دهد، و در غیر این صورت در هر دو طرف حداکثر ضرر تعریف‌شده دارد. استراتژی کلاسیک «بازار رنج، بال‌ها را بفروش» برای جمع‌آوری پرمیوم.",
    },
    category: "spread",
    holdsUnderlying: false,
    params: { rollPeriod: 30, putOtmPercent: 8, callOtmPercent: 8, widthPercent: 6, volLookback: 30, riskFreeRate: 5 },
    legs: (p) => [
      { type: "put", side: "short", offsetPercent: -p.putOtmPercent },
      { type: "put", side: "long", offsetPercent: -(p.putOtmPercent + p.widthPercent) },
      { type: "call", side: "short", offsetPercent: p.callOtmPercent },
      { type: "call", side: "long", offsetPercent: p.callOtmPercent + p.widthPercent },
    ],
  },
};

const legSign = (leg) => (leg.side === "short" ? 1 : -1); // + = premium collected at open, - = premium paid
const legIntrinsic = (leg, spotAtExpiry) =>
  leg.type === "call" ? Math.max(spotAtExpiry - leg.strike, 0) : Math.max(leg.strike - spotAtExpiry, 0);
const legActionKey = (leg) => `${leg.side === "short" ? "sell" : "buy"}${leg.type === "call" ? "Call" : "Put"}`;

/**
 * Simulates periodically rolling one of the OPTIONS_STRATEGIES structures
 * over historical candles, mark-to-market every candle (not just at each
 * roll), and returns a { time, equity } curve in the exact shape
 * summarizeEquityCurve()/EquityChart already expect elsewhere in this app.
 *
 * Mechanics, once, rather than repeated per-strategy: at the open of each
 * roll period every leg the strategy defines is priced with Black-Scholes
 * using realized volatility over the last `volLookback` candles, its
 * premium is collected (short legs) or paid (long legs), and it's then
 * re-priced every subsequent candle (declining time to expiry, moving
 * spot) to mark the whole book to market — so the equity curve shows real
 * theta decay and delta exposure, not just a step function that jumps at
 * roll dates. At expiry every leg settles to its intrinsic value and the
 * next period opens (unless this was the last candle in history).
 *
 * This is entirely generic over `def.legs(params)` — it doesn't matter
 * whether a strategy has one leg (Covered Call) or four (Iron Condor), the
 * accounting is identical per leg and simply summed.
 */
export function runOptionsStrategy({ candles, kind, params, initialCapital = 10000 }) {
  const def = OPTIONS_STRATEGIES[kind];
  if (!def) {
    return { equityCurve: [], rolls: [], initialCapital, startIdx: 0, error: `استراتژی آپشن ناشناخته: ${kind}` };
  }

  const n = candles.length;
  const rollPeriod = Math.max(2, Math.round(params.rollPeriod) || 2);
  const volLookback = Math.max(5, Math.round(params.volLookback) || 5);
  const r = (params.riskFreeRate || 0) / 100;
  const periodsPerYear = periodsPerYearOf(candles);
  const yearsPerCandle = 1 / periodsPerYear;
  const holdsUnderlying = !!def.holdsUnderlying;

  const startIdx = volLookback;
  if (startIdx >= n - 1) {
    // i18n key, translated by the caller with t().
    return { equityCurve: [], rolls: [], initialCapital, startIdx: 0, error: "err.options.history" };
  }

  // Every strategy is sized against the SAME notional: "as many units of the
  // underlying as $initialCapital buys at the first roll date". Strategies
  // that hold the underlying (Covered Call, Protective Put) use that same
  // notional as their actual position size; strategies that don't (every
  // credit/debit spread, the straddle, the cash-secured put) still scale
  // their option legs by this same factor so premiums/payoffs are sized
  // consistently against the account rather than shrinking to a rounding
  // error against $100-of-underlying terms.
  const notionalUnits = initialCapital / candles[startIdx].close;
  const unitsHeld = holdsUnderlying ? notionalUnits : 0;

  const equityCurve = [];
  const rolls = [];
  let cumPremium = 0; // running realized cash flow: + collected, - paid, adjusted for settled payoffs at each expiry
  let periodStartIdx = startIdx;
  let legState = []; // this period's legs, each resolved to a concrete strike
  let sigma = null;
  let expiryIdx = null;

  function openNewPeriod(i) {
    const spot = candles[i].close;
    sigma = realizedVol(candles, i - volLookback, i) || 0.5; // sane fallback if the window is degenerate
    expiryIdx = Math.min(i + rollPeriod, n - 1);
    const T = (expiryIdx - i) * yearsPerCandle;
    legState = def.legs(params).map((leg) => ({ ...leg, strike: spot * (1 + leg.offsetPercent / 100) }));

    for (const leg of legState) {
      const { price } = blackScholes({ spot, strike: leg.strike, T, sigma, r, type: leg.type });
      const premium = notionalUnits * price;
      cumPremium += legSign(leg) * premium;
      rolls.push({ time: candles[i].time, action: legActionKey(leg), strike: leg.strike, sigma, premium });
    }
    periodStartIdx = i;
  }

  openNewPeriod(startIdx);

  for (let i = startIdx; i < n; i++) {
    if (i > periodStartIdx && i >= expiryIdx) {
      const spotAtExpiry = candles[i].close;
      for (const leg of legState) {
        cumPremium -= legSign(leg) * notionalUnits * legIntrinsic(leg, spotAtExpiry);
      }

      if (i < n - 1) {
        openNewPeriod(i);
      } else {
        const cashBase = holdsUnderlying ? unitsHeld * spotAtExpiry : initialCapital;
        equityCurve.push({ time: candles[i].time, equity: Math.max(0, cashBase + cumPremium) });
        break;
      }
    }

    const spot = candles[i].close;
    const T = Math.max(0, (expiryIdx - i) * yearsPerCandle);
    let liability = 0;
    for (const leg of legState) {
      const { price } = blackScholes({ spot, strike: leg.strike, T, sigma, r, type: leg.type });
      liability += legSign(leg) * notionalUnits * price;
    }

    // holdsUnderlying strategies are anchored by the underlying's own
    // marked-to-market value (which already sits at ~initialCapital from
    // the moment it was bought). Strategies with no underlying leg have no
    // such anchor, so without initialCapital as an explicit cash/margin
    // base here, their equity curve would track the option P&L alone — a
    // few hundred dollars of premium — as if THAT were the whole account,
    // instead of as a P&L overlay on top of the capital actually posted to
    // write it.
    const cashBase = holdsUnderlying ? unitsHeld * spot : initialCapital;
    const equity = Math.max(0, cashBase + cumPremium - liability);
    equityCurve.push({ time: candles[i].time, equity });
  }

  return { equityCurve, rolls, initialCapital, startIdx, unitsHeld };
}

/**
 * Run every strategy in OPTIONS_STRATEGIES (with its default params) on the
 * same candles and compare them against a Buy & Hold benchmark of the
 * underlying — the options-side equivalent of runAllStrategies() in
 * lib/backtest.js. Returns the EXACT SAME shape that function does
 * ({ benchmark, rows, summary, aggregateEquityCurve, aggregate }) so the
 * existing AggregateResults table/chart can render either kind of "run
 * all" comparison without needing a separate options-only view.
 */
export function runAllOptionsStrategies({ candles, strategies = OPTIONS_STRATEGIES, initialCapital = 10000 }) {
  const startIdx = 0;
  const benchmarkCurve = candles.map((c) => ({ time: c.time, equity: initialCapital * (c.close / candles[startIdx].close) }));
  const benchmark = summarizeEquityCurveLike(benchmarkCurve, initialCapital, candles);

  const rows = Object.entries(strategies)
    .map(([key, def]) => {
      const params = def.params;
      const sim = runOptionsStrategy({ candles, kind: key, params, initialCapital });
      const result = summarizeEquityCurveLike(sim.equityCurve, initialCapital, candles, benchmark.totalReturnPercent);
      result.tradeCount = sim.rolls.length;
      result.rolls = sim.rolls;
      result.isOptions = true;
      return {
        key,
        label: def.label,
        category: def.category,
        params,
        result,
        excessReturn: result.totalReturnPercent - benchmark.totalReturnPercent,
        beatsBenchmark: result.totalReturnPercent > benchmark.totalReturnPercent,
        supportsShort: false,
      };
    })
    .filter((row) => row.result.equityCurve.length > 0)
    .sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);

  const returns = rows.map((r) => r.result.totalReturnPercent);
  const sharpeRows = rows.filter((r) => Number.isFinite(r.result.sharpe));
  const bestBySharpe = sharpeRows.length
    ? sharpeRows.reduce((best, r) => (r.result.sharpe > best.result.sharpe ? r : best))
    : null;

  const summary = {
    count: rows.length,
    benchmarkReturn: benchmark.totalReturnPercent,
    best: rows[0] || null,
    worst: rows[rows.length - 1] || null,
    bestBySharpe,
    beatsBenchmark: rows.filter((r) => r.beatsBenchmark).length,
    profitable: rows.filter((r) => r.result.totalReturnPercent > 0).length,
    avgReturn: mean(returns),
    liquidated: 0,
  };

  const aggregateEquityCurve = averageEquityCurvesLike(rows, initialCapital);
  const aggregateResult = summarizeEquityCurveLike(aggregateEquityCurve, initialCapital, candles, benchmark.totalReturnPercent);

  return { benchmark, rows, summary, aggregateEquityCurve, aggregate: { equityCurve: aggregateEquityCurve, result: aggregateResult } };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function estimatePeriodsPerYear(candles) {
  if (candles.length < 2) return 365;
  const dt = candles[1].time - candles[0].time;
  if (dt <= 0) return 365;
  return (365 * 24 * 3600) / dt;
}

// Local copy of backtest.js's summarizeEquityCurve()/averageEquityCurves()
// shape, kept dependency-free here (this module never imports from
// backtest.js) so option strategies can be summarized and compared exactly
// like directional ones without introducing a cross-module import cycle.
function summarizeEquityCurveLike(equityCurve, initialCapital, candles, benchmarkReturnPercent = null) {
  if (!equityCurve?.length) {
    return {
      equityCurve: [],
      initialCapital,
      finalEquity: initialCapital,
      totalReturnPercent: 0,
      maxDrawdownPercent: 0,
      sharpe: null,
      sortino: null,
      benchmarkReturnPercent,
    };
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  return { equityCurve, initialCapital, finalEquity, totalReturnPercent, maxDrawdownPercent, sharpe, sortino, benchmarkReturnPercent };
}

function averageEquityCurvesLike(rows, initialCapital) {
  if (!rows?.length) return [];
  const length = rows[0]?.result?.equityCurve?.length || 0;
  if (!length) return [];
  const out = new Array(length);
  const rowCount = rows.length;
  for (let i = 0; i < length; i++) {
    let sumNorm = 0;
    for (let r = 0; r < rowCount; r++) {
      sumNorm += rows[r].result.equityCurve[i].equity / rows[r].result.initialCapital;
    }
    out[i] = { time: rows[0].result.equityCurve[i].time, equity: (sumNorm / rowCount) * initialCapital };
  }
  return out;
}
