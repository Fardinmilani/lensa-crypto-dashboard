import { useEffect, useState } from "react";
import TickerTape from "../components/TickerTape";
import PriceChart from "../components/PriceChart";
import NewsFeed from "../components/NewsFeed";
import TimeframePicker from "../components/TimeframePicker";
import SymbolSearch from "../components/SymbolSearch";
import MarketContextBar from "../components/MarketContextBar";
import { getCoinDetail } from "../lib/coingecko";
import { formatPrice, formatUsd } from "../lib/priceFormat";
import { useCoin } from "../context/coinStore";
import { MARKET_TYPES, useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";

function fmtCompact(n) {
  if (n == null) return "-";
  return `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)}`;
}

export default function Dashboard() {
  const { coin } = useCoin();
  const { market, setExchange, setPair, setTimeframe, setMarketType } = useMarket();
  const { t } = useI18n();
  const [chartType, setChartType] = useState("candles");
  const [detail, setDetail] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const reveal = useStaggerReveal([coin.id]);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function refresh({ clear = false } = {}) {
      if (clear) setDetail(null);
      try {
        const d = await getCoinDetail(coin.id, 12_000);
        if (!cancelled) {
          setDetail(d);
          setUpdatedAt(new Date());
        }
      } catch {
        /* keep last-known/empty detail */
      }
    }
    refresh({ clear: true });
    timer = window.setInterval(() => refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coin.id]);

  const change24 = detail?.change24h;
  const up = (change24 ?? 0) >= 0;

  return (
    <div className="dashboard" ref={reveal}>
      <TickerTape />
      <MarketContextBar module="Watchlist" lastPrice={detail?.price} />

      <div className="coin-hero glass-card reveal">
        <div className="coin-hero__id">
          {(detail?.image || coin.thumb) && <img src={detail?.image || coin.thumb} alt="" width="44" height="44" />}
          <div>
            <h1>
              {coin.name} <span className="coin-hero__sym">{market.pair}</span>
              {detail?.rank && <span className="coin-hero__rank">#{detail.rank}</span>}
            </h1>
            <div className="coin-hero__price">
              <span className="num price-big">
                {market.isForex ? formatPrice(detail?.price, market.precision) : formatUsd(detail?.price, market.precision)}
              </span>
              {change24 != null && (
                <span className={`num pill ${up ? "up" : "down"}`}>
                  {up ? "▲" : "▼"} {Math.abs(change24).toFixed(2)}%
                </span>
              )}
              {updatedAt && <span className="live-pill">{t("hero.live", { time: updatedAt.toLocaleTimeString() })}</span>}
            </div>
          </div>
        </div>
        <div className="coin-hero__stats">
          {!market.isForex && <Mini label={t("hero.vol24")} value={fmtCompact(detail?.volume24h)} />}
          {!market.isForex && <Mini label={t("hero.mcap")} value={fmtCompact(detail?.marketCap)} />}
          <Mini
            label={t("hero.high24")}
            value={market.isForex ? formatPrice(detail?.high24h, market.precision) : formatUsd(detail?.high24h, market.precision)}
          />
          <Mini
            label={t("hero.low24")}
            value={market.isForex ? formatPrice(detail?.low24h, market.precision) : formatUsd(detail?.low24h, market.precision)}
          />
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="chart-panel glass-card reveal">
          <div className="panel-header">
            <h2>{t("chart.title", { sym: coin.symbol })}</h2>
          </div>
          <MarketContextBar module="Chart + Drawings" lastPrice={detail?.price} />
          <div className="chart-toolbar no-print">
            <TimeframePicker value={market.timeframe} onChange={setTimeframe} intradayDisabled={market.isForex} />
            <SymbolSearch
              coin={coin}
              source={market.exchange}
              pair={market.pair}
              onSelect={({ source, pair }) => {
                setExchange(source);
                setPair(pair);
              }}
            />
            {!market.isForex && (
              <div className="chart-toolbar__field">
                <label>Market</label>
                <select value={market.marketType} onChange={(e) => setMarketType(e.target.value)}>
                  {MARKET_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="chart-toolbar__field">
              <label>{t("chart.type")}</label>
              <select value={chartType} onChange={(e) => setChartType(e.target.value)}>
                <option value="candles">{t("chart.type.candles")}</option>
                <option value="bars">{t("chart.type.bars")}</option>
                <option value="line">{t("chart.type.line")}</option>
                <option value="area">{t("chart.type.area")}</option>
              </select>
            </div>
          </div>
          <PriceChart
            coinId={coin.id}
            symbol={coin.symbol}
            days={market.timeframe}
            source={market.exchange}
            pair={market.pair}
            marketType={market.marketType}
            chartType={chartType}
          />
        </div>

        <div className="reveal">
          <MarketContextBar module="News" lastPrice={detail?.price} />
          <NewsFeed query={`${coin.symbol} ${coin.name}`} coinSymbol={coin.symbol} />
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div className="mini-stat">
      <span className="mini-stat__label">{label}</span>
      <span className="mini-stat__value num">{value}</span>
    </div>
  );
}
