import { useState } from "react";
import Dashboard from "./pages/Dashboard";
import Backtest from "./pages/Backtest";
import Forecast from "./pages/Forecast";
import RiskTools from "./pages/RiskTools";
import CoinSearch from "./components/CoinSearch";
import { CoinProvider } from "./context/CoinContext";
import "./App.css";

const TABS = [
  { id: "dashboard", label: "نمای کلی", component: Dashboard, icon: GridIcon },
  { id: "forecast", label: "پیش‌بینی احتمالی", component: Forecast, icon: WaveIcon, badge: "Premium" },
  { id: "backtest", label: "بک‌تست", component: Backtest, icon: ChartIcon },
  { id: "risk", label: "مدیریت ریسک", component: RiskTools, icon: ShieldIcon },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const ActiveComponent = TABS.find((t) => t.id === activeTab).component;

  return (
    <CoinProvider>
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
              <span className="brand-sub">سامانه تصمیم‌یاری کریپتو</span>
            </div>
          </div>

          <CoinSearch />

          <nav className="tab-nav" role="tablist" aria-label="بخش‌های اصلی">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon />
                  <span>{tab.label}</span>
                  {tab.badge && <em className="tab-badge">{tab.badge}</em>}
                </button>
              );
            })}
          </nav>
        </header>

        <main className="app-main" key={activeTab}>
          <ActiveComponent />
        </main>

        <footer className="app-footer">
          این ابزار صرفاً برای تحلیل و آموزش است و توصیه‌ی مالی محسوب نمی‌شود. تمام تصمیمات معاملاتی و
          مسئولیت سود/ضرر بر عهده‌ی شماست.
        </footer>
      </div>
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
