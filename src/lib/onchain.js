// Lightweight public sentiment / market context (no API keys).

export async function fetchFearGreedIndex() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const row = json?.data?.[0];
    if (!row) return { error: "empty" };
    return {
      value: Number(row.value),
      label: row.value_classification,
      time: Number(row.timestamp),
    };
  } catch (err) {
    return { error: err?.message || "unavailable" };
  }
}

export async function fetchGlobalMarketLite() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const d = json?.data;
    if (!d) return { error: "empty" };
    return {
      btcDominance: d.market_cap_percentage?.btc,
      marketCapChange24h: d.market_cap_change_percentage_24h_usd,
      totalVolume: d.total_volume?.usd,
    };
  } catch (err) {
    return { error: err?.message || "unavailable" };
  }
}
