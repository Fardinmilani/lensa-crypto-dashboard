/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { defaultPairForSymbol, getSourceHealth, resolveTimeframe } from "../lib/coingecko";
import { isForexCoinId } from "../lib/forex";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useCoin } from "./coinStore";

const MarketContext = createContext(null);

export const MARKET_TYPES = ["Spot", "USD-M Futures", "Coin-M Futures"];
// Forex has no leveraged-futures concept here (Binance/Bybit/OKX/Coinbase
// don't list fiat-vs-fiat futures), and it only has one possible data
// source (Frankfurter), so its market-type/exchange choices collapse to
// a single fixed combination rather than reusing the crypto picker lists.
const FOREX_EXCHANGE = "frankfurter";
const FOREX_MARKET_TYPE = "Spot";

export function MarketProvider({ children }) {
  const { coin } = useCoin();
  const isForex = isForexCoinId(coin.id);
  const [exchange, setExchange] = useLocalStorageState("lensa.market.exchange", "binance");
  const [pair, setPair] = useLocalStorageState("lensa.market.pair", defaultPairForSymbol(coin.symbol));
  const [marketType, setMarketType] = useLocalStorageState("lensa.market.type", "Spot");
  const [timeframe, setStoredTimeframe] = useLocalStorageState("lensa.market.timeframe", "4h");
  const [historicalRange, setHistoricalRange] = useLocalStorageState("lensa.market.range", "4h");
  const [lastValidCandleTime, setLastValidCandleTime] = useLocalStorageState("lensa.market.lastCandle", null);
  const [dataSourceStatus, setDataSourceStatus] = useLocalStorageState("lensa.market.sourceStatus", "Limited");
  const [dataQualityStatus, setDataQualityStatus] = useLocalStorageState("lensa.market.qualityStatus", "Limited");
  const [precision, setPrecision] = useLocalStorageState("lensa.market.precision", {});

  useEffect(() => {
    const base = String(coin.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cleanPair = String(pair || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (base && !cleanPair.startsWith(base)) setPair(defaultPairForSymbol(coin.symbol));
  }, [coin.symbol, pair, setPair]);

  // `precision` is persisted to localStorage so a returning visitor doesn't
  // flash unformatted numbers before the first fetch resolves, but that
  // persistence means it would otherwise carry the PREVIOUS coin's exchange
  // tick size/decimals across a coin switch until the new coin's own
  // metadata arrives — e.g. showing EUR/USD with Bitcoin's 2-decimal
  // precision for a moment, or worse, a stale 0-decimal value from an
  // earlier failed precision fetch. Clearing it on every coin change forces
  // a clean fall-back to formatPrice()'s price-magnitude auto-detection
  // until fresh metadata (if any) replaces it.
  useEffect(() => {
    setPrecision({});
  }, [coin.id, setPrecision]);

  // Forex has exactly one valid (exchange, marketType) combination and only
  // ever produces daily candles (see lib/forex.js), so switching to a forex
  // pair snaps these into place automatically rather than leaving whatever
  // crypto exchange/futures/intraday-timeframe selection was previously
  // active, which would otherwise silently produce the broken
  // CoinGecko/Binance-futures requests this fix addresses.
  useEffect(() => {
    if (!isForex) return;
    if (exchange !== FOREX_EXCHANGE) setExchange(FOREX_EXCHANGE);
    if (marketType !== FOREX_MARKET_TYPE) setMarketType(FOREX_MARKET_TYPE);
    if (resolveTimeframe(timeframe).intraday) {
      setStoredTimeframe("1d");
      setHistoricalRange("1d");
    }
  }, [isForex, exchange, marketType, timeframe, setExchange, setMarketType, setStoredTimeframe, setHistoricalRange]);

  const context = useMemo(() => {
    const tf = resolveTimeframe(timeframe);
    return {
      coin,
      isForex,
      exchange,
      symbol: coin.symbol,
      pair,
      marketType,
      timeframe,
      historicalRange,
      timeframeMeta: tf,
      lastValidCandleTime,
      dataSourceStatus,
      dataQualityStatus,
      sourceHealth: getSourceHealth(),
      precision,
    };
  }, [coin, isForex, exchange, pair, marketType, timeframe, historicalRange, lastValidCandleTime, dataSourceStatus, dataQualityStatus, precision]);

  const updateFromCandles = useCallback((candles) => {
    const last = candles?.at?.(-1);
    if (last?.time) setLastValidCandleTime(last.time);
    if (candles?.meta?.status) setDataSourceStatus(candles.meta.status);
    if (candles?.meta?.quality?.status) setDataQualityStatus(candles.meta.quality.status);
    if (candles?.meta?.precision) setPrecision(candles.meta.precision);
  }, [setLastValidCandleTime, setDataSourceStatus, setDataQualityStatus, setPrecision]);

  const updatePrecision = useCallback((next) => {
    setPrecision(next || {});
  }, [setPrecision]);

  const setTimeframe = useCallback((next) => {
    setStoredTimeframe(next);
    setHistoricalRange(next);
  }, [setStoredTimeframe, setHistoricalRange]);

  const value = useMemo(() => ({
    market: context,
    setExchange,
    setPair,
    setMarketType,
    setTimeframe,
    setHistoricalRange,
    updateFromCandles,
    updatePrecision,
  }), [context, setExchange, setPair, setMarketType, setTimeframe, setHistoricalRange, updateFromCandles, updatePrecision]);

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error("useMarket must be used inside MarketProvider");
  return ctx;
}
