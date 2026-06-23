import { useState } from "react";
import { DEFAULT_COINS } from "../lib/coingecko";
import { CoinContext } from "./coinStore";

const INITIAL = {
  id: DEFAULT_COINS[0].id,
  symbol: DEFAULT_COINS[0].symbol,
  name: DEFAULT_COINS[0].name,
  thumb: null,
};

export function CoinProvider({ children }) {
  const [coin, setCoin] = useState(INITIAL);

  function selectCoin(next) {
    setCoin({
      id: next.id,
      symbol: (next.symbol || "").toUpperCase(),
      name: next.name || next.symbol,
      thumb: next.thumb || next.image || null,
    });
  }

  return (
    <CoinContext.Provider value={{ coin, selectCoin }}>
      {children}
    </CoinContext.Provider>
  );
}
