# Phungu Insights (MSE Portal) — Project Working Copy

> Complete reference for the Malawi Stock Exchange analytics portal: architecture, data
> handling, storage, workflows, security, and operating roles. Written as a working copy
> so a similar project can be developed seamlessly from this document.

**Live site:** https://mse-portal.wiztechsol-info.workers.dev (Cloudflare Worker)
**Brand:** Phungu Insights (formerly MSE Portal). Wordmark: "Phungu<span>Insights</span>".
**Region context:** Malawi (Africa/Blantyre timezone). Prices in Malawi Kwacha (MK).
Market: ~17 listed companies on the MSE.

---

## 1. What the project is

A public stock-market analytics portal for the Malawi Stock Exchange that:

1. Collects daily market data (prices + fundamentals) automatically from the exchange's
   official daily reports (PDFs published on mse.co.mw).
2. Stores a clean, split-adjusted historical archive (2020 → present, backfill ongoing).
3. Serves a public website with a dashboard, per-stock pages, model verdicts, a portfolio
   optimizer, and educational content.
4. Runs quantitative models (technical + value + AI sentiment) weekly and reports to Telegram.
5. Is expanding into a member layer: accounts, portfolio tracking, watchlists, an "MSE AI"
   site chatbot.

The key insight that makes the project valuable: the exchange publishes data only as PDF
market reports, so the entire pipeline is built around PDF harvesting, parsing, and
validation. Everything downstream (indices, models, the Lab) is computed from that archive.

---

## 2. Website (frontend)

**Hosting:** Cloudflare Workers (deployed via wrangler with a Cloudflare account token).
Static HTML pages + JS, served by the Worker with API routes.

### Pages

| Page | Purpose |
|---|---|
| `/` (dashboard) | Price table (▲▼ change indicators, tabular-nums), equal-weight index chart with toggle (Equal-Weight / MASI / Domestic / Foreign), official MASI stat card with day + YTD change, announcements feed. |
| Stock pages (per symbol) | History, fundamentals, After-Tax Profit (MKmn), split badges + As-traded toggle (e.g. PCL 1:35), Model View card (verdict + drivers). |
| `/outlook.html` | Multi-model signals: live technical + value scores, weekly composite, AI sentiment; Buy/Hold/Sell + valuation verdict chips. |
| `/lab.html` (Portfolio Lab) | Portfolio construction + optimization (see §6.3). |
| `/learn.html` | Educational tab: P/E, dividend yield, P/BV, z-scores, momentum, sentiment tiebreaker, how to read verdicts, why-no-DCF, limits + disclaimer. Jump-anchor nav (11 sections) and "How to Pick a Company to Buy" (8-step method). |

### API routes (Worker)

- `/api/stock` — per-symbol series (includes raw close `rc` for as-traded views)
- `/api/index` — official MASI/DSI/FSI series (from Neon) + equal-weight index
- Model/forecast endpoint (`/api/forecast`) — mirrors the agent-side model scoring
- Backend functions also exist on the Base44 side (see §5)

### UI/UX standards applied (Oct 5 overhaul, version a75a6368..37c8fde0)

- Logo lockup by breakpoint (desktop lockup / stacked ≤640px), vector favicon set
- Icon-only mobile nav with 44px touch targets, skip link, focus rings
- Chart aria-labels, reduced-motion support, contrast bump
- Sticky first column in tables, tabular-nums + ▲▼ on percent cells
- CSS versioned (`?v=20261005b`, later `?v=20261005d`) to bust caches
- Verified with local headless Chromium at 375px + 1280px (computed-style probes)
- Logo assets pending owner approval (eagle mark + Phungu Insights wordmark, dark theme;
  first draft sent Oct 5, iterate on request before applying anywhere)

**CSS gotcha recorded:** `.logo img` (specificity 0,1,1) beats `.logo-mob` (0,1,0) —
use `.logo img.logo-mob` when overriding.

---

## 3. Architecture overview

```
  mse.co.mw (daily PDF market reports, announcements, index data)
        |
        |  Agent-side ETL (sandbox: fetch + parse + validate)
        v
  Base44 entities (MseStockPrice, MseIndexDaily, ...)  <-- dual-write -->  Neon Postgres
        |                                                                (mse_stock_prices,
        |                                                                 mse_index_daily)
        |  Chunked import queue for bulk backfills
        v
  Cloudflare Worker (mse-portal.wiztechsol-info.workers.dev)
        - serves static pages
        - /api/stock, /api/index, /api/forecast (reads Neon)
        - Model View + verdicts computed agent-side and synced
        |
        v
  Weekly model run -> MseSentiment / MseModelSignal -> Telegram report
```

