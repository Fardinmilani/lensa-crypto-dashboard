import { createContext, useContext } from "react";
import { translations } from "./translations";

export const LangContext = createContext(null);

export function useI18n() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useI18n must be used inside LanguageProvider");
  return ctx;
}

// Resolve a dotted key for a language, with {var} interpolation and EN fallback.
export function translate(lang, key, vars) {
  // Data-layer errors arrive as "i18nKey::technical detail" so the sentence is
  // localized while the diagnostic detail (source names, HTTP statuses) stays raw.
  if (typeof key === "string" && key.includes("::")) {
    const sep = key.indexOf("::");
    return `${translate(lang, key.slice(0, sep), vars)} ${key.slice(sep + 2)}`.trim();
  }
  const dict = translations[lang] || translations.en;
  let str = dict[key];
  if (str == null) str = translations.en[key];
  if (str == null) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

// For data objects that carry { en, fa } values.
export function pick(lang, bilingual) {
  if (bilingual == null) return "";
  if (typeof bilingual === "string") return bilingual;
  return bilingual[lang] ?? bilingual.en ?? "";
}
