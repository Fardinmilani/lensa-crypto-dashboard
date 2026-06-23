// lib/news.js
// Client for our own same-origin /api/news endpoint, which is served by the
// Vite dev middleware locally and by the Cloudflare Pages Function in
// production. Both return clean JSON, so there is no CORS and no HTML-instead-
// of-JSON surprise. We still verify the content-type defensively.

function buildUrl(query) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const qs = params.toString();
  return `/api/news${qs ? `?${qs}` : ""}`;
}

export async function getNews(query = "") {
  const res = await fetch(buildUrl(query), { headers: { Accept: "application/json" } });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error("سرویس اخبار در دسترس نیست (پاسخ نامعتبر).");
  }
  const data = await res.json();
  if (!Array.isArray(data.items)) {
    throw new Error(data.error || "ساختار پاسخ اخبار نامعتبر است.");
  }
  return data;
}