Two storage tiers exist deliberately:

- **Base44 entities** — the agent-native store, used by workflows and backend functions.
- **Neon Postgres** — the production store the Worker reads. Every ETL write is dual-written
  to both, so the website stays independent of the agent platform.

---

## 4. Storage

### 4.1 Base44 entities (data tables)

Every record auto-includes `id`, `created_date`, `updated_date`, `created_by`.

| Entity | Fields | Purpose |
|---|---|---|
| `MseStockPrice` | symbol, trade_date, open_price, close_price, previous_close, raw_close, change_percent, volume, turnover, interest, market_capitalization, pe_ratio, dividend_yield_percent, pbv, market_type, data_source | Core daily OHLC + fundamentals per stock |
| `MseIndexDaily` | trade_date, masi, domestic_index, foreign_index | Official MASI/DSI/FSI index series |
| `MseModelSignal` | run_date, symbol, signal, tech_score, value_score, pe_ratio, dividend_yield, pbv, volatility, vs_ma20, return_1m, return_3m, ytd_return, max_drawdown | Weekly model output |
| `MseSentiment` | run_date, symbol, score, note | AI sentiment persisted from Saturday runs |
| `MseAnnouncement` | company, title, announced_date, type, source_site, source_url, raw_text, dedup_key, alert_sent | Monday announcement sweep (dedup_key prevents repeats) |
| `MseImportChunk` | chunk_id, group, seq, status, payload | Bulk-backfill queue (see §7.2) |
| `MseEtlLog` | run_date, trigger, status, records_processed, duration_seconds, error_message | ETL observability |
| `MseApiKey` | api_key, app_name, contact_email, is_active, requests_count, last_used | API key registry for API consumers |

### 4.2 Neon Postgres (production DB for the Worker)

- Tables: `mse_stock_prices` (includes `pbv` and `raw_close` columns), `mse_index_daily`
- Written by the agent ETL/backend functions in the same pass as Base44 (dual-write)
- Read directly by the Worker's `/api/stock` and `/api/index` routes

### 4.3 Planned: Cloudflare D1

The v2 member layer (auth, portfolio tracker, watchlist) will store user data in Cloudflare
D1. Needs a D1-enabled Cloudflare token to deploy.

### 4.4 Row-level security

Base44 supports RLS per entity. Current portal data is public market data (no per-user rows
yet); RLS becomes relevant with the v2 member layer.

---

## 5. Backend functions (Base44 side)

Reusable deployed functions — the "API layer" the agent and workflows drive:

| Function | Role |
|---|---|
| `importMseBatch` | Accepts a batch JSON ({days, records}), **upserts** to MseStockPrice (idempotent, re-running safe, no duplicates) |
| `runMseChunkImport` | Pulls N pending chunks from MseImportChunk, calls importMseBatch — the workhorse of every backfill |
| `loadImportChunks` | Bulk-creates MseImportChunk records from a payload |
| `importMseIndexBatch` | Imports official index (MASI/DSI/FSI) days |
| `setMsePbv` | Writes pbv onto existing MseStockPrice records |
| `computeMseModel` | Model scoring (v0.3), mirrors the Worker `/api/forecast` logic |

**Security pattern for workflow-called functions:** a function that only workflows call
must start with `const user = await base44.auth.me()`, return 401 when there is no user and
403 unless `user.role === 'admin'`, then use `base44.asServiceRole`. Functions are
admin-driven; no shared secrets in code.

**Known limitation:** Base44 backend functions could NOT reach mse.co.mw (egress blocked),
but the sandbox `curl` CAN. Therefore all scraping/parsing happens agent-side in the sandbox;
backend functions only handle DB writes.

---

## 6. Data handling

### 6.1 Daily ETL (live pipeline)

- **Schedule (weekdays):** 09:00, 13:00, 15:30 Africa/Blantyre — market reports are
  published progressively through the day, hence three sweeps.
- **Steps:** fetch the day's market report PDF from mse.co.mw → parse prices + fundamentals
  (P/E, dividend yield, market cap, ATP) → validate → dual-write Base44 + Neon → log to
  MseEtlLog.
- **Announcement sweep:** Mondays 08:00 — scrape company announcements into MseAnnouncement
  with dedup_key; alert once per item (alert_sent flag).
