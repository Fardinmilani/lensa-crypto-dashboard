// Small, dependency-free fetch helper for third-party JSON APIs that don't
// (or might not) set permissive CORS headers.
//
// TSE / IRR-FX only need CORS, not a private IP. This helper tries two free
// public CORS-proxy services, then a direct fetch as the last attempt.
//
// IMPORTANT HONESTY NOTE: allorigins.win and codetabs.com are free, keyless,
// third-party services with real limits (roughly 20 req/min and 5 req/sec)
// and no uptime guarantee. Traffic to tsetmc/tgju is visible to them. That
// is a reasonable trade for public daily stock/FX quotes on a personal
// dashboard; it would NOT be a reasonable trade for anything private.

const PUBLIC_PROXY_BUILDERS = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

/**
 * Fetch JSON from `directUrl` through public CORS proxies, then a final
 * direct request. `source` is only used in error messages.
 */
export async function fetchJsonViaProxy(source, directUrl, { timeoutMs = 10_000 } = {}) {
  const publicCandidates = PUBLIC_PROXY_BUILDERS.map((build) => build(directUrl));
  const candidates = [...publicCandidates, directUrl];

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
