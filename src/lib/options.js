// lib/options.js
// Black-Scholes European option pricing plus a periodic option-roll
// backtest engine (Covered Call / Protective Put / Short Straddle).
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
  volLookback: { en: "Volatility window (candles)", fa: "پنجره‌ی نوسان (کندل)" },
  riskFreeRate: { en: "Risk-free rate (%/yr)", fa: "نرخ بدون ریسک (%/سال)" },
};

export const OPTIONS_STRATEGIES = {
  coveredCall: {
    label: { en: "Covered Call", fa: "کاورد کال (Covered Call)" },
    description: {
      en: "Holds the underlying and sells an out-of-the-money call against it every roll period, collecting the premium as income. Upside is capped at the strike; downside is the same as holding the underlying outright, cushioned slightly by the premium collected. One of the most widely used real-world income strategies.",
      fa: "دارایی پایه را نگه می‌دارد و هر دوره یک کال خارج از پول روی آن می‌فروشد و پرمیوم را به‌عنوان درآمد جمع می‌کند. سقف سود در استرایک است؛ ریسک نزولی همان نگهداری مستقیم دارایی است، فقط کمی با پرمیوم جمع‌شده نرم می‌شود. یکی از پرکاربردترین استراتژی‌های درآمدی واقعی.",
    },
    params: { rollPeriod: 30, otmPercent: 5, volLookback: 30, riskFreeRate: 5 },
  },
  protectivePut: {
    label: { en: "Protective Put", fa: "پروتکتیو پوت (Protective Put)" },
    description: {
      en: "Holds the underlying and buys an out-of-the-money put every roll period as insurance, paying the premium as a cost. Downside is floored at the strike (minus the premium paid); upside stays uncapped, reduced by that same recurring cost — the options equivalent of paying for insurance.",
      fa: "دارایی پایه را نگه می‌دارد و هر دوره یک پوت خارج از پول به‌عنوان بیمه می‌خرد و پرمیوم را به‌عنوان هزینه می‌پردازد. کف ریسک نزولی در استرایک است (منهای پرمیوم پرداختی)؛ سود صعودی سقف ندارد ولی با همین هزینه‌ی تکرارشونده کم می‌شود — معادل آپشنی خرید بیمه.",
    },
    params: { rollPeriod: 30, otmPercent: 5, volLookback: 30, riskFreeRate: 5 },
  },
  shortStraddle: {
    label: { en: "Short Straddle (volatility harvesting)", fa: "شورت استرادل (برداشت نوسان)" },
    description: {
      en: "Sells an at-the-money call AND put every roll period with no underlying position at all — a pure bet that realized volatility comes in below what the priced-in (historical) volatility implied. Profits from time decay in quiet markets; losses grow without limit if price moves far from the strike before the roll date. Shown for illustration of the volatility-risk-premium concept — this is the highest-risk strategy in this whole tool.",
      fa: "هر دوره یک کال و یک پوت در‌پول (ATM) می‌فروشد، بدون هیچ پوزیشنی روی خود دارایی — یک شرط خالص روی این‌که نوسان واقعی کمتر از نوسان قیمت‌گذاری‌شده (تاریخی) از آب دربیاید. در بازارهای آرام از فروپاشی زمانی سود می‌برد؛ اگر قیمت قبل از تاریخ تمدید از استرایک فاصله‌ی زیادی بگیرد، ضرر بدون سقف رشد می‌کند. برای نمایش مفهوم صرف ریسک نوسان آمده — پرریسک‌ترین استراتژی این ابزار است.",
    },
    params: { rollPeriod: 14, volLookback: 30, riskFreeRate: 5 },
  },
};

/**
 * Simulates periodically rolling one of the OPTIONS_STRATEGIES structures
 * over historical candles, mark-to-market every candle (not just at each
 * roll), and returns a { time, equity } curve in the exact shape
 * summarizeEquityCurve()/EquityChart already expect elsewhere in this app.
 *
 * Mechanics, once, rather than repeated per-strategy below: at the open of
 * each roll period the strategy's option leg(s) are priced with
 * Black-Scholes using realized volatility over the last `volLookback`
 * candles, the premium is collected (short legs) or paid (long legs), and
 * that leg is then re-priced every subsequent candle (declining time to
 * expiry, moving spot) to mark the position to market — so the equity
 * curve shows real theta decay and delta exposure, not just a step
 * function that jumps at roll dates.
 */