- **P/BV gap:** the daily PDF format includes P/E, DY, mktcap, ATP but no P/BV. P/BV is
  top-up populated from periodic PDF digests via `setMsePbv` (170 rows done from the last
  10 dailies, Sep 21–Oct 2). Include P/BV refreshes in future top-ups.

### 6.2 Data quality rules (learned the hard way)

- **Idempotent upserts everywhere.** Re-running any import is safe; no duplicates.
- **Validation:** market cap vs after-tax profit cross-check (e.g. NBM ATP 202,867 MKmn vs
  mktcap 4,260,281 = exact 21.0 P/E proves both fields); boundary check between years
  (2023→2024: prev-close vs DB 2024-01-02 closes matched EXACT for all 16 symbols).
- **Previous-close integrity:** each day's previous_close must equal the prior day's close.
  Source-file typos were repaired (NBM Sep 24/29) or proven by the file's own next-day
  prev cell (ILLOVO Jan 9 phantom spike 1375.08 → 1355.08).
- **Suspended zero-price days are skipped** (BHL Jan 2, PCL Jan 23, ICON Feb 20, 2025).
- **Split adjustments (retroactive, full history):**
  - PCL 1:35 split (÷35 adjusted; 169 pre-split rows backfilled raw_close in Base44 + Neon;
    split-day change +1.10% vs the 272 reference; PCL page shows split badge + As-traded toggle)
  - STANDARD ÷5 pre-Jul-21 adjustment
  - `raw_close` always preserved so As-traded views are possible
- **Symbol normalization:** FMBC → FMBCH throughout.
- **Duplicate hygiene:** 744 stale duplicate rows found and removed (2026 enrichment).
  Root cause: SDK `list()` silently truncates around ~10k records — always paginate.
- **Missing days are expected and documented:** e.g. Mar 3 2025 (no report exists), Feb 26
  2025 (partial, 6 stocks), suspension days (14 stocks). For archive years, the exchange
  posts no reports for some trading days (~25 in 2023); chain mismatches bridging those gaps
  are legitimate, not import errors.

### 6.3 Portfolio Lab (computation, not just storage)

Live at /lab.html; designed to plug into members' actual holdings in v2.

- **Ticker chips:** include/exclude any company (min 2) + Select all / Top-N-by-market-cap presets
- **Estimation window selector:** 6M/1Y/2Y/All (default 1Y). Every return/vol/covariance
  estimate, the label, and the eligible universe recompute per window (e.g. CHL drops out
  of 2Y/All — noted honestly in UI)
- **Models:** Equal Weight, Min Variance (greedy: start least-vol, add whichever most
  reduces portfolio variance), Risk Parity (N least volatile), Momentum (top-N by z-score),
  Value (top-N by z-score), plus model-driven picker: portfolio size N input + "models
  auto-pick best" toggle. Clicking a model selects its best N, loads weights, redraws frontier.
- Verified: min-var N=5 → BHL/ICON/ILLOVO/MPICO/PCL; momentum N=3 → PCL/BHL/MPICO

### 6.4 Indices

- **Equal-weight index:** computed by the site from stored prices (this is the site's own
  transparent metric; +365% since Jan 2024)
- **Official indices (MASI/DSI/FSI):** harvested from 425 exchange PDFs into 661 trading
  days (Jan 2024 → Oct 2026), stored in MseIndexDaily + Neon `mse_index_daily`
- **Open gap:** the official index series is a static import; the daily ETL does not yet
  ingest index values, so the official chart stopped updating after Oct 2 while equal-weight
  keeps moving. Fix options: an agent-step workflow pulling each day's official PDF and
  calling `importMseIndexBatch`, or extend the ETL if a live index source is found.

---

## 7. Workflows & how tasks are executed

### 7.1 Standing scheduled workflows

| Workflow | Schedule | What it does |
|---|---|---|
| MSE Daily ETL | Weekdays 09:00 / 13:00 / 15:30 | Agent-step ETL: fetch, parse, validate, dual-write (stock prices only — indices not yet included) |
| MSE Model Report | Saturdays 09:00 | Runs the model, persists MseSentiment + MseModelSignal, syncs signals to Neon, sends Telegram report |
| MSE Announcement Sweep | Mondays 08:00 | Scrape announcements, dedup, alert |
| MSE Final Scrape | Scheduled | End-of-day capture |

(These four are defined but currently INACTIVE in this agent copy — reactivate on takeover.)
The Saturday model run began persisting AI sentiment Sat Sep 12, 2026.

### 7.2 The durable bulk-import pattern (THE key reusable design)

