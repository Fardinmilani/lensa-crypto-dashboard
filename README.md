# Lensa

**A free, client-side crypto & forex decision-support dashboard — charting, a real leveraged/short-capable backtesting engine with a visual custom-strategy builder, Monte Carlo scenario forecasting, and a risk toolkit, with nothing but a static site and a browser.**

[**Live app →**](https://lensa.fardinmilani.ir) · [Report a bug](https://github.com/Fardinmilani/lensa-crypto-dashboard/issues) · Built by [Fardin Sheikh Milani](https://fardinmilani.ir)

[![Deploy](https://github.com/Fardinmilani/lensa-crypto-dashboard/actions/workflows/deploy.yml/badge.svg)](https://github.com/Fardinmilani/lensa-crypto-dashboard/actions/workflows/deploy.yml)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![No backend](https://img.shields.io/badge/backend-none-success)

---

Most "trading dashboard" side projects are a price chart and a vibe. Lensa is the other thing: a **fixed-fractional position sizing engine**, a **liquidation-aware leveraged backtester**, a **Monte Carlo engine with two resampling methods**, and a **data-quality confidence layer** that tells you when to trust what you're looking at — all running entirely in your browser, for free, with no server, no signup, and no API keys to manage.

> **What Lensa is not:** a signal service, a prediction engine, or a trading terminal. It cannot place orders, connect to an exchange account, or promise the future. Every number it shows is scenario analysis or backtested history, clearly labeled as such. See [Reminder](#reminder).

## Why this exists

Lensa started as a way to combine two things: a genuine interest in quantitative, simulation-driven decision-making (Monte Carlo methods, backtesting rigor, risk-adjusted sizing), and a constraint that turned out to be a feature — build something completely free to run, for anyone, anywhere, with no backend to pay for or maintain. Every architectural decision below follows from taking that constraint seriously instead of working around it.

## Feature highlights

**Strategy backtesting that behaves like a real engine, not a spreadsheet macro**
- Long, short, and leveraged backtests with genuine liquidation simulation (isolated-margin style), not just a return-percentage multiplier.
- **Fixed-fractional position sizing** — risk a chosen % of the account per trade instead of always going all-in, sized against your configured stop-loss distance (leverage-aware: the math accounts for how leverage amplifies loss-per-unit-of-adverse-move).
- **Configurable fill timing** — the default same-bar-close fill (simple, but implicitly zero-latency) or a more conservative next-bar-open fill, so you can see how much of an edge survives a more realistic execution assumption.
- Stop-loss / take-profit as a risk overlay independent of the strategy's own exit logic, with an auto-fit grid search over stop/target combinations.
- **Walk-forward validation**: fit parameters on an early slice of history, then score both the fitted and the shipped-default parameters on the untouched remainder — the standard, honest check against in-sample overfitting, one click away.
- 11 built-in strategies across trend, momentum, reversion, and hybrid families, each a small, readable, auditable function — no indicator-soup black boxes.

**Build your own strategy — visually, safely**
- The **Strategy Builder** lets you compose entry/exit rules from real indicators (SMA, EMA, RSI, MACD, Bollinger Bands, ROC, Donchian-style highest-high/lowest-low) with comparisons and crossover events, combined with AND/OR.
- Deliberately **not** a code editor: every custom strategy is a plain JSON condition tree, interpreted by a small evaluator — never `eval`'d, never passed to `new Function`. That keeps every custom strategy exactly as auditable as the built-ins, and safe to export/share as inert data with zero code-execution risk.
- Compiles to the exact same shape as a built-in strategy, so it runs through the same backtest engine, the same "run all strategies" comparison, and the same walk-forward validator with zero special-casing.

**Monte Carlo forecasting, not a "price prediction"**
- Historical bootstrap, **block bootstrap** (resamples contiguous chunks of returns to preserve volatility clustering that plain single-point bootstrap destroys), and geometric Brownian motion.
- Deterministic seeded RNG for reproducible scenario cones; percentile bands, touch probabilities, and outcome zones, not a single misleadingly-precise number.

**A data layer that admits when it's uncertain**
- Multi-exchange fallback chain (Binance → Bybit → OKX → CoinGecko) with an optional self-hosted Cloudflare Worker CORS proxy for geo-blocked regions.
- A **confidence-scoring system** (Healthy / Limited / Failed, gap detection, synthetic-candle flagging) that downgrades displayed confidence — rather than silently guessing — whenever the underlying data is incomplete or stale.

**Everything else you'd expect from a serious build, not a demo**
- Full bilingual UI (Persian/English, RTL-aware) — not a handful of translated strings, the entire app.
- Forex pairs alongside crypto, sharing one analysis pipeline via an `effectiveMarketType` layer that keeps forex from polluting crypto-specific persisted state.
- Local-only journal, watchlist, and reports — everything lives in your browser's `localStorage`; nothing is ever sent to a server, because there is no server.

## Architecture philosophy

Three rules this codebase tries to actually follow, not just claim:

1. **Auditable over clever.** Every strategy, every risk calculation, every Monte Carlo method is a small function you can read top to bottom. The Strategy Builder extends this instead of undermining it — custom strategies are data, not code.
2. **Honest about uncertainty.** Forecasts are scenario cones with percentile bands, not point predictions. The Decision Center outputs a bias that always requires your own confirmation, never a "buy/sell" instruction. Data-quality state is surfaced, not hidden.
3. **No backend, no exceptions.** Free to host, trivial to deploy, and private by construction — nothing here can leak because there is no server-side "here" to leak from. The Cloudflare Worker in `cloudflare-proxy/` is an optional, stateless CORS relay for public market data, not application infrastructure.

## Tech stack

React 19 · Vite 8 · [`lightweight-charts`](https://github.com/tradingview/lightweight-charts) · GSAP · zero UI framework dependency — every component, chart overlay, and animation is hand-built. No Redux, no React Query, no CSS framework: `localStorage`-backed hooks and hand-authored CSS throughout.

## Quickstart

```bash
npm install
npm run dev
```

There is no local API proxy — development and production use the same browser-only data path. To use a self-hosted CORS proxy for geo-blocked exchanges, see [`cloudflare-proxy/README.md`](cloudflare-proxy/README.md) and set `VITE_MARKET_PROXY_ENDPOINTS` in a local `.env` (see `.env.example`).

## Testing

```bash
npm run lint          # ESLint
npm run test:models   # Pure-math validation, no browser required
npm run build         # Production build
```

`npm run test:models` runs [`scripts/validate-models.mjs`](scripts/validate-models.mjs), which asserts the core math against hand-computed references: strategy signal generation, backtest returns (spot and leveraged), position sizing, fill timing, liquidation gating, risk-sizing helpers, Monte Carlo (including block bootstrap reproducibility), walk-forward validation, custom-strategy compilation, and timeframe resolution. All three commands above run in CI on every push (see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) and gate the deployment — a regression can't silently ship.

## Deployment

Lensa deploys to GitHub Pages via GitHub Actions on every push to `main`:

1. `npm ci`, `npm run lint`, `npm run test:models`, then `npm run build` — any failure stops the deploy.
2. The built `dist/` is uploaded as a Pages artifact and published via `actions/deploy-pages`.
3. A custom domain (with DNS through Cloudflare) can be configured in the repo's **Settings → Pages**; `vite.config.js` uses `base: "/"`, which assumes the app is served from a domain root rather than a `/repo-name/` subpath.

No `functions/` directory, database, or always-on server is required. The optional Cloudflare Worker in `cloudflare-proxy/` is a stateless CORS relay you can deploy separately if public exchange APIs are geo-blocked in your region — the app works without it, just with fewer fallback data sources.

## Project structure

```text
src/
  components/         UI components — charts, ticker, Strategy Builder, reports
  context/            active coin + market-type state
  hooks/               localStorage-backed state, animations, market polling
  i18n/               bilingual (fa/en) app strings
  lib/
    strategies.js      built-in indicators + strategy definitions
    customStrategies.js  the JSON rule interpreter behind the Strategy Builder
    backtest.js         spot + leveraged backtest engines, position sizing, fill timing
    optimize.js         parameter grid search + walk-forward validation
    forecast.js          Monte Carlo (bootstrap / block bootstrap / GBM)
    risk.js              position sizing, R:R, ATR-based stops
    dataQuality.js        confidence scoring for market data
    coingecko.js          multi-exchange market data client + CORS proxy routing
  pages/               Dashboard, Decision Center, Forecast, Backtest, Risk Tools, About
cloudflare-proxy/       optional, stateless CORS relay for geo-blocked exchanges
scripts/                validate-models.mjs — math correctness, no browser needed
```

## Roadmap

**Shipped:**
- ~~Custom, user-defined strategies in the backtester~~ — see the Strategy Builder above.
- ~~Fixed-fractional position sizing~~, ~~configurable fill timing~~, ~~walk-forward validation~~.
- ~~Block-bootstrap Monte Carlo~~ (preserves volatility clustering plain bootstrap ignores).

**Next up:**
- Schema versioning + migration-safe helpers for `localStorage` state.
- Optional IndexedDB-backed candle cache for offline-friendly re-analysis.
- Multi-asset portfolio backtesting (combined equity curve across a basket of pairs).
- A short methodology write-up covering the quantitative techniques used throughout (Monte Carlo design, walk-forward validation, position sizing) — as much for transparency as documentation.
- Lightweight component tests for critical UI states (loading / error / degraded data).

## Contributing

Issues and pull requests are welcome — this is a personal project built in the open, not a maintained product with SLAs. If you build a strategy in the Strategy Builder worth sharing, exporting the JSON and opening an issue with it is a great way to contribute.

## License

[MIT](LICENSE) © Fardin Sheikh Milani

## Reminder

Lensa is for analysis and education only. It is not financial advice, it does not connect to real exchange accounts, and it cannot execute trades. Nothing it shows — backtested history, a Monte Carlo cone, or a Decision Center bias — is a guarantee about the future.
