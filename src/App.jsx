import { Fragment, Suspense, lazy, useState } from "react";
import CoinSearch from "./components/CoinSearch";

// Route-level code splitting: keeps chart-heavy pages out of the initial bundle.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Backtest = lazy(() => import("./pages/Backtest"));
const Forecast = lazy(() => import("./pages/Forecast"));
const RiskTools = lazy(() => import("./pages/RiskTools"));
const DecisionCenter = lazy(() => import("./pages/DecisionCenter"));
const About = lazy(() => import("./pages/About"));
import { CoinProvider } from "./context/CoinContext";
import { MarketProvider } from "./context/MarketContext";
import { useI18n } from "./i18n/langStore";
import "./App.css";

// Core = daily-use tools shown first; advanced = deeper analysis tools.
const TABS = [
  { id: "dashboard", labelKey: "tab.dashboard", component: Dashboard, icon: GridIcon, group: "core" },
  { id: "decision", labelKey: "tab.decision", component: DecisionCenter, icon: ShieldIcon, group: "core" },
  { id: "forecast", labelKey: "tab.forecast", component: Forecast, icon: WaveIcon, group: "advanced" },
  { id: "backtest", labelKey: "tab.backtest", component: Backtest, icon: ChartIcon, group: "advanced" },
  { id: "risk", labelKey: "tab.risk", component: RiskTools, icon: ShieldIcon, group: "advanced" },
  { id: "about", labelKey: "tab.about", component: About, icon: InfoIcon, group: "meta" },
];

export default function App() {
  const { t, toggle } = useI18n();
  const [activeTab, setActiveTab] = useState("dashboard");
  const ActiveComponent = TABS.find((tab) => tab.id === activeTab).component;

  return (
    <CoinProvider>
      <MarketProvider>
        <div className="app-shell">
          <div className="aurora" aria-hidden="true">
            <span className="aurora__blob aurora__blob--gold" />
            <span className="aurora__blob aurora__blob--violet" />
          </div>

        <header className="app-header">
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
                    className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
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
            <ActiveComponent />
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
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
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
