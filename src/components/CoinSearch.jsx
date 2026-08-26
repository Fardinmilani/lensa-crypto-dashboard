import { useEffect, useRef, useState } from "react";
import { searchCoins, DEFAULT_COINS } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";
import { useI18n } from "../i18n/langStore";

export default function CoinSearch() {
  const { coin, selectCoin } = useCoin();
  const { t } = useI18n();
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

  // The visible option list: search results when there's a query, the
  // "popular" defaults otherwise. Keyboard handling MUST use the same list
  // the dropdown renders — keying off `results` alone left arrow/Enter dead
  // on the default (empty-query) dropdown.
  const options = query.trim() ? results : DEFAULT_COINS;

  function onKeyDown(e) {
    if (!open || !options.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="coin-search" ref={boxRef}>
      <div className="coin-search__field" title={t("search.tooltip")}>
        <svg className="coin-search__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={query}
          placeholder={t("search.placeholder", { sym: coin.symbol })}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls="coin-search-listbox"
          aria-activedescendant={open && options[active] ? `coin-option-${options[active].id}` : undefined}
          aria-autocomplete="list"
          aria-label={t("search.placeholder", { sym: coin.symbol })}
          title={t("search.tooltip")}
        />
        {loading && <span className="coin-search__spinner" aria-hidden="true" />}
      </div>

      {open && options.length > 0 && (
        <ul className="coin-search__dropdown" role="listbox" id="coin-search-listbox">
          {!query.trim() && (
            <li className="coin-search__hint" role="presentation">{t("search.popular")}</li>
          )}
          {options.map((c, i) => (
            <li
              key={c.id}
              id={`coin-option-${c.id}`}
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
