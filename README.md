# Phungu Insights

Public analytics portal for the Malawi Stock Exchange (MSE).

- **Live site:** https://mse-portal.wiztechsol-info.workers.dev (Cloudflare Worker)
- **Data:** daily market reports scraped from mse.co.mw PDFs, split-adjusted, dual-written
  to Base44 entities and Neon Postgres. Official MASI/DSI/FSI indices plus a site-computed
  equal-weight index.
- **Features:** dashboard, per-stock pages with model verdicts (Buy/Hold/Sell + valuation),
  Outlook multi-model signals, Portfolio Lab optimizer, and a Learn tab.

## Structure

```
public/           static pages (index, stock, companies, outlook, lab, learn) + css + logo assets
src/worker.js     Cloudflare Worker: routes /api/stock, /api/index, /api/forecast, asset serving
wrangler.toml     deploy config (assets binding ASSETS; secrets via wrangler: NEON_DATABASE_URL)
docs/PROJECT.md   full working reference: architecture, data handling, models, security, gotchas
*.mjs             one-off Neon maintenance scripts (credentials via env vars, never hardcoded)
```

## Deploy

```
wrangler secret put NEON_DATABASE_URL   # once
wrangler deploy
```

See `docs/PROJECT.md` for the complete build and operations manual.

## Agent-side components

```
etl-worker/        scheduled Cloudflare Worker: weekday ETL sweeps of mse.co.mw market
                   reports (09:00 / 13:00 / 15:30 CAT), dual-writing Base44 + Neon
backend-functions/ Base44 backend functions (TypeScript): PDF import, batch imports,
                   chunk driver, model compute (v0.3), Neon sync, announcements, API
```

These run on the Base44 agent platform; secrets (NEON_DATABASE_URL etc.) are injected
via platform env vars — never hardcoded. See `docs/PROJECT.md` for the full data flow.

`agent/` holds the platform-side config: workflow definitions (with the inline
agent prompts) and the archival one-off data-ops scripts. See `agent/README.md`.
