import { useEffect, useState, useMemo } from "react";
import { getMarketSnapshot, DEFAULT_COINS } from "../lib/coingecko";

const POLL_INTERVAL_MS = 30_000;

export function useMarketSnapshot(coins = DEFAULT_COINS) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Join into a stable string key so a caller passing a fresh array literal
  // each render doesn't retrigger the effect — but a genuinely different
  // coin list DOES restart polling (the old ref-based capture silently
  // ignored any change to `coins` after mount).
  const idsKey = useMemo(() => coins.map((c) => c.id).join(","), [coins]);

  // Reset to the loading state the moment the coin list changes (render-time
  // reset-on-key-change pattern, not an effect, to avoid a cascading render).
  const [prevIdsKey, setPrevIdsKey] = useState(idsKey);
  if (prevIdsKey !== idsKey) {
    setPrevIdsKey(idsKey);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey.split(",").filter(Boolean);

    async function load() {
      try {
        const snapshot = await getMarketSnapshot(ids);
        if (!cancelled) {
          setData(snapshot);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey]);

  return { data, error, loading };
}
