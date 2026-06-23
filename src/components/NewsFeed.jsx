import { useEffect, useState } from "react";
import { getNews } from "../lib/news";

function timeAgo(isoDate) {
  if (!isoDate) return "";
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "همین حالا";
  if (mins < 60) return `${mins} دقیقه پیش`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ساعت پیش`;
  return `${Math.floor(hours / 24)} روز پیش`;
}

export default function NewsFeed({ query = "", coinSymbol = "" }) {
  const [news, setNews] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getNews(query);
        if (!cancelled) {
          setNews(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, reloadKey]);

  const relevant = news?.items || [];
  const global = news?.global || [];
  const showGlobalFallback = query && relevant.length === 0 && global.length > 0;
  const list = showGlobalFallback ? global : relevant;

  return (
    <div className="news-feed glass-card">
      <div className="panel-header">
        <div>
          <h2>اخبار بازار{coinSymbol ? ` · ${coinSymbol}` : ""}</h2>
          <span className="panel-subtitle">خلاصه‌ای از منابع متعدد — بدون سیگنال خرید/فروش</span>
        </div>
        <button className="icon-btn" onClick={load} title="به‌روزرسانی" aria-label="به‌روزرسانی اخبار">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {loading && <p className="news-loading">در حال بارگذاری اخبار…</p>}
      {error && !loading && <p className="news-error">خطا در دریافت اخبار: {error}</p>}

      {showGlobalFallback && (
        <p className="news-note">خبر اختصاصی برای {coinSymbol} یافت نشد — جدیدترین اخبار کل بازار:</p>
      )}

      {!loading && !error && (
        <ul className="news-list">
          {list.map((item, i) => (
            <li className="news-item reveal" key={i}>
              <a href={item.link} target="_blank" rel="noopener noreferrer">
                <span className="news-title">{item.title}</span>
              </a>
              <div className="news-meta">
                <span className="news-source">{item.source}</span>
                {item.publishedAt && <span className="news-time num">{timeAgo(item.publishedAt)}</span>}
              </div>
            </li>
          ))}
          {list.length === 0 && <li className="news-loading">خبری برای نمایش نیست.</li>}
        </ul>
      )}
    </div>
  );
}
