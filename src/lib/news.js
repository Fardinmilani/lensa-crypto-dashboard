// lib/news.js
// Client-side fetcher for our own /api/news Cloudflare Function.
//
// Robustness: in local `vite dev` (and any environment where the Pages Function
// isn't running) the request to /api/news falls through to index.html, so the
// body is "<!doctype ...>" — NOT JSON. The old code blindly called res.json()
// and surfaced the cryptic "Unexpected token '<'" error. We now:
//   1. Verify the response is actually JSON before parsing.
//   2. Transparently fall back to fetching RSS via a public CORS proxy so the
//      news panel still works during local development.

const FALLBACK_FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

// allorigins is a free, no-key CORS proxy. Used only as a dev/edge fallback.
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

function buildUrl(query) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const qs = params.toString();
  return `/api/news${qs ? `?${qs}` : ""}`;
}

async function isJsonResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json");
}

export async function getNews(query = "") {
  try {
    const res = await fetch(buildUrl(query), { headers: { Accept: "application/json" } });
    if (res.ok && (await isJsonResponse(res))) {
      const data = await res.json();
      if (Array.isArray(data.items)) return data;
    }
    // Non-JSON / non-OK → fall through to the client-side proxy path.
    throw new Error("api-unavailable");
  } catch {
    return getNewsViaProxy(query);
  }
}

async function getNewsViaProxy(query = "") {
  const terms = query
    ? query.toLowerCase().split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
    : [];

  const settled = await Promise.allSettled(
    FALLBACK_FEEDS.map(async (feed) => {
      const res = await fetch(`${CORS_PROXY}${encodeURIComponent(feed.url)}`);
      if (!res.ok) throw new Error(`${feed.name}: ${res.status}`);
      const xml = await res.text();
      return parseRss(xml, feed.name);
    })
  );

  let items = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items = items.concat(r.value);
    else errors.push({ source: FALLBACK_FEEDS[i].name, error: String(r.reason) });
  });

  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  const global = items.slice(0, 30);
  let filtered = items;
  if (terms.length) {
    filtered = items.filter((it) => {
      const hay = `${it.title} ${it.summary}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
  }

  return {
    query: query || null,
    items: filtered.slice(0, 40),
    global: terms.length ? global : undefined,
    errors,
    fetchedAt: new Date().toISOString(),
    viaFallback: true,
  };
}

function parseRss(xml, sourceName) {
  const out = [];
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return out;
  }
  const nodes = doc.querySelectorAll("item, entry");
  nodes.forEach((node) => {
    const title = text(node, "title");
    let link = text(node, "link");
    if (!link) {
      const linkEl = node.querySelector("link");
      link = linkEl?.getAttribute("href") || "";
    }
    const pub = text(node, "pubDate") || text(node, "published") || text(node, "updated");
    const desc = text(node, "description") || text(node, "summary") || text(node, "content");
    if (title) {
      out.push({
        source: sourceName,
        title: clean(title),
        link: clean(link),
        publishedAt: pub ? safeIso(pub) : null,
        summary: clean(desc).slice(0, 280),
      });
    }
  });
  return out;
}

function text(node, tag) {
  const el = node.querySelector(tag);
  return el ? el.textContent || "" : "";
}

function clean(raw) {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function safeIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
