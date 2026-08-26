import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
import CoinSearch from "./components/CoinSearch";

// Route-level code splitting: keeps chart-heavy pages out of the initial bundle.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Backtest = lazy(() => import("./pages/Backtest"));
const Forecast = lazy(() => import("./pages/Forecast"));
const RiskTools = lazy(() => import("./pages/RiskTools"));
const DecisionCenter = lazy(() => import("./pages/DecisionCenter"));
const EdgeLab = lazy(() => import("./pages/EdgeLab"));
const Analytics = lazy(() => import("./pages/Analytics"));
const Guide = lazy(() => import("./pages/Guide"));
const About = lazy(() => import("./pages/About"));
import { CoinProvider } from "./context/CoinContext";
import { MarketProvider } from "./context/MarketContext";
import { useI18n } from "./i18n/langStore";
import ErrorBoundary from "./components/ErrorBoundary";
import "./App.css";

// Core = daily-use tools shown first; advanced = deeper analysis tools.
const TABS = [
  { id: "dashboard", labelKey: "tab.dashboard", component: Dashboard, icon: GridIcon, group: "core" },
  { id: "decision", labelKey: "tab.decision", component: DecisionCenter, icon: ShieldIcon, group: "core" },
  { id: "edge", labelKey: "tab.edge", component: EdgeLab, icon: AtomIcon, group: "advanced" },
  { id: "analytics", labelKey: "tab.analytics", component: Analytics, icon: LayersIcon, group: "advanced" },
  { id: "forecast", labelKey: "tab.forecast", component: Forecast, icon: WaveIcon, group: "advanced" },
  { id: "backtest", labelKey: "tab.backtest", component: Backtest, icon: ChartIcon, group: "advanced" },
  { id: "risk", labelKey: "tab.risk", component: RiskTools, icon: GaugeIcon, group: "advanced" },
  { id: "guide", labelKey: "tab.guide", component: Guide, icon: BookIcon, group: "meta" },
  { id: "about", labelKey: "tab.about", component: About, icon: InfoIcon, group: "meta" },
];
const TAB_IDS = new Set(TABS.map((tab) => tab.id));

function tabFromHash() {
  if (typeof window === "undefined") return null;
  const id = window.location.hash.replace("#", "").split("?")[0];
  return TAB_IDS.has(id) ? id : null;
}

export default function App() {
  const { t, toggle } = useI18n();
  const [activeTab, setActiveTab] = useState(() => tabFromHash() || "dashboard");
  const ActiveComponent = TABS.find((tab) => tab.id === activeTab).component;
  const headerRef = useRef(null);

  // The header's height changes across breakpoints (tabs wrap to a second
  // row on narrow screens) and across languages (fa/en label widths differ),
  // so it can't be a fixed CSS number. Any sticky element meant to sit right
  // below the header (e.g. MarketContextBar) reads this custom property
  // instead of also using `top: 0`, which used to make it stick *behind*
  // the header rather than beneath it.
  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const applyHeaderHeight = () => {
      root.style.setProperty("--header-h", `${header.offsetHeight}px`);
    };
    applyHeaderHeight();
    const observer = new ResizeObserver(applyHeaderHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Keep the URL hash and the active tab in sync both ways: switching tabs
  // updates the hash (so the tab is bookmarkable/shareable), and using the
  // browser's back/forward buttons (or opening a shared link) updates the
  // active tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash.replace("#", "") !== activeTab) {
      window.history.replaceState(null, "", `#${activeTab}`);
    }
  }, [activeTab]);

  useEffect(() => {
    function onHashChange() {
      const id = tabFromHash();
      if (id) setActiveTab(id);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const num = Number(e.key);
      if (num >= 1 && num <= TABS.length) {
        selectTab(TABS[num - 1].id);
        return;
      }
      if ((e.key === "r" || e.key === "R") && activeTab === "backtest") {
        window.dispatchEvent(new CustomEvent("lensa:run-backtest"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab]);

  function selectTab(id) {
    setActiveTab(id);
    if (typeof window !== "undefined") window.history.pushState(null, "", `#${id}`);
  }

  return (
    <CoinProvider>
      <MarketProvider>
        <div className="app-shell">
          <div className="aurora" aria-hidden="true">
            <span className="aurora__blob aurora__blob--gold" />
            <span className="aurora__blob aurora__blob--violet" />
          </div>

        <header className="app-header" ref={headerRef}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M3 17l5-6 4 4 6-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="brand-text">
              <span className="brand-name">Lensa</span>
              <span className="brand-sub">{t("brand.sub")}</span>
            </div>
          </div>

          <CoinSearch />

          <nav className="tab-nav" role="tablist" aria-label={t("brand.sub")}>
            {TABS.map((tab, i) => {
              const Icon = tab.icon;
              const prev = TABS[i - 1];
              const showDivider = prev && prev.group !== tab.group;
              return (
                <Fragment key={tab.id}>
                  {showDivider && <span className="tab-divider" aria-hidden="true" />}
                  <button
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    aria-label={t(tab.labelKey)}
                    className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                    onClick={() => selectTab(tab.id)}
                  >
                    <Icon />
                    <span>{t(tab.labelKey)}</span>
                  </button>
                </Fragment>
              );
            })}
          </nav>

          <button className="lang-toggle" onClick={toggle} title="Language / زبان">
            <GlobeIcon />
            <span>{t("lang.toggle")}</span>
          </button>
        </header>

        <main className="app-main" key={activeTab}>
          <Suspense fallback={<div className="route-loading">{t("common.loading")}</div>}>
            <ErrorBoundary>
              <ActiveComponent />
            </ErrorBoundary>
          </Suspense>
        </main>

        <footer className="app-footer">{t("footer")}</footer>
        </div>
      </MarketProvider>
    </CoinProvider>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3M20 16V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GaugeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 15a8 8 0 1 1 16 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 15l4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="15" r="1.3" fill="currentColor" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function AtomIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(120 12 12)" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v18H6.5A2.5 2.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v18h5.5A2.5 2.5 0 0 0 20 18.5z" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1.1" fill="currentColor" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 3l9 5-9 5-9-5 9-5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M3 12l9 5 9-5M3 17l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
