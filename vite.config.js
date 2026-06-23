import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// RSS feeds for the dev-only /api/news middleware (mirrors the Cloudflare Function).
const FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
];

function clean(raw) {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}
function pluck(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}
function extractItems(xml, source) {
  const items = [];
  for (const block of xml.match(/<item[\s\S]*?<\/item>/g) || []) {
    const title = pluck(block, "title");
    const link = pluck(block, "link");
    const pub = pluck(block, "pubDate") || pluck(block, "dc:date");
    if (title && link) {
      const d = pub ? new Date(pub) : null;
      items.push({
        source,
        title: clean(title),
        link: clean(link),
        publishedAt: d && !isNaN(d) ? d.toISOString() : null,
        summary: clean(pluck(block, "description")).slice(0, 280),
      });
    }
  }
  return items;
}

// Dev middleware that replicates the Cloudflare Functions so local === prod.
function devApiPlugin() {
  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use("/api/news", async (req, res) => {
        try {
          const u = new URL(req.url, "http://localhost");
          const q = (u.searchParams.get("q") || "").toLowerCase().trim();
          const terms = q ? q.split(/[,\s]+/).filter((t) => t.length >= 2) : [];
          const settled = await Promise.allSettled(
            FEEDS.map(async (f) => {
              const r = await fetch(f.url, {
                headers: { "User-Agent": "Mozilla/5.0 (LensaCryptoBot/1.0)" },
              });
              if (!r.ok) throw new Error(`${f.name}: ${r.status}`);
              return extractItems(await r.text(), f.name);
            })
          );
          let all = [];
          const errors = [];
          settled.forEach((s, i) => {
            if (s.status === "fulfilled") all = all.concat(s.value);
            else errors.push({ source: FEEDS[i].name, error: String(s.reason) });
          });
          const seen = new Set();
          all = all
            .filter((it) => {
              const k = it.title.toLowerCase().replace(/[^a-z0-9۰-۹ ]/gi, "").trim();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .sort((a, b) => (new Date(b.publishedAt || 0)) - (new Date(a.publishedAt || 0)));
          let filtered = all;
          if (terms.length) {
            filtered = all.filter((it) =>
              terms.some((t) => `${it.title} ${it.summary}`.toLowerCase().includes(t))
            );
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              query: q || null,
              items: filtered.slice(0, 40),
              global: terms.length ? all.slice(0, 30) : undefined,
              errors,
              fetchedAt: new Date().toISOString(),
            })
          );
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err), items: [] }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApiPlugin()],
  server: {
    proxy: {
      // CoinGecko proxied same-origin in dev → no browser CORS, no 429-from-CORS noise.
      "/api/cg": {
        target: "https://api.coingecko.com/api/v3",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/cg/, ""),
      },
    },
  },
});
