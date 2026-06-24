import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { defaultPairForSymbol, getSourceHealth, resolveTimeframe } from "../lib/coingecko";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { useCoin } from "./coinStore";

const MarketContext = createContext(null);

export const MARKET_TYPES = ["Spot", "USD-M Futures", "Coin-M Futures"];

export function MarketProvider({ children }) {
  const { coin } = useCoin();
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

  const context = useMemo(() => {
    const tf = resolveTimeframe(timeframe);
    return {
      coin,
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
  }, [coin, exchange, pair, marketType, timeframe, historicalRange, lastValidCandleTime, dataSourceStatus, dataQualityStatus, precision]);

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
