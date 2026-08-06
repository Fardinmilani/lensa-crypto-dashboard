// Small, dependency-free fetch helper for third-party JSON APIs that don't
// (or might not) set permissive CORS headers.
//
// Unlike lib/coingecko.js's own proxy logic -- which ONLY uses a private
// Cloudflare Worker (VITE_MARKET_PROXY_ENDPOINTS), because Binance/Bybit
// specifically need a *non-Iranian* IP to dodge geo-blocking, which only a
// self-hosted worker gives you -- this helper works with **zero
// deployment** by default. TSE/IRR-FX don't need to dodge geo-blocking,
// just CORS, so it reaches for a couple of free public CORS-proxy services
// first and only tries a private worker if one happens to be configured.
//
// IMPORTANT HONESTY NOTE #1: the public proxies below (allorigins.win,
// codetabs.com) are free, keyless, third-party services with real limits --
// published rates are roughly 20 req/min and 5 req/sec respectively, no
// uptime guarantee, and every request to *any* source (not just
// tsetmc/tgju) visibly passes through their servers. That's a reasonable
// trade for public, non-sensitive daily stock/FX quotes on a personal
// dashboard; it would NOT be a reasonable trade for anything private or
// high-volume. If these free proxies turn out to be too flaky in practice,
// add "tsetmc"/"tgju" to a deployed Worker's UPSTREAMS
// (cloudflare-proxy/worker.js already has both) and list that worker's URL
// in VITE_MARKET_PROXY_ENDPOINTS -- it's tried FIRST automatically the
// moment it's configured, no other code change needed.
//
// IMPORTANT HONESTY NOTE #2: whether tsetmc.com and tgju.org actually reject
// direct browser fetches -- and whether they, in turn, block requests
// coming from *these* public proxies' server IPs -- has NOT been verified
// against the live services (no outbound network route to any of these
// hosts from the sandbox this was written in). If every candidate below
// ends up failing, open the browser's Network tab: a 403/429 from
// allorigins/codetabs means their proxy itself got rate-limited or blocked
// by the upstream, which public proxies can't fully guarantee against.

const PRIVATE_PROXY_ENDPOINTS = String(import.meta.env?.VITE_MARKET_PROXY_ENDPOINTS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

let rrIndex = 0;
function rotatedPrivateProxies() {
  if (PRIVATE_PROXY_ENDPOINTS.length < 2) return PRIVATE_PROXY_ENDPOINTS;
  const i = rrIndex % PRIVATE_PROXY_ENDPOINTS.length;
  rrIndex += 1;
  return [...PRIVATE_PROXY_ENDPOINTS.slice(i), ...PRIVATE_PROXY_ENDPOINTS.slice(0, i)];
}

// Free, keyless, zero-deployment CORS proxies, tried (in this order) after
// any private worker and before a final direct-fetch attempt.
const PUBLIC_PROXY_BUILDERS = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

/**
 * Fetch JSON from `directUrl` through, in order: any configured private
 * Cloudflare Worker proxy (as `${proxyBase}/proxy/${source}${path}${search}`
 * -- `source` must match an UPSTREAMS key in cloudflare-proxy/worker.js),
 * then the public proxies above, then a final direct request.
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

  const privateCandidates = path ? rotatedPrivateProxies().map((base) => `${base}/proxy/${source}${path}${search}`) : [];
  const publicCandidates = PUBLIC_PROXY_BUILDERS.map((build) => build(directUrl));
  const candidates = [...privateCandidates, ...publicCandidates, directUrl];

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
        lastError = Object.assign(new Error(`HTTP ${res.status} fetching ${source} via ${new URL(url).host}`), { status: res.status });
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
