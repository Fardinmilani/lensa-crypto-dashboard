import { formatPrice } from "../lib/priceFormat";
import { useMarket } from "../context/MarketContext";

export default function MarketContextBar({ module, lastPrice }) {
  const { market } = useMarket();
  const lastTime = market.lastValidCandleTime
    ? new Date(market.lastValidCandleTime * 1000).toLocaleString()
    : "No candle yet";
  return (
    <div className="market-context-bar" role="status" aria-label={`${module} market context`}>
      <strong>{module}</strong>
      <span>{market.exchange.toUpperCase()}</span>
      <span>{market.pair}</span>
      <span>{market.marketType}</span>
      <span>{market.timeframeMeta.label || market.timeframe}</span>
      <span>Source {market.dataSourceStatus}</span>
      <span>Quality {market.dataQualityStatus}</span>
      <span>{lastTime}</span>
      {lastPrice != null && <span className="num">{formatPrice(lastPrice, market.precision, { currency: true, mode: "trading" })}</span>}
    </div>
  );
}
