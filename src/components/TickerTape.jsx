import { useMarketSnapshot } from "../hooks/useMarketSnapshot";

function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export default function TickerTape() {
  const { data, loading, error } = useMarketSnapshot();

  if (loading) {
    return <div className="ticker-tape ticker-tape--loading">در حال دریافت قیمت‌ها…</div>;
  }
  if (error) {
    return <div className="ticker-tape ticker-tape--error">خطا در دریافت قیمت‌ها: {error}</div>;
  }

  return (
    <div className="ticker-tape" role="status" aria-live="polite">
      {data.map((coin) => {
        const change = coin.price_change_percentage_24h;
        const isUp = change >= 0;
        return (
          <div className="ticker-item" key={coin.id}>
            <span className="ticker-symbol">{coin.symbol.toUpperCase()}</span>
            <span className="ticker-price num">${formatPrice(coin.current_price)}</span>
            <span className={`ticker-change num ${isUp ? "up" : "down"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
