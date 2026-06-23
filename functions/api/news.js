// functions/api/news.js
// Cloudflare Pages Function — runs server-side at the edge, NOT in the browser.
// RSS feeds block CORS, so we fetch + parse them here and hand the client clean JSON.
//
// Deployed automatically by Cloudflare Pages when this file lives in /functions/api/.
// Supports optional ?q=keyword,keyword filtering so the dashboard can show
// headlines relevant to whatever coin the user is currently looking at.

const FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
  { name: "CryptoPotato", url: "https://cryptopotato.com/feed/" },
  { name: "NewsBTC", url: "https://www.newsbtc.com/feed/" },
];

function extractItems(xml, sourceName) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];

  for (const block of itemBlocks) {
    const title = pluck(block, "title");
    const link = pluck(block, "link");
    const pubDate = pluck(block, "pubDate") || pluck(block, "dc:date");
    const description = pluck(block, "description");

    if (title && link) {
      items.push({
        source: sourceName,
        title: cleanText(title),
        link: cleanText(link),
        publishedAt: pubDate ? safeIso(pubDate) : null,
        summary: cleanText(description).slice(0, 280),
      });
    }
  }
  return items;
}

function pluck(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function cleanText(raw) {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

function safeIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9۰-۹ ]/gi, "").trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

async function fetchFeed(feed) {
  // Cloudflare Workers fetch has no default timeout; add one so a single slow
  // feed can't stall the whole response.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(feed.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LensaCryptoBot/1.0; +https://lensa.pages.dev)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      cf: { cacheTtl: 180, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
    const xml = await res.text();
    return extractItems(xml, feed.name);
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    const terms = q
      ? q.split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
      : [];

    const results = await Promise.allSettled(FEEDS.map(fetchFeed));

    let allItems = [];
    const errors = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        allItems = allItems.concat(results[i].value);
      } else {
        errors.push({ source: FEEDS[i].name, error: String(results[i].reason) });
      }
    }

    allItems = dedupe(allItems).sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });

    // Coin-specific filtering: keep a "relevant" set when terms are supplied,
    // but always return the global feed too so the UI can gracefully fall back.
    let filtered = allItems;
    if (terms.length) {
      filtered = allItems.filter((item) => {
        const haystack = `${item.title} ${item.summary}`.toLowerCase();
        return terms.some((t) => haystack.includes(t));
      });
    }

    const payload = {
      query: q || null,
      items: filtered.slice(0, 40),
      global: terms.length ? allItems.slice(0, 30) : undefined,
      errors,
      fetchedAt: new Date().toISOString(),
    };

    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=180",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), items: [] }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
