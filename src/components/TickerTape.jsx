import { useMarketSnapshot } from "../hooks/useMarketSnapshot";
import { useI18n } from "../i18n/langStore";
import { formatPrice } from "../lib/priceFormat";

export default function TickerTape() {
  const { data, loading, error } = useMarketSnapshot();
  const { t } = useI18n();

  if (loading) {
    return <div className="ticker-tape ticker-tape--loading">{t("ticker.loading")}</div>;
  }
  if (error) {
    return <div className="ticker-tape ticker-tape--error">{t("ticker.error", { e: error })}</div>;
  }

  return (
    <div className="ticker-tape" role="status" aria-live="polite">
      {data.map((coin) => {
        const change = coin.price_change_percentage_24h;
        const isUp = change >= 0;
        return (
          <div className="ticker-item" key={coin.id}>
            <span className="ticker-symbol">{coin.symbol.toUpperCase()}</span>
            <span className="ticker-price num">{formatPrice(coin.current_price, {}, { currency: true })}</span>
            <span className={`ticker-change num ${isUp ? "up" : "down"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
