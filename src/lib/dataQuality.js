const SOURCE_STATUS = {
  FAILED: "Failed",
  CORS_BLOCKED: "CORS blocked",
  RATE_LIMITED: "Rate limited",
  LIMITED: "Limited",
};

export function readableDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export function fillCandleGaps(candles, intervalSeconds) {
  if (!Array.isArray(candles) || candles.length < 2 || !intervalSeconds) {
    return { candles: candles || [], syntheticCount: 0 };
  }
  const expected = Math.max(1, Math.round(intervalSeconds));
  const out = [candles[0]];
  let syntheticCount = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1];
    const current = candles[i];
    const gap = current.time - prev.time;
    const missing = Math.max(0, Math.round(gap / expected) - 1);
    for (let j = 1; j <= missing && j <= 250; j++) {
      const time = prev.time + expected * j;
      out.push({
        time,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: 0,
        synthetic: true,
      });
      syntheticCount += 1;
    }
    out.push(current);
  }
  return { candles: out, syntheticCount };
}

export function analyzeCandleQuality({ candles, intervalSeconds, sourceMeta, market, expectedTimeframe, analysisMarket }) {
  const issues = [];
  const status = sourceMeta?.status || SOURCE_STATUS.LIMITED;
  const last = candles?.at?.(-1) || null;
  const expected = Math.max(1, Math.round(intervalSeconds || 0));
  const nowSeconds = Date.now() / 1000;
  let gapCount = 0;
  let maxGapSeconds = 0;
  const syntheticCount = (candles || []).filter((c) => c.synthetic).length;

  for (let i = 1; i < (candles?.length || 0); i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (expected && delta > expected * 1.5) {
      gapCount += Math.max(1, Math.round(delta / expected) - 1);
      maxGapSeconds = Math.max(maxGapSeconds, delta);
    }
  }

  if (!candles?.length) issues.push({ type: "missing", severity: "failed", message: "No candles were returned." });
  if (gapCount > 0) issues.push({ type: "gaps", severity: "limited", message: `${gapCount} missing candle slot(s); largest gap ${readableDuration(maxGapSeconds)}.` });
  else if (syntheticCount > 0) issues.push({ type: "gaps", severity: "limited", message: `${syntheticCount} missing candle slot(s) were filled for visual continuity.` });
  if (last && expected && nowSeconds - last.time > expected * 3) {
    issues.push({ type: "stale", severity: "limited", message: `Last candle is stale by ${readableDuration(nowSeconds - last.time)}.` });
  }
  if ([SOURCE_STATUS.FAILED, SOURCE_STATUS.CORS_BLOCKED, SOURCE_STATUS.RATE_LIMITED].includes(status)) {
    issues.push({ type: "source", severity: "failed", message: `Data source status: ${status}.` });
  }
  if (expectedTimeframe && market?.timeframe !== expectedTimeframe) {
    issues.push({ type: "timeframe-mismatch", severity: "failed", message: `Analysis timeframe ${expectedTimeframe} does not match chart timeframe ${market.timeframe}.` });
  }
  if (analysisMarket && market && (analysisMarket.exchange !== market.exchange || analysisMarket.pair !== market.pair || analysisMarket.marketType !== market.marketType)) {
    issues.push({ type: "market-mismatch", severity: "failed", message: "Analysis market does not match the active chart market." });
  }

  const failed = issues.some((issue) => issue.severity === "failed");
  const limited = issues.some((issue) => issue.severity === "limited");
  const confidenceFactor = failed ? 0.45 : limited ? Math.max(0.55, 1 - issues.length * 0.12) : 1;
  return {
    status: failed ? "Failed" : limited ? "Limited" : "Healthy",
    issues,
    gapCount,
    syntheticCount,
    maxGapSeconds,
    lastCandleTime: last?.time || null,
    expectedIntervalSeconds: expected || null,
    confidenceFactor,
  };
}

export function checkForecastAnchor({ history, cone, stepSeconds }) {
  const last = history?.at?.(-1);
  const firstProjectionStep = cone?.[0]?.step;
  if (!last || !firstProjectionStep || !stepSeconds) return null;
  const expectedFirst = last.time + firstProjectionStep * stepSeconds;
  return {
    status: "Healthy",
    issues: [],
    anchorTime: last.time,
    firstProjectionTime: expectedFirst,
    message: `Forecast starts from ${new Date(last.time * 1000).toLocaleString()}.`,
  };
}

export function qualityMetaFromError(error, sourceLabel = "Selected source") {
  return {
    sourceLabel,
    status: "Failed",
    confidence: 0.2,
    warnings: [{ sourceLabel, status: "Failed", message: error?.message || String(error) }],
    quality: {
      status: "Failed",
      issues: [{ type: "source", severity: "failed", message: error?.message || String(error) }],
      confidenceFactor: 0.2,
      lastCandleTime: null,
      expectedIntervalSeconds: null,
    },
  };
}
