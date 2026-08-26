import { useMemo, useState } from "react";
import { useI18n } from "../i18n/langStore";
import { formatUsd } from "../lib/priceFormat";

export default function TradeReplay({ trades, candles, precision }) {
  const { t } = useI18n();
  const list = trades || [];
  const [idx, setIdx] = useState(0);
  const trade = list[idx];
  const candleMap = useMemo(() => new Map((candles || []).map((c) => [c.time, c])), [candles]);

  if (!list.length) return null;

  const entryCandle = trade ? candleMap.get(trade.entryTime) : null;
  const exitCandle = trade ? candleMap.get(trade.exitTime) : null;

  return (
    <div className="glass-card replay-panel reveal">
      <div className="panel-header">
        <h2>{t("bt.replay.title")}</h2>
        <span className="panel-subtitle">{t("bt.replay.hint")}</span>
      </div>
      <div className="replay-controls">
        <button type="button" className="run-btn run-btn--ghost" disabled={idx <= 0} onClick={() => setIdx((i) => i - 1)}>
          {t("bt.replay.prev")}
        </button>
        <span className="replay-label">{t("bt.replay.trade", { n: idx + 1, total: list.length })}</span>
        <button type="button" className="run-btn run-btn--ghost" disabled={idx >= list.length - 1} onClick={() => setIdx((i) => i + 1)}>
          {t("bt.replay.next")}
        </button>
      </div>
      {trade && (
        <div className="replay-detail">
          <div>
            <strong>{t("bt.replay.entry")}</strong>
            <span className="num">{new Date(trade.entryTime * 1000).toLocaleString()}</span>
            {entryCandle && <span className="num"> @ {formatUsd(trade.entryPrice, precision, { mode: "trading" })}</span>}
          </div>
          <div>
            <strong>{t("bt.replay.exit")}</strong>
            <span className="num">{new Date(trade.exitTime * 1000).toLocaleString()}</span>
            {exitCandle && <span className="num"> @ {formatUsd(trade.exitPrice, precision, { mode: "trading" })}</span>}
          </div>
          <div className={`num pill ${trade.pnlPercent >= 0 ? "up" : "down"}`}>
            {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
          </div>
        </div>
      )}
    </div>
  );
}
