import { useEffect, useState, useRef } from "react";
import { getMarketSnapshot, DEFAULT_COINS } from "../lib/coingecko";

const POLL_INTERVAL_MS = 30_000;

export function useMarketSnapshot(coins = DEFAULT_COINS) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const idsRef = useRef(coins.map((c) => c.id));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const snapshot = await getMarketSnapshot(idsRef.current);
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
  }, []);

  return { data, error, loading };
}
