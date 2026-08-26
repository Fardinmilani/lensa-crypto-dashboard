// Encode / decode custom strategy payloads for shareable URLs (no eval).

export function encodeStrategyPayload(payload) {
  try {
    const json = JSON.stringify(payload);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

export function decodeStrategyPayload(token) {
  if (!token) return null;
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function strategyShareUrl(payload, baseUrl = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "") {
  const token = encodeStrategyPayload(payload);
  if (!token) return null;
  return `${baseUrl}#backtest?strategy=${token}`;
}

export function parseStrategyFromHash(hash = "") {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(raw.slice(q + 1));
  const token = params.get("strategy");
  return decodeStrategyPayload(token);
}
