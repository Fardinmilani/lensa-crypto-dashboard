import { readableDuration } from "../lib/dataQuality";
import { useMarket } from "../context/MarketContext";
import { useI18n } from "../i18n/langStore";
import InfoTip from "./InfoTip";

function statusLabel(t, status) {
  const key = `decision.term.${status.toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : status;
}

export default function DataQualityGuard({ module, meta, analysisMarket, expectedTimeframe, forecastAnchor }) {
  const { market } = useMarket();
  const { t } = useI18n();
  const quality = meta?.quality;
  const issues = [...(quality?.issues || [])];

  if (expectedTimeframe && expectedTimeframe !== market.timeframe) {
    issues.push({
      type: "timeframe-mismatch",
      severity: "failed",
      message: t("dq.timeframeMismatch", { expected: expectedTimeframe, active: market.timeframe }),
    });
  }
  if (analysisMarket && (analysisMarket.exchange !== market.exchange || analysisMarket.pair !== market.pair || analysisMarket.marketType !== market.marketType)) {
    issues.push({ type: "market-mismatch", severity: "failed", message: t("dq.marketMismatch") });
  }
  if (forecastAnchor?.status && forecastAnchor.status !== "Healthy") {
    issues.push({
      type: "forecast-anchor",
      severity: "failed",
      message: forecastAnchor.message || t("dq.forecastAnchor"),
    });
  }
  for (const warning of meta?.warnings || []) {
    issues.push({
      type: warning.status,
      severity: "failed",
      message: t("dq.sourceWarning", { source: warning.sourceLabel, status: warning.status }),
    });
  }

  const failed = issues.some((issue) => issue.severity === "failed");
  const limited = issues.length > 0;
  const status = !meta ? "Waiting" : failed ? "Failed" : limited ? "Limited" : quality?.status || "Healthy";
  const confidence = Math.round((meta?.confidence ?? quality?.confidenceFactor ?? 1) * 100);
  const lastTime = quality?.lastCandleTime || market.lastValidCandleTime;

  return (
    <div className={`data-quality data-quality--${status.toLowerCase()}`}>
      <div className="data-quality__top">
        <strong>{t("dq.title", { module })}</strong>
        <span>{status === "Waiting" ? t("dq.waiting") : statusLabel(t, status)}</span>
        <span className="data-quality__cap">
          {t("dq.confidenceCap")} {confidence}%
          <InfoTip term="glossary.confidenceCap" />
        </span>
      </div>
      <div className="data-quality__meta">
        <span>{market.pair}</span>
        <span>{market.marketType}</span>
        <span>{market.timeframe}</span>
        <span>{meta?.sourceLabel || market.exchange}</span>
        <span>{lastTime ? new Date(lastTime * 1000).toLocaleString() : t("dq.noCandle")}</span>
        {quality?.expectedIntervalSeconds && (
          <span>{t("dq.candles", { duration: readableDuration(quality.expectedIntervalSeconds) })}</span>
        )}
      </div>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${issue.type}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
