import { useEffect, useMemo, useState } from "react";
import { defaultPairForSymbol, searchCoins } from "../lib/coingecko";
import { useCoin } from "../context/coinStore";
import { useI18n } from "../i18n/langStore";

const TABS = ["all", "crypto", "spot", "composite"];

export default function SymbolSearch({ coin, source, pair, onSelect }) {
  const { selectCoin } = useCoin();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);

  // Debounced search for CoinGecko coins
  useEffect(() => {
    const q = query.trim();
    let cancelled = false;
    const tId = setTimeout(async () => {
      if (!q) {
        if (!cancelled) setSearchResults([]);
        return;
      }
      setLoading(true);
      try {
        const list = await searchCoins(extractBaseSymbol(q));
        if (!cancelled) {
          setSearchResults(list.slice(0, 5));
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 280 : 0);
    return () => {
      cancelled = true;
      clearTimeout(tId);
    };
  }, [query]);

  // Generate rows based on search results or fallback to current coin
  const rows = useMemo(() => {
    const coinsToUse = searchResults.length > 0 ? searchResults : [coin];
    let allRows = [];
    for (const c of coinsToUse) {
      allRows = allRows.concat(makeSymbolRowsForCoin(c));
    }
    return allRows;
  }, [searchResults, coin]);

  // Filter generated rows based on search query terms
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((row) => {
      const tabOk = tab === "all" || row.tags.includes(tab);
      if (!tabOk) return false;
      if (terms.length === 0) return true;

      const symNorm = row.symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
      const nameNorm = row.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const exNorm = row.exchange.toLowerCase().replace(/[^a-z0-9]/g, "");

      return terms.every(
        (term) =>
          symNorm.includes(term) ||
          nameNorm.includes(term) ||
          exNorm.includes(term)
      );
    });
  }, [rows, query, tab]);

  const selectedLabel = source === "coingecko" ? `${coin.symbol}/USD` : pair || defaultPairForSymbol(coin.symbol);
  
  const selectedVenue =
    source === "binance" ? "Binance spot" :
    source === "bybit" ? "Bybit spot" :
    source === "okx" ? "OKX spot" :
    source === "coinbase" ? "Coinbase spot" :
    "CoinGecko";

  function pick(row) {
    if (row.coin && row.coin.id !== coin.id) {
      selectCoin(row.coin);
    }
    onSelect({ source: row.source, pair: row.pair });
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="symbol-search no-print">
      <button type="button" className="symbol-search__trigger" onClick={() => setOpen(true)}>
        {coin.thumb && <img src={coin.thumb} alt="" width="22" height="22" />}
        <span>
          <strong>{selectedLabel}</strong>
          <small>{selectedVenue}</small>
        </span>
      </button>

      {open && (
        <div className="symbol-search__backdrop" onMouseDown={() => setOpen(false)}>
          <div className="symbol-search__dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="symbol-search__tabs">
              {TABS.map((item) => (
                <button type="button" key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
                  {t(`symbol.${item}`)}
                </button>
              ))}
            </div>
            <div style={{ position: "relative" }}>
              <input
                className="symbol-search__input"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("symbol.placeholder")}
              />
              {loading && <span className="coin-search__spinner" style={{ right: "12px", top: "18px" }} />}
            </div>
            <div className="symbol-search__head">
              <span>{t("symbol.symbol")}</span>
              <span>{t("symbol.description")}</span>
              <span>{t("symbol.market")}</span>
              <span>{t("symbol.exchange")}</span>
            </div>
            <div className="symbol-search__rows">
              {filtered.map((row) => (
                <button type="button" className="symbol-search__row" key={row.id} onClick={() => pick(row)}>
                  <span className="symbol-search__asset">
                    {row.coin?.thumb ? (
                      <img src={row.coin.thumb} alt="" width="24" height="24" />
                    ) : (
                      <i>{row.base[0]}</i>
                    )}
                    <b>{row.symbol}</b>
                  </span>
                  <span>{row.name}</span>
                  <span className="symbol-search__tags">
                    {row.tags.filter((tag) => tag !== "crypto").join(" ")}
                  </span>
                  <strong>{row.exchange}</strong>
                </button>
              ))}
              {filtered.length === 0 && !loading && (
                <div style={{ padding: "30px", textShadow: "none", color: "#64748b", textAlign: "center" }}>
                  No matching symbols found
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function extractBaseSymbol(query) {
  const q = query.trim().toUpperCase();
  const quoteSuffixes = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USD", "EUR", "BTC", "ETH"];
  for (const suffix of quoteSuffixes) {
    if (q.length > suffix.length && q.endsWith(suffix)) {
      return q.slice(0, -suffix.length);
    }
  }
  return q;
}

function makeSymbolRowsForCoin(c) {
  const base = String(c.symbol || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!base) return [];
  const name = c.name || c.symbol;

  const binanceRows = [
    {
      id: `binance-${base}-USDT`,
      source: "binance",
      pair: `${base}USDT`,
      base,
      symbol: `${base}USDT`,
      name: `${name} / USDT`,
      exchange: "Binance",
      tags: ["crypto", "spot"],
      coin: c,
    },
    {
      id: `binance-${base}-USDC`,
      source: "binance",
      pair: `${base}USDC`,
      base,
      symbol: `${base}USDC`,
      name: `${name} / USDC`,
      exchange: "Binance",
      tags: ["crypto", "spot"],
      coin: c,
    },
  ];

  const bybitRows = [
    {
      id: `bybit-${base}-USDT`,
      source: "bybit",
      pair: `${base}USDT`,
      base,
      symbol: `${base}USDT`,
      name: `${name} / USDT`,
      exchange: "Bybit",
      tags: ["crypto", "spot"],
      coin: c,
    },
    {
      id: `bybit-${base}-USDC`,
      source: "bybit",
      pair: `${base}USDC`,
      base,
      symbol: `${base}USDC`,
      name: `${name} / USDC`,
      exchange: "Bybit",
      tags: ["crypto", "spot"],
      coin: c,
    },
  ];

  const okxRows = [
    {
      id: `okx-${base}-USDT`,
      source: "okx",
      pair: `${base}-USDT`,
      base,
      symbol: `${base}-USDT`,
      name: `${name} / USDT`,
      exchange: "OKX",
      tags: ["crypto", "spot"],
      coin: c,
    },
    {
      id: `okx-${base}-USDC`,
      source: "okx",
      pair: `${base}-USDC`,
      base,
      symbol: `${base}-USDC`,
      name: `${name} / USDC`,
      exchange: "OKX",
      tags: ["crypto", "spot"],
      coin: c,
    },
  ];

  const coinbaseRows = [
    {
      id: `coinbase-${base}-USD`,
      source: "coinbase",
      pair: `${base}-USD`,
      base,
      symbol: `${base}-USD`,
      name: `${name} / USD`,
      exchange: "Coinbase",
      tags: ["crypto", "spot"],
      coin: c,
    },
    {
      id: `coinbase-${base}-USDC`,
      source: "coinbase",
      pair: `${base}-USDC`,
      base,
      symbol: `${base}-USDC`,
      name: `${name} / USDC`,
      exchange: "Coinbase",
      tags: ["crypto", "spot"],
      coin: c,
    },
  ];

  const coingeckoRow = {
    id: `coingecko-${c.id}`,
    source: "coingecko",
    pair: `${base}USDT`,
    base,
    symbol: `${base}USD`,
    name: `${name} / USD composite`,
    exchange: "CoinGecko",
    tags: ["crypto", "composite"],
    coin: c,
  };

  return [
    ...binanceRows,
    ...bybitRows,
    ...okxRows,
    ...coinbaseRows,
    coingeckoRow,
  ];
}
