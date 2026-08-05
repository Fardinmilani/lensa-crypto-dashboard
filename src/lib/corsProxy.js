// Small, dependency-free fetch helper for third-party JSON APIs that don't
// (or might not) set permissive CORS headers, routed through the same
// Cloudflare Worker proxy fleet already used for the geo-blocked crypto
// exchanges (see cloudflare-proxy/worker.js and the proxy logic inside
// lib/coingecko.js).
//
// This is intentionally its OWN leaf module rather than something exported
// from lib/coingecko.js: coingecko.js already imports search/candle
// functions FROM lib/forex.js (and now lib/tse.js and lib/irrfx.js), so
// having those modules import back from coingecko.js would create an
// import cycle. Duplicating this ~40-line helper is a smaller risk than a
// circular dependency between the core data modules.
//
// IMPORTANT HONESTY NOTE: whether tsetmc.com and tgju.org actually reject
// direct browser fetches has NOT been verified against the live services —
// this project's build/dev sandbox has no network route to either host, so
// this could only be written against publicly documented/reverse-engineered
// endpoint shapes, not exercised end-to-end. Both sources are proxied by
// default below, since that's the safer assumption for a random third-party
// origin (most Iranian financial-data sites serve their own site's
// TradingView widgets only, with no Access-Control-Allow-Origin for other
// pages). Please verify against the live sources after deploying; if a
// proxied call comes back 404, double check the source key below matches
// an UPSTREAMS entry in cloudflare-proxy/worker.js.

const PROXY_ENDPOINTS = String(import.meta.env?.VITE_MARKET_PROXY_ENDPOINTS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

let rrIndex = 0;
function rotatedProxies() {
  if (PROXY_ENDPOINTS.length < 2) return PROXY_ENDPOINTS;
  const i = rrIndex % PROXY_ENDPOINTS.length;
  rrIndex += 1;
  return [...PROXY_ENDPOINTS.slice(i), ...PROXY_ENDPOINTS.slice(0, i)];
}

/**
 * Fetch JSON from `directUrl`, trying each configured Cloudflare Worker
 * proxy (as `${proxyBase}/proxy/${source}${path}${search}`) before falling
 * back to a direct request. `source` must match an UPSTREAMS key in
 * cloudflare-proxy/worker.js.
 */
export async function fetchJsonViaProxy(source, directUrl, { timeoutMs = 10_000 } = {}) {
  let path = "";
  let search = "";
  try {
    const u = new URL(directUrl);
    path = u.pathname;
    search = u.search;
  } catch {
    // Not an absolute URL — nothing to rewrite for a proxy, just try it as-is.
  }

  const candidates = path
    ? [...rotatedProxies().map((base) => `${base}/proxy/${source}${path}${search}`), directUrl]
    : [directUrl];

  let lastError;
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        mode: "cors",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = Object.assign(new Error(`HTTP ${res.status} from ${source}`), { status: res.status });
        continue;
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error(`${source} request failed`);
}