export function runOptionsStrategy({ candles, kind, params, initialCapital = 10000 }) {
  const n = candles.length;
  const rollPeriod = Math.max(2, Math.round(params.rollPeriod) || 2);
  const volLookback = Math.max(5, Math.round(params.volLookback) || 5);
  const otm = (params.otmPercent || 0) / 100;
  const r = (params.riskFreeRate || 0) / 100;
  const periodsPerYear = periodsPerYearOf(candles);
  const yearsPerCandle = 1 / periodsPerYear;

  const startIdx = volLookback;
  if (startIdx >= n - 1) {
    return { equityCurve: [], rolls: [], initialCapital, startIdx: 0, error: "تاریخچه‌ی کافی برای این پارامترها وجود ندارد — بازه‌ی زمانی طولانی‌تری انتخاب کنید یا پنجره‌ی نوسان را کوتاه‌تر کنید." };
  }

  const holdsUnderlying = kind !== "shortStraddle";
  // Every strategy is sized against the SAME notional: "as many units of the
  // underlying as $initialCapital buys at the first roll date". For
  // coveredCall/protectivePut that notional is also the actual underlying
  // position held. shortStraddle holds none of the underlying, but its
  // option legs must still be scaled by this same notionalUnits factor —
  // otherwise the premium/payoff would be priced in raw per-unit-of-$100
  // terms while equity is tracked in $initialCapital terms, silently
  // shrinking the option leg to a rounding error against the account size.
  const notionalUnits = initialCapital / candles[startIdx].close;
  const unitsHeld = holdsUnderlying ? notionalUnits : 0;

  const equityCurve = [];
  const rolls = [];
  let cumPremium = 0; // running realized premium: + collected, - paid, adjusted for settled payoffs
  let periodStartIdx = startIdx;
  let strike = null;
  let sigma = null;
  let expiryIdx = null;

  function openNewPeriod(i) {
    const spot = candles[i].close;
    sigma = realizedVol(candles, i - volLookback, i) || 0.5; // sane fallback if the window is degenerate
    expiryIdx = Math.min(i + rollPeriod, n - 1);
    const T = (expiryIdx - i) * yearsPerCandle;
    if (kind === "coveredCall") {
      strike = spot * (1 + otm);
      const { price } = blackScholes({ spot, strike, T, sigma, r, type: "call" });
      cumPremium += notionalUnits * price;
      rolls.push({ time: candles[i].time, action: "sellCall", strike, sigma, premium: notionalUnits * price });
    } else if (kind === "protectivePut") {
      strike = spot * (1 - otm);
      const { price } = blackScholes({ spot, strike, T, sigma, r, type: "put" });
      cumPremium -= notionalUnits * price;
      rolls.push({ time: candles[i].time, action: "buyPut", strike, sigma, premium: notionalUnits * price });
    } else {
      strike = spot;
      const callPrice = blackScholes({ spot, strike, T, sigma, r, type: "call" }).price;
      const putPrice = blackScholes({ spot, strike, T, sigma, r, type: "put" }).price;
      cumPremium += notionalUnits * (callPrice + putPrice);
      rolls.push({ time: candles[i].time, action: "sellStraddle", strike, sigma, premium: notionalUnits * (callPrice + putPrice) });
    }
    periodStartIdx = i;
  }

  openNewPeriod(startIdx);

  for (let i = startIdx; i < n; i++) {
    if (i > periodStartIdx && i >= expiryIdx) {
      const spotAtExpiry = candles[i].close;
      if (kind === "coveredCall") cumPremium -= notionalUnits * Math.max(spotAtExpiry - strike, 0);
      else if (kind === "protectivePut") cumPremium += notionalUnits * Math.max(strike - spotAtExpiry, 0);
      else cumPremium -= notionalUnits * Math.abs(spotAtExpiry - strike);

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
    let liability;
    if (kind === "coveredCall") {
      liability = notionalUnits * blackScholes({ spot, strike, T, sigma, r, type: "call" }).price;
    } else if (kind === "protectivePut") {
      liability = -notionalUnits * blackScholes({ spot, strike, T, sigma, r, type: "put" }).price; // an asset, not a liability
    } else {
      liability =
        notionalUnits *
        (blackScholes({ spot, strike, T, sigma, r, type: "call" }).price +
          blackScholes({ spot, strike, T, sigma, r, type: "put" }).price);
    }

    // holdsUnderlying strategies are anchored by the underlying's own
    // marked-to-market value (which already sits at ~initialCapital from
    // the moment it was bought). shortStraddle holds no underlying at all,
    // so without initialCapital as an explicit cash/margin base here, its
    // equity curve would track the option P&L alone — a few hundred
    // dollars of premium — as if THAT were the whole account, instead of
    // as a P&L overlay on top of the capital actually posted to write it.
    const cashBase = holdsUnderlying ? unitsHeld * spot : initialCapital;
    const equity = Math.max(0, cashBase + cumPremium - liability);
    equityCurve.push({ time: candles[i].time, equity });
  }

  return { equityCurve, rolls, initialCapital, startIdx, unitsHeld };
}
