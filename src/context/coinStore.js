import { createContext, useContext } from "react";

export const CoinContext = createContext(null);

export function useCoin() {
  const ctx = useContext(CoinContext);
  if (!ctx) throw new Error("useCoin must be used inside CoinProvider");
  return ctx;
}