**Problem:** the sandbox suspends between conversation turns — any background loop
(bash nohup, tmux) dies when the conversation ends. Large imports (years of data, thousands
of records) cannot be done in one turn anyway (rate limits, timeouts).

**Solution — chunk queue + server-side workflow chain:**

1. **Pre-process agent-side:** download the PDF archive, parse and validate ALL records
   into in-memory JSON (validation happens before any DB write).
2. **Queue:** split records into small chunks and load them into `MseImportChunk`
   (via `loadImportChunks`). Each chunk: chunk_id, group (e.g. "2023"), seq, payload,
   status pending/done/failed.
3. **Drive with a workflow:** a server-side workflow (survives conversation end) chains
   steps, each calling `runMseChunkImport` with take=N, with pace waits between steps
   (45s) to respect rate limits. Ends with a verify+report agent step that messages the
   owner and — in the year-chain design — sets up the next year's workflow.
4. **Idempotency:** chunks import via upsert; failed/re-run chunks never duplicate data.

**Chunk sizing gotcha:** MseImportChunk payload field limit is ~10KB. 4-trading-day chunks
were rejected; **2-day chunks (~10.8KB) pass**. Pace chunk loads (rate limit).

Scale achieved: 2025 backfill = 250 trading days, 3,891 records; 2023 = 224 reports,
3,584 records in 112 two-day chunks. Year chain: each year's verify step sets up the next
(2023 → 2022 → 2021 → 2020, then stop; owner wants down to 2020, not 2019).

### 7.3 How agent tasks run in general

- **Scheduled/triggered work:** Base44 workflows with agent steps (invoke_superagent_step)
  wake the agent with a message; the agent does the work with its tools (bash/skills for
  scraping and parsing, backend functions for DB writes, entity CRUD for light reads).
- **Interactive work:** direct tool use in conversation.
- **Reporting:** workflow notifications and per-year backfill completion/errors go to the
  owner; owner preference: for long-running backfills, message only per-year completion or
  errors, not per-chunk noise.
- **Verification discipline:** every deploy or import is browser-verified or
  boundary-checked before being reported done (local headless Chromium; computed-style
  probes for UI; prev-close boundary checks for data).

---

## 8. Model layer (v0.3)

**Scores:**
- Technical composite: momentum (1M/3M/YTD returns, vs_ma20), volatility, max drawdown
- **Value = 0.4·z(−PE) + 0.3·z(DY) + 0.3·z(−PBV)**, renormalized when PBV missing

**Verdicts (rendered as chips on Outlook cards + Model View card on stock pages):**
- Stance: Buy / Hold / Sell from tech composite (≥ +0.5 / ≤ −0.5; sentiment nudges the
  0.25–0.5 band)
- Valuation: Undervalued / Overvalued at |value| ≥ 0.5, else Fairly valued
- Up to 3 driver reasons per verdict

**Where it lives:** both agent-side (`computeMseModel`) and Worker-side (`/api/forecast`)
run the same logic.

**Roadmap (agreed 2026-09-07):** signal calibration + hit-rate tracking (needs 4–6 weeks of
Saturday runs) → backtest on the PDF archive → blend AI sentiment into the composite →
display a "signal performance" section on the Outlook page.

Sample data points: ICON P/BV 0.65, MPICO 0.58 (lowest); banks 8–13x.

---

## 9. Security

- **Cloudflare deploys:** short-lived `cfat_` account tokens sent by the owner via chat
  uploads, injected as the `CLOUDFLARE_API_TOKEN` env override for a deploy. Tokens expire
  (e.g. the Oct 3 token died Oct 5 23:59 UTC). Owner sends a fresh one per deploy, or should
  set up a longer-lived token for the v2 build phase. Hygiene: never commit tokens, never
  store expired ones.
- **Backend functions:** admin-checked (see §5 pattern); public URLs must authenticate via
  `base44.auth.me()` before any privileged write.
- **Secrets:** stored via platform secret management, never in workflow definitions or code.
  Workflow step args must never contain API keys; the function reads secrets itself.
- **Data:** all current data is public market data, no PII. v2 member layer will add auth
  (OAuth or hashed email+password) and per-user data in D1, at which point RLS and session
  handling become active concerns.
- **MseApiKey entity:** registry for API consumers (key, app, contact, active flag,
  request counters) — for metering third-party API use when exposed.
- **File safety:** platform scans uploads; blocked executable types are refused.

---

## 10. My role in the project (the agent's jobs)

1. **Data engineer:** scrape mse.co.mw, parse PDFs, validate, repair source errors,
   apply split adjustments, manage the dual-write to Base44 + Neon.
