import { useEffect, useState } from "react";
import TickerTape from "../components/TickerTape";
import PriceChart from "../components/PriceChart";
import NewsFeed from "../components/NewsFeed";
import TimeframePicker from "../components/TimeframePicker";
import { getCoinDetail } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";
import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

function fmtUsd(n, max = 2) {
  if (n == null) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: max })}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}
function fmtCompact(n) {
  if (n == null) return "—";
  return `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)}`;
}

export default function Dashboard() {
  const { coin } = useCoin();
  const { t } = useI18n();
  const [days, setDays] = useLocalStorageState("lensa.dashboardTimeframe", "4h");
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

      <div className="coin-hero glass-card reveal">
        <div className="coin-hero__id">
          {(detail?.image || coin.thumb) && (
            <img src={detail?.image || coin.thumb} alt="" width="44" height="44" />
          )}
          <div>
            <h1>
              {coin.name} <span className="coin-hero__sym">{coin.symbol}/USD</span>
              {detail?.rank && <span className="coin-hero__rank">#{detail.rank}</span>}
            </h1>
            <div className="coin-hero__price">
              <span className="num price-big">{fmtUsd(detail?.price)}</span>
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
          <Mini label={t("hero.vol24")} value={fmtCompact(detail?.volume24h)} />
          <Mini label={t("hero.mcap")} value={fmtCompact(detail?.marketCap)} />
          <Mini label={t("hero.high24")} value={fmtUsd(detail?.high24h)} />
          <Mini label={t("hero.low24")} value={fmtUsd(detail?.low24h)} />
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="chart-panel glass-card reveal">
          <div className="panel-header">
            <h2>{t("chart.title", { sym: coin.symbol })}</h2>
          </div>
          <TimeframePicker value={days} onChange={setDays} />
          <PriceChart coinId={coin.id} symbol={coin.symbol} days={days} />
        </div>

        <div className="reveal">
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
