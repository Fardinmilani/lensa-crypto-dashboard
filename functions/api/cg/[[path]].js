// functions/api/cg/[[path]].js
// Same-origin proxy to the CoinGecko public API. Running server-side at the
// edge means the browser never talks to CoinGecko directly, which:
//   - eliminates browser CORS errors entirely, and
//   - lets us edge-cache responses to dramatically cut 429 (rate-limit) hits.
//
// Optional: set a CG_DEMO_KEY environment variable in the Pages project to
// raise the rate limit with a free CoinGecko demo key.

const UPSTREAM = "https://api.coingecko.com/api/v3";

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const segments = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  const incoming = new URL(request.url);
  const target = `${UPSTREAM}/${segments}${incoming.search}`;

  const headers = { Accept: "application/json" };
  if (env && env.CG_DEMO_KEY) headers["x-cg-demo-api-key"] = env.CG_DEMO_KEY;

  try {
    const res = await fetch(target, {
      headers,
      cf: { cacheTtl: 45, cacheEverything: true },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=45",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
