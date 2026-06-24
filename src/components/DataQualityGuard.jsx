import { readableDuration } from "../lib/dataQuality";
import { useMarket } from "../context/MarketContext";

export default function DataQualityGuard({ module, meta, analysisMarket, expectedTimeframe, forecastAnchor }) {
  const { market } = useMarket();
  const quality = meta?.quality;
  const issues = [...(quality?.issues || [])];

  if (expectedTimeframe && expectedTimeframe !== market.timeframe) {
    issues.push({ type: "timeframe-mismatch", severity: "failed", message: `Uses ${expectedTimeframe}, active chart is ${market.timeframe}.` });
  }
  if (analysisMarket && (analysisMarket.exchange !== market.exchange || analysisMarket.pair !== market.pair || analysisMarket.marketType !== market.marketType)) {
    issues.push({ type: "market-mismatch", severity: "failed", message: "Analysis market differs from active market context." });
  }
  if (forecastAnchor?.status && forecastAnchor.status !== "Healthy") {
    issues.push({ type: "forecast-anchor", severity: "failed", message: forecastAnchor.message || "Forecast does not start from the last valid candle." });
  }
  for (const warning of meta?.warnings || []) {
    issues.push({ type: warning.status, severity: "failed", message: `${warning.sourceLabel}: ${warning.status}` });
  }

  const failed = issues.some((issue) => issue.severity === "failed");
  const limited = issues.length > 0;
  const status = !meta ? "Waiting" : failed ? "Failed" : limited ? "Limited" : quality?.status || "Healthy";
  const confidence = Math.round((meta?.confidence ?? quality?.confidenceFactor ?? 1) * 100);
  const lastTime = quality?.lastCandleTime || market.lastValidCandleTime;

  return (
    <div className={`data-quality data-quality--${status.toLowerCase()}`}>
      <div className="data-quality__top">
        <strong>{module} data quality</strong>
        <span>{status === "Waiting" ? "Waiting for data" : status}</span>
        <span>Confidence cap {confidence}%</span>
      </div>
      <div className="data-quality__meta">
        <span>{market.pair}</span>
        <span>{market.marketType}</span>
        <span>{market.timeframe}</span>
        <span>{meta?.sourceLabel || market.exchange}</span>
        <span>{lastTime ? new Date(lastTime * 1000).toLocaleString() : "No candle"}</span>
        {quality?.expectedIntervalSeconds && <span>{readableDuration(quality.expectedIntervalSeconds)} candles</span>}
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
