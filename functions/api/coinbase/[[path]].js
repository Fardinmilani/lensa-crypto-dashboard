// Same-origin proxy to Coinbase Exchange public REST endpoints for Cloudflare Pages.
const UPSTREAM = "https://api.exchange.coinbase.com";

export async function onRequestGet(context) {
  const { params, request } = context;
  const segments = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  const incoming = new URL(request.url);
  const target = `${UPSTREAM}/${segments}${incoming.search}`;

  try {
    const res = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "LensaCryptoDashboard/1.0"
      },
      cf: { cacheTtl: 10, cacheEverything: true },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=10",
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
