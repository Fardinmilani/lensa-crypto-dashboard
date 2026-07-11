import { useEffect, useState } from "react";

function readStoredValue(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function useLocalStorageState(key, initialValue) {
  const [storedKey, setStoredKey] = useState(key);
  const [value, setValue] = useState(() => readStoredValue(key, initialValue));

  // Most callers use a static, never-changing key, but ChartDrawingLayer
  // keys this per chart identity (exchange/market/symbol/timeframe) so each
  // chart's drawings are cached separately. Without this re-sync, switching
  // that key would keep serving the *previous* key's in-memory value, and
  // the effect below would then persist that stale value into the *new*
  // key — silently overwriting whatever drawings were already saved there.
  // Updating state during render (rather than in an effect) is the pattern
  // React recommends for resetting state when a prop/derived key changes:
  // it resolves before anything commits, so no stale-value flash or extra
  // render is observable, and it's the same idiom PriceChart already uses
  // for resetting lookbackDays when the chart identity changes.
  if (storedKey !== key) {
    setStoredKey(key);
    setValue(readStoredValue(key, initialValue));
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* localStorage may be unavailable in private or locked-down contexts */
    }
  }, [key, value]);

  return [value, setValue];
}
