import { formatPrice } from "../lib/priceFormat";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";

// Rendered ONCE per page (sticky, right under the page's own title/hero).
// Previously this bar was duplicated 3-4x per page (once per section) with a
// different `module` label each time, showing identical exchange/pair/quality
// data over and over -- that repetition was the #1 source of user confusion.
export default function MarketContextBar({ lastPrice }) {
  const { market } = useMarket();
  const { t } = useI18n();
  const lastTime = market.lastValidCandleTime
    ? new Date(market.lastValidCandleTime * 1000).toLocaleString()
    : t("context.noCandle");
  return (
    <div className="market-context-bar market-context-bar--sticky" role="status" aria-label={t("context.ariaLabel")}>
      <span>{market.exchange.toUpperCase()}</span>
      <span>{market.pair}</span>
      <span>{market.marketType}</span>
      <span>{market.timeframeMeta.label || market.timeframe}</span>
      <span>{t("context.source")} {market.dataSourceStatus}</span>
      <span>{t("context.quality")} {market.dataQualityStatus}</span>
      <span>{lastTime}</span>
      {lastPrice != null && (
        <span className="num">
          {formatPrice(lastPrice, market.precision, { currency: !market.isForex, mode: "trading" })}
        </span>
      )}
    </div>
  );
}
