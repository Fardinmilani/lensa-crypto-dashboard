// Static-hosting news fallback.
// RSS feeds usually do not expose browser-friendly CORS headers, and GitHub
// Pages cannot run a feed parser. Keep the module useful with direct external
// links instead of depending on an application-owned news endpoint.

const NEWS_SOURCES = [
  {
    source: "CoinDesk",
    title: "Open CoinDesk market coverage",
    link: "https://www.coindesk.com/markets/",
  },
  {
    source: "Cointelegraph",
    title: "Open Cointelegraph markets coverage",
    link: "https://cointelegraph.com/tags/markets",
  },
  {
    source: "Decrypt",
    title: "Open Decrypt markets coverage",
    link: "https://decrypt.co/news/markets",
  },
  {
    source: "Bitcoin Magazine",
    title: "Open Bitcoin Magazine news",
    link: "https://bitcoinmagazine.com/",
  },
  {
    source: "CryptoSlate",
    title: "Open CryptoSlate market news",
    link: "https://cryptoslate.com/news/",
  },
];

export async function getNews(query = "") {
  const q = query.trim();
  const searchLinks = q
    ? [
        {
          source: "Google News",
          title: `Search news for ${q}`,
          link: `https://news.google.com/search?q=${encodeURIComponent(q)}`,
        },
      ]
    : [];

  return {
    query: q || null,
    items: [...searchLinks, ...NEWS_SOURCES],
    global: NEWS_SOURCES,
    fetchedAt: new Date().toISOString(),
    disabled: true,
    warning:
      "Live RSS aggregation is disabled in static mode because browser RSS fetches are commonly blocked by CORS. Open the external sources for current headlines.",
  };
}
