/**
 * Lensa market-data CORS proxy.
 *
 * lensa-crypto-dashboard is a fully static site (GitHub Pages / Actions,
 * no backend). Its browser makes requests directly to Binance / Bybit /
 * CoinGecko / etc. Some of those exchanges geo-block certain visitor IPs
 * (e.g. Binance returns HTTP 451 for sanctioned regions) -- no frontend
 * code can fix that, because the request truly does originate from the
 * blocked IP.
 *
 * This Worker re-issues the request from Cloudflare's edge network
 * instead, and adds the CORS headers the browser needs to read the
 * response. Deploy this to as many free Cloudflare accounts as you like
 * (see the README in this folder) and list all their URLs in the site's
 * VITE_MARKET_PROXY_ENDPOINTS build variable -- the frontend already
 * knows how to rotate across them and fall back to a direct fetch if
 * every proxy is unavailable.
 *
 * URL shape:
 *   https://<your-worker>.workers.dev/proxy/<source>/<upstream path>?<query>
 * e.g.
 *   /proxy/binance/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=180
 *   -> forwarded to https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=180
 */

// Must match the `source` keys used in src/lib/coingecko.js (API_BASES),
// plus tsetmc/tgju, which are called directly by src/lib/tse.js and
// src/lib/irrfx.js through src/lib/corsProxy.js (see that file's header
// comment for why those two don't go through coingecko.js's own proxy path).
const UPSTREAMS = {
  coingecko: "https://api.coingecko.com",
  binance: "https://api.binance.com",
  binanceUsdFutures: "https://fapi.binance.com",
  binanceCoinFutures: "https://dapi.binance.com",
  bybit: "https://api.bybit.com",
  okx: "https://www.okx.com",
  coinbase: "https://api.exchange.coinbase.com",
  tsetmc: "https://cdn.tsetmc.com",
  tgju: "https://platform.tgju.org",
};

// Restrict who can use your proxy quota. Add every origin the site is
// served from (production domain, GitHub Pages domain, localhost while
// developing, etc). Leave "*" only for quick testing.
const ALLOWED_ORIGINS = [
  "https://lensa.fardinmilani.ir",
  "https://fardinmilani.github.io",
  "http://localhost:5173",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    // Expected: /proxy/<source>/<rest...>
    const parts = url.pathname.split("/").filter(Boolean); // ["proxy", "binance", "api", "v3", "klines"]
    if (parts[0] !== "proxy" || !parts[1]) {
      return new Response("Expected /proxy/<source>/<path>", { status: 400, headers });
    }
    const source = parts[1];
    const upstreamBase = UPSTREAMS[source];
    if (!upstreamBase) {
      return new Response(`Unknown source "${source}". Known: ${Object.keys(UPSTREAMS).join(", ")}`, {
        status: 400,
        headers,
      });
    }

    const upstreamPath = "/" + parts.slice(2).join("/");
    const upstreamUrl = upstreamBase + upstreamPath + url.search;

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: { Accept: "application/json" },
        // Short edge cache so a burst of users watching the same coin
        // doesn't multiply your outbound request count (also softens
        // CoinGecko's own 429 rate limit).
        cf: { cacheTtl: 15, cacheEverything: true },
      });
      const body = await upstreamRes.arrayBuffer();
      return new Response(body, {
        status: upstreamRes.status,
        headers: {
          ...headers,
          "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream fetch failed", detail: String(err) }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
