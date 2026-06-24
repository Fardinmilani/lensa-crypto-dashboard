# Lensa Crypto Dashboard

Lensa is a static Vite + React crypto market analysis app. It is designed for GitHub Pages deployment from the root of a custom domain, for example `https://lensa.example.com`, with DNS managed separately through Cloudflare.

The production app is front-end-only. It does not use backend routes, Cloudflare Workers, Pages Functions, server proxies, private API keys, databases, exchange account connections, order execution, ML training, or always-on server alerts.

## Features

| Area | Supported in static mode | Limitation |
| --- | --- | --- |
| Overview | Watchlist ticker, coin search, public market stats, interactive charting, drawing tools | Public APIs can be CORS blocked or rate limited by the provider |
| Market data | Direct browser fetches to public sources such as CoinGecko, Binance, Bybit, OKX, and Coinbase where available | If a provider fails, Lensa marks it unavailable and falls back when possible |
| Analysis | Long/Short style decision support, adaptive price precision, risk engine, Monte Carlo, lightweight backtesting, Decision Center workflows | Confidence is reduced when data is stale, limited, or served by a fallback |
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

## Reminder

Lensa is for analysis and education only. It is not financial advice, it does not connect to real exchange accounts, and it cannot execute trades.
