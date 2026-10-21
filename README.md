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
