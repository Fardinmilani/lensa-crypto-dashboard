# Lensa Crypto Dashboard

Lensa is a static Vite + React crypto market analysis app. It is designed for GitHub Pages deployment from the root of a custom domain, for example `https://lensa.example.com`, with DNS managed separately through Cloudflare.

The production app is front-end-only. It does not use backend routes, Cloudflare Workers, Pages Functions, server proxies, private API keys, databases, exchange account connections, order execution, ML training, or always-on server alerts.

## What Lensa is — and is not

Lensa is a **decision-support and education tool**. It helps you read the market, frame risk, and explore scenarios.

It is **not**:

- a prediction engine — the Forecast tab is *scenario analysis*, not a price target;
- a signal/black-box "buy or sell" service — the Decision Center outputs a *bias* (bullish / bearish / neutral) that always requires your own confirmation;
- a trading terminal — it cannot connect to accounts or place orders;
- a source of guaranteed or always-live data — see *Static Data Policy* below.

### Why static / GitHub Pages?

Going backend-free keeps the project free to host, trivial to deploy, auditable (everything runs in your browser), and private (no server ever sees your watchlist, notes, or alerts). The trade-off is honest data limitations, which the UI surfaces explicitly rather than hiding.

## Features

| Area | Supported in static mode | Limitation |
| --- | --- | --- |
| Overview | Watchlist ticker, coin search, public market stats, interactive charting, drawing tools | Public APIs can be CORS blocked or rate limited by the provider |
| Market data | Direct browser fetches to public sources such as CoinGecko, Binance, Bybit, OKX, and Coinbase where available | If a provider fails, Lensa marks it unavailable and falls back when possible |
| Analysis | Decision-support bias, adaptive price precision, risk engine, Monte Carlo **scenario analysis**, lightweight backtesting, Decision Center workflows | Confidence is reduced when data is stale, limited, or served by a fallback |
| News | Static links to external market news sources and query-specific Google News search | Browser RSS aggregation is disabled because most RSS feeds do not support CORS |
| Local tools | Watchlist, journal/report storage, in-browser alerts while the app is open | No always-on server alerts while the browser tab is closed |

## Static Data Policy

All production data requests originate from the browser and target public third-party APIs directly. The app keeps an in-memory cache and in-flight request de-duplication to reduce repeated calls.

Source health states are surfaced in the UI:

- `Healthy`
- `Limited`
- `Failed`
- `CORS blocked`
- `Rate limited`

When a source fails, the app does not crash. It shows a user-facing warning, marks that source health, attempts another public source where possible, and lowers the confidence shown for related chart analysis.

## Forecast = scenario analysis (not prediction)

The Forecast tab runs a Monte Carlo simulation over this asset's recent log-returns and renders a **scenario cone**:

- the bright line is **history**;
- the dashed gold line is the **median** simulated path;
- the **likely band** (25–75%) and **wide band** (5–95%) show how uncertain the range is;
- a plain-language summary states the typical close, the 5% downside/upside scenarios, and the chance of finishing above the current price.

Numbers are rounded to avoid false precision, the median (not the mean) is the headline so the long upper tail does not exaggerate expectations, and the cone is anchored to the last confirmed candle. The real price can always fall outside any simulated band.

## Local persistence (browser-only)

Watchlist, journal/reports, notes, alerts, and tool preferences live in your browser via `localStorage` (`lensa.*` keys). This means:

- data is per-device and per-browser and is not synced;
- clearing site data removes it;
- in-browser alerts only fire while the tab is open.

These limitations are surfaced in the UI where relevant.

## Testing

```bash
npm run test:models
```

This runs `scripts/validate-models.mjs`, which asserts the core math: strategies, backtest returns, risk sizing, ATR, Monte Carlo percentile ordering / probability bounds / median derivation, and timeframe resolution. No test framework or browser is required.

## Local Development

```bash
npm install
npm run dev
```

There is no local API proxy. Development and production both use the same browser-only data path.

## Build And Preview

```bash
npm run build
npm run preview
```

The Vite config uses `base: "/"`, which is compatible with a custom domain served from the root.

## GitHub Pages Deployment

1. Push the repository to GitHub.
2. Configure GitHub Pages to publish the built `dist` folder, usually through a GitHub Actions workflow that runs `npm ci` and `npm run build`.
3. Add your custom domain in GitHub Pages settings.
4. In Cloudflare DNS, point the hostname to GitHub Pages using the records recommended by GitHub.

No `functions/` directory, Pages Function, Worker, backend route, or production proxy is required.

## Project Structure

```text
src/
  components/    UI components such as charts, ticker, news links, reports
  context/       active coin state
  hooks/         local storage, animations, market polling
  i18n/          bilingual app strings
  lib/           browser-only market client, risk, forecast, reports, backtest
  pages/         dashboard, forecast, backtest, risk, about
```

## Roadmap

- Schema versioning + migration-safe helpers for `localStorage` state.
- Continue extracting the Decision Center and chart layers into smaller feature modules (`src/features/*`).
- Optional IndexedDB-backed candle cache for offline-friendly re-analysis.
- Lightweight component tests for critical UI states (loading / error / degraded data).

## Reminder

Lensa is for analysis and education only. It is not financial advice, it does not connect to real exchange accounts, and it cannot execute trades.
