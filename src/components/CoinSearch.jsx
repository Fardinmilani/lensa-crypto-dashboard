import { useEffect, useRef, useState } from "react";
import { searchCoins, DEFAULT_COINS } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";

export default function CoinSearch() {
  const { coin, selectCoin } = useCoin();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);

  useEffect(() => {
    function onClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!q) {
        if (!cancelled) setResults([]);
        return;
      }
      setLoading(true);
      try {
        const list = await searchCoins(q);
        if (!cancelled) {
          setResults(list.slice(0, 8));
          setActive(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 280 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  function choose(c) {
    selectCoin(c);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="coin-search" ref={boxRef}>
      <div className="coin-search__field">
        <svg className="coin-search__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={query}
          placeholder={`جستجوی هر رمزارز…  (فعلی: ${coin.symbol})`}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="جستجوی رمزارز"
        />
        {loading && <span className="coin-search__spinner" aria-hidden="true" />}
      </div>

      {open && (query.trim() ? results.length > 0 : true) && (
        <ul className="coin-search__dropdown" role="listbox">
          {!query.trim() && (
            <li className="coin-search__hint">رمزارزهای پرطرفدار</li>
          )}
          {(query.trim() ? results : DEFAULT_COINS).map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={`coin-search__option ${i === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
            >
              {c.thumb ? (
                <img src={c.thumb} alt="" width="20" height="20" />
              ) : (
                <span className="coin-search__dot" aria-hidden="true" />
              )}
              <span className="coin-search__name">{c.name}</span>
              <span className="coin-search__sym">{(c.symbol || "").toUpperCase()}</span>
              {c.rank && <span className="coin-search__rank">#{c.rank}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