2. **Automation operator:** own the scheduled workflows (ETL, model report, announcement
   sweep), debug runs, keep them healthy; build durable chunked drivers for bulk imports.
3. **Model developer:** maintain the scoring model, verdicts, sentiment blending; run the
   Saturday model job; track the forward-model roadmap.
4. **Web developer:** build and deploy portal pages/features to the Cloudflare Worker,
   browser-verify UI at mobile + desktop breakpoints, bust caches with versioned assets.
5. **Analyst/reporter:** Telegram reports, announcement alerts, per-year backfill
   completion reports; maintain the "For you" open-items note.
6. **Infrastructure guard:** token hygiene, secrets handling, entity schema management,
   duplicate cleanup, pagination-safe reads.

Operating preferences recorded from the owner:
- Message only per-year completion or errors for long backfills (not per-chunk).
- Backfill to 2020, not 2019, in small chunks.
- Data corrections must be proven from source evidence (file's own cells, boundary checks)
  before applying.
- Owner approves branding (logo) before it ships.
- Disclaimers accompany model content (Learn tab, verdicts).

---

## 11. Gotchas & lessons (copy these into any similar project)

1. **Sandbox suspends between turns.** Background bash processes die. Durable work =
   DB-backed queue + server-side workflow chain (§7.2).
2. **MseImportChunk payload limit ~10KB.** 4-day chunks rejected; 2-day chunks pass.
   Pace loads for rate limits.
3. **SDK list() silently truncates around ~10k records.** Always paginate with
   skip/has_more; truncation caused 744 stale duplicates once.
4. **Backend functions cannot reach mse.co.mw; sandbox curl can.** Scrape agent-side,
   write via functions.
5. **Source PDFs contain typos.** Validate previous_close chains; use the next day's
   prev cell as an internal witness; cross-check P/E = mktcap / ATP.
6. **CSS specificity:** `.logo img` beats `.logo-mob`; use `.logo img.logo-mob`.
6b. **Version every asset** (`?v=YYYYMMDDn`) to bust CDN/browser caches.
7. **Cloudflare env-var tokens were dead; fresh cfat_ tokens via uploaded file work.**
   Track expiry dates.
8. **Local Chromium in sandbox:** `npx playwright install chromium` + apt with https://
   sources (http port 80 blocked) for libnspr4/libnss3 etc.
9. **Free-plan network:** HTTPS (port 443) only from sandbox.
10. **Exchange data gaps are real:** no-report days, partial days, suspensions. Build a
    missing-days census per year; don't treat chain breaks across gaps as import errors.
11. **Split adjustments are forever:** adjust full history, preserve raw_close, keep a
    split badge + as-traded toggle on the stock page.

---

## 12. Open items & roadmap

- [ ] **2020–2023 historical backfill** (in progress at handover: 2023 done — 224 reports,
      3,584 records, 112 chunks, workflow "Phungu Backfill 2023"; chain 2022 → 2021 → 2020)
- [ ] **Daily official index (MASI/DSI/FSI) feed** — close the Oct 2 static-import gap
- [ ] **v2 member layer** — auth (OAuth or hashed email+password), portfolio tracker,
      watchlist, "MSE AI" chatbot; user data in Cloudflare D1; needs D1-enabled token
- [ ] **giscus comments** — needs a GitHub account/repo from the owner
- [ ] **Custom domain** — brand would carry better than the workers.dev URL
- [ ] **Logo approval** — eagle + Phungu Insights draft with the owner since Oct 5
- [ ] **Forward model roadmap** — calibration/hit-rate (4–6 weeks of Saturday runs),
      archive backtest, sentiment blend, signal-performance section on Outlook
- [ ] **P/BV refresh** — include in future PDF top-ups (daily format lacks PBV)

### Delivered milestones (for context)
- 2026-09-07: Outlook page + Portfolio Lab v1 live; Saturday model run persisting sentiment
- 2026-10-01: PCL split fix live (raw_close, badge, toggle)
- 2026-10-03: 2025 backfill complete (250 days, 3,891 records)
- 2026-10-04: Official MASI/DSI/FSI live (661 days from 425 PDFs); After-Tax Profit display
- 2026-10-04: Portfolio Lab v2 (chips, windows, model-driven picker)
- 2026-10-05: P/BV + Model v0.3 + verdicts + Learn tab; UI/UX overhaul; Phungu Insights
  rebrand; 2023 backfill parsed and queued

---

*Working copy compiled from project memory and the open-items note. Update this file when
architecture, schedules, model weights, or security posture change.*
