# MSE Data API — Complete Implementation Guide

> A full-stack market data pipeline: scrape, store, back up, serve via API, and alert on Telegram.
> Built on Base44 with Neon PostgreSQL backup.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Tech Stack](#3-tech-stack)
4. [Packages & Dependencies](#4-packages--dependencies)
5. [Database Design](#5-database-design)
6. [Backend Functions](#6-backend-functions)
7. [Scheduled Workflow](#7-scheduled-workflow)
8. [API Key System](#8-api-key-system)
9. [Secrets & Environment Variables](#9-secrets--environment-variables)
10. [Telegram Notifications](#10-telegram-notifications)
11. [Neon PostgreSQL Backup](#11-neon-postgresql-backup)
12. [Best Practices & Patterns](#12-best-practices--patterns)
13. [Step-by-Step Replication Guide](#13-step-by-step-replication-guide)
14. [Full Source Code](#14-full-source-code)

---

## 1. System Overview

This system implements an automated ETL (Extract, Transform, Load) pipeline that:

- **Scrapes** the Malawi Stock Exchange website (mse.co.mw) for stock prices across three market segments (mainboard, debt, edgex)
- **Calculates** percentage change from the previous trading day's close (not scraped from source)
- **Stores** data in Base44 entities (primary database)
- **Backs up** to Neon PostgreSQL (external backup database) via dual-write
- **Serves** data to external applications through a REST API with API key authentication
- **Exports** data as CSV or JSON
- **Alerts** via Telegram on every ETL run (success or failure), including backup status
- **Runs** automatically 3x daily on weekdays (9:00, 13:00, 15:00 CAT)

---

## 2. Architecture Diagram

```
                    ┌──────────────────────────────────────────────┐
                    │            SCHEDULED WORKFLOW                │
                    │  Cron: 0 9,13,15 * * 1-5 (Africa/Blantyre)   │
                    │  Triggers: Agent → calls runMseEtl function   │
                    └──────────────────┬───────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │         runMseEtl (ETL)          │
                    │                                  │
                    │  1. Fetch HTML from mse.co.mw    │
                    │     - /market/mainboard          │
                    │     - /market/debt              │
                    │     - /market/edgex             │
                    │                                  │
                    │  2. Parse HTML tables            │
                    │     - Regex extraction           │
                    │     - Number parsing             │
                    │     - Trade date extraction      │
                    │                                  │
                    │  3. Calculate change_percent     │
                    │     - Fetch previous close      │
                    │     - (close-prev)/prev * 100   │
                    │                                  │
                    │  4. Write to Base44 (primary)    │
                    │     - MseStockPrice entity       │
                    │     - MseEtlLog entity           │
                    │                                  │
                    │  5. Backup to Neon (best-effort)  │
                    │     - Upsert via ON CONFLICT     │
                    │     - Log to Neon etl_log        │
                    │                                  │
                    │  6. Send Telegram alert          │
                    │     - Status + counts + backup   │
                    └──────────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
              ┌──────────┐    ┌──────────────┐    ┌────────────┐
              │  Base44   │    │     Neon     │    │  Telegram  │
              │ Entities  │    │  PostgreSQL  │    │    Bot     │
              │ (primary) │    │  (backup)    │    │  (alerts)  │
              └─────┬─────┘    └──────────────┘    └────────────┘
                    │
                    ▼
              ┌──────────────────────────────────────┐
              │         API LAYER (Backend Functions) │
              │                                      │
              │  getMseStocks      → Latest prices    │
              │  getMseStockHistory → Historical data │
              │  exportMseExcel    → CSV/JSON export  │
              │  generateApiKey    → Key management   │
              │                                      │
              │  Auth: x-api-key header → MseApiKey   │
              │  Rate tracking: requests_count++      │
              └──────────────────────────────────────┘
                    │
                    ▼
              ┌──────────────────┐
              │  External Apps   │
              │  (any language)  │
              └──────────────────┘
```

---

## 3. Tech Stack

| Component            | Technology                              | Purpose                                    |
|---------------------|-----------------------------------------|--------------------------------------------|
| **Platform**         | Base44 (Superagent)                     | Hosts backend functions, entities, workflows, secrets |
| **Runtime**          | Deno (serverless)                       | Backend function execution environment     |
| **Primary Database** | Base44 Entities (NoSQL/MongoDB-backed)  | Stock prices, ETL logs, API keys           |
| **Backup Database**  | Neon PostgreSQL (serverless)            | External backup with upsert logic         |
| **Data Source**      | mse.co.mw (server-rendered HTML)        | Malawi Stock Exchange market pages        |
| **Notifications**    | Telegram Bot API                        | ETL status alerts (success/error)         |
| **Scheduling**       | Base44 Workflows (CNCF SWF v1.0)       | Cron-based ETL triggers                    |
| **API Auth**         | Custom API key (UUID-based)            | Per-application access control             |
| **Data Export**      | CSV / JSON                              | Downloadable market data                   |

---

## 4. Packages & Dependencies

All packages are imported via `npm:` specifier (Deno convention) — no package.json needed.

| Package                              | Version  | Purpose                                      |
|-------------------------------------|----------|----------------------------------------------|
| `@base44/sdk`                       | 0.8.31   | Base44 SDK — entity CRUD, auth, service role |
| `@neondatabase/serverless`         | 0.10.0   | Neon PostgreSQL HTTP driver for Deno         |

**Import patterns:**

```typescript
// Base44 SDK — create authenticated client from request
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// Neon serverless driver — HTTP-based Postgres queries
import { neon } from "npm:@neondatabase/serverless@0.10.0";
```

> **Why `@neondatabase/serverless`?** It uses HTTP (not TCP/WebSockets), which works in Deno's serverless environment where persistent connections aren't available. The `neon()` function returns a tagged template SQL client.

**Telegram Bot API** — no package needed. Uses standard `fetch()` to call `https://api.telegram.org/bot<token>/sendMessage`.

---

## 5. Database Design

### 5.1 Base44 Entities (Primary)

#### MseStockPrice

Stores one record per stock per market segment per trade date.

```json
{
  "symbol": "NICO",           // Stock ticker (string, required)
  "market_type": "mainboard",  // mainboard | debt | edgex (enum, required)
  "trade_date": "2026-08-05",  // YYYY-MM-DD (string, required)
  "open_price": 1347.97,       // Opening price in MWK (number)
  "close_price": 1344.95,      // Closing price in MWK (number, required)
  "change_percent": -0.19,     // Calculated: (close - prev_close) / prev_close * 100 (number)
  "volume": 4432,              // Shares traded (number)
  "turnover": 5974018.00,      // Total value traded in MWK (number)
  "interest": 0                // Interest rate — debt only, 0 for equities (number)
}
```

Auto-included fields: `id`, `created_date`, `updated_date`, `created_by`.

#### MseEtlLog

Tracks every ETL run for observability and debugging.

```json
{
  "run_date": "2026-08-05T09:00:00.000Z",  // ISO timestamp (string, required)
  "status": "success",                      // success | error (enum, required)
  "records_processed": 34,                  // Total records saved (number)
  "error_message": "",                      // Error details if failed (string)
  "duration_seconds": 12,                   // Run duration (number)
  "trigger": "scheduled"                     // scheduled | manual | api (enum)
}
```

#### MseApiKey

Manages API keys for external application access.

```json
{
  "api_key": "mse_<redacted>",  // UUID-based key (string, required)
  "app_name": "Trading Dashboard",                              // App identifier (string, required)
  "contact_email": "dev@wiztech.mw",                            // Contact (string)
  "is_active": true,                                           // Active flag (boolean, required)
  "last_used": "2026-08-05T09:15:00.000Z",                     // Last API call timestamp (string)
  "requests_count": 142                                         // Total API calls (number)
}
```

### 5.2 Neon PostgreSQL Tables (Backup)

Created by the `initNeonDb` function. Uses PostgreSQL-native types.

```sql
CREATE TABLE mse_stock_prices (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  market_type VARCHAR(20) NOT NULL,
  trade_date DATE NOT NULL,
  open_price NUMERIC(20, 2),
  close_price NUMERIC(20, 2),
  change_percent NUMERIC(10, 4),
  volume BIGINT,
  turnover NUMERIC(20, 2),
  interest NUMERIC(10, 4),
  etl_run_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, market_type, trade_date)
);

CREATE TABLE mse_etl_log (
  id SERIAL PRIMARY KEY,
  run_date TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) NOT NULL,
  records_processed INTEGER DEFAULT 0,
  duration_seconds NUMERIC(10, 2),
  error_message TEXT,
  trigger VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_mse_symbol ON mse_stock_prices(symbol);
CREATE INDEX idx_mse_trade_date ON mse_stock_prices(trade_date);
CREATE INDEX idx_mse_market_type ON mse_stock_prices(market_type);
```

**Key design decisions:**
- `UNIQUE(symbol, market_type, trade_date)` constraint enables `ON CONFLICT` upserts — re-running ETL for the same day updates rather than duplicates
- `NUMERIC(20, 2)` for prices — handles large Malawi Kwacha values without floating-point errors
- `NUMERIC(10, 4)` for change_percent — supports 4 decimal places of precision
- `BIGINT` for volume — handles large share counts

---

## 6. Backend Functions

All functions are Deno serverless functions deployed on Base44. Each uses `Deno.serve()` as the entry point.

### 6.1 runMseEtl — The ETL Pipeline

**The core function.** Scrapes MSE, calculates change %, writes to Base44 + Neon, sends Telegram alert.

**Flow:**
1. Fetch HTML from 3 market pages on mse.co.mw
2. Parse HTML tables using regex (symbols, prices, volumes)
3. Extract trade date from page ("Updated on: DD/MM/YYYY")
4. Fetch previous closes from Base44 (most recent record per symbol with different trade_date)
5. Calculate `change_percent = (current_close - prev_close) / prev_close * 100`
6. Write records to Base44 `MseStockPrice` entity
7. Write ETL log to Base44 `MseEtlLog` entity
8. Backup all records to Neon (best-effort, upsert via ON CONFLICT)
9. Write ETL log to Neon
10. Send Telegram message with status, counts, and backup status

**Key patterns:**
- HTML scraping via regex (no DOM parser in Deno serverless)
- Per-market error isolation (one market failing doesn't stop others)
- Best-effort Neon backup (Neon down → ETL continues, reports failure in Telegram)
- Timing measurement via `Date.now()`

### 6.2 generateApiKey — Key Generation

**Protected by master key.** Only the system owner can generate new API keys.

- Validates `x-master-key` header against `MSE_API_KEY` secret
- Generates key: `mse_` + UUID (no hyphens) + 8-char UUID suffix
- Stores in `MseApiKey` entity with `is_active: true`, `requests_count: 0`

### 6.3 getMseStocks — Latest Prices API

Returns the most recent price snapshot per stock, filterable by market type and symbol.

- Auth: validates `x-api-key` header against `MseApiKey` entity
- Usage tracking: increments `requests_count`, updates `last_used`
- Fetches all records, filters in JavaScript, deduplicates by symbol (latest only)

### 6.4 getMseStockHistory — Historical Data API

Returns historical price records for a specific stock, filterable by date range.

- Same auth + usage tracking as getMseStocks
- Required param: `symbol`
- Optional: `from_date`, `to_date`, `market_type`, `limit`

### 6.5 exportMseExcel — CSV/JSON Export

Returns stock data as a downloadable CSV file or JSON response.

- Same auth + usage tracking
- CSV: returns `text/csv` with `Content-Disposition: attachment` header
- JSON: returns standard JSON response
- Filename: `mse_stock_data_YYYY-MM-DD.csv`

### 6.6 initNeonDb — Neon Setup (one-time)

Creates tables and indexes in Neon PostgreSQL. Run once during initial setup.

### 6.7 syncToNeon — Manual Backfill

Syncs all existing Base44 records to Neon. Useful for initial setup or re-syncing after downtime.

---

## 7. Scheduled Workflow

Defined as a CNCF Serverless Workflow v1.0 document, deployed via Base44's workflow system.

```json
{
  "name": "MSE Daily ETL",
  "trigger": {
    "config": {
      "trigger_type": "scheduled",
      "cron_expression": "0 9,13,15 * * 1-5",
      "timezone": "Africa/Blantyre"
    }
  },
  "definition": {
    "document": {
      "dsl": "1.0.0",
      "name": "mse_daily_etl",
      "version": "2.0",
      "namespace": "base44"
    },
    "do": [
      {
        "run_etl": {
          "call": "invoke_superagent_step",
          "with": {
            "message": "Run the MSE ETL pipeline now. Call the runMseEtl backend function with trigger 'scheduled'. Report the results."
          },
          "then": "end"
        }
      }
    ]
  }
}
```

**Key points:**
- Cron `0 9,13,15 * * 1-5` = at 09:00, 13:00, 15:00 on Monday-Friday
- Timezone is set to the user's local timezone — no UTC conversion needed
- Uses `invoke_superagent_step` (agent LLM turn) which calls the backend function
- The workflow triggers the agent, which calls `runMseEtl` with `trigger: "scheduled"`

---

## 8. API Key System

### Design

```
┌─────────────┐     x-master-key      ┌───────────────┐
│  Admin/Owner │ ───────────────────→  │ generateApiKey │
└─────────────┘                        └───────┬───────┘
                                               │ creates
                                               ▼
                                       ┌───────────────┐
                                       │  MseApiKey    │
                                       │  entity       │
                                       └───────┬───────┘
                                               │ validated on each call
                                               ▼
┌─────────────┐     x-api-key         ┌───────────────┐
│ External App │ ──────────────────→  │ getMseStocks   │
└─────────────┘                       │ getMseStockHistory │
                                      │ exportMseExcel  │
                                      └───────────────┘
```

- **Two-tier auth:** Master key (for key generation) → API keys (for data access)
- **Key format:** `mse_` + 40 random hex chars (UUID-based)
- **Usage tracking:** Every API call increments `requests_count` and updates `last_used`
- **Key management:** Keys can be deactivated by setting `is_active: false` (no deletion needed)

---

## 9. Secrets & Environment Variables

All secrets are stored in Base44's encrypted secrets system and accessed via `Deno.env.get()`.

| Secret Name          | Description                              | Used By                    |
|---------------------|------------------------------------------|----------------------------|
| `MSE_API_KEY`       | Master key for generating API keys       | generateApiKey             |
| `TELEGRAM_BOT_TOKEN`| Telegram bot token from BotFather        | runMseEtl                  |
| `TELEGRAM_CHAT_ID`  | Telegram chat ID to send alerts to       | runMseEtl                  |
| `DATABASE_URL`      | Neon PostgreSQL connection string        | runMseEtl, syncToNeon, initNeonDb |

**Setup:**
1. `MSE_API_KEY` — generate any strong random string
2. `TELEGRAM_BOT_TOKEN` — create a bot via [@BotFather](https://t.me/BotFather) on Telegram
3. `TELEGRAM_CHAT_ID` — get your chat ID by messaging the bot and visiting `https://api.telegram.org/bot<token>/getUpdates`
4. `DATABASE_URL` — from Neon dashboard: `postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`

---

## 10. Telegram Notifications

Every ETL run sends a Telegram message with HTML formatting:

**Success:**
```
✅ MSE ETL SUCCESS
📅 2026-08-05T09:00:00.000Z
⏱ 15s
📊 34 records processed
🔑 Trigger: scheduled
💾 Neon backup: ✅ 34 records

  • mainboard: 16 records
  • debt: 18 records
  • edgex: 0 records (market closed or no data)
```

**Error:**
```
❌ MSE ETL ERROR
📅 2026-08-05T09:00:00.000Z
⏱ 2s
📊 0 records processed
🔑 Trigger: scheduled
💾 Neon backup: skipped
⚠️ Error: No records were extracted from any market

  • mainboard: ERROR — HTTP 503
  • debt: ERROR — HTTP 503
  • edgex: ERROR — HTTP 503
```

**Implementation:**
```typescript
async function sendTelegram(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      }),
    });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}
```

**Best practices:**
- Telegram failures are non-blocking (caught and logged, don't fail the ETL)
- Uses HTML parse mode for formatting (bold, emoji, line breaks)
- Includes Neon backup status in every message

---

## 11. Neon PostgreSQL Backup

### Strategy: Dual-Write with Best-Effort Backup

```
Base44 (Primary)  ◄── write first, always succeeds
       │
       ▼
Neon (Backup)     ◄── write second, best-effort
                      if fails → log + Telegram alert, ETL continues
```

### Why Neon?

- **Serverless Postgres** — scales to zero, no idle costs
- **HTTP driver** (`@neondatabase/serverless`) — works in Deno serverless where TCP connections aren't available
- **Free tier** — 0.5 GB per project (sufficient for years of MSE data)
- **Upsert support** — `ON CONFLICT (symbol, market_type, trade_date) DO UPDATE` prevents duplicates

### Upsert Pattern

```typescript
const sql = neon(databaseUrl);

await sql`
  INSERT INTO mse_stock_prices (symbol, market_type, trade_date, ...)
  VALUES (${rec.symbol}, ${rec.market_type}, ${tradeDate}, ...)
  ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
    open_price = EXCLUDED.open_price,
    close_price = EXCLUDED.close_price,
    change_percent = EXCLUDED.change_percent,
    ...
`;
```

**Key points:**
- The `UNIQUE(symbol, market_type, trade_date)` constraint makes upserts possible
- Re-running ETL for the same day updates records instead of creating duplicates
- If Neon is down, the function returns `{ success: false, error: "..." }` and the ETL continues normally

### Backfill Function

`syncToNeon` reads all records from Base44 and pushes to Neon. Run once during setup or after any sync gap.

---

## 12. Best Practices & Patterns

### 12.1 HTML Scraping

- **Use regex, not DOM parsers** — Deno serverless doesn't have `DOMParser` or `cheerio`. Regex is fast and sufficient for server-rendered tables.
- **Set realistic User-Agent** — some sites block default fetch UAs.
- **Isolate per-source errors** — wrap each market fetch in try/catch so one failing page doesn't kill the entire ETL.
- **Extract trade date from the page** — don't assume today's date; markets may close or the page may show yesterday's data.

```typescript
async function fetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return await resp.text();
}
```

### 12.2 Base44 SDK Quirks

- **`list()` must be called WITHOUT parameters** — passing `sort`, `filter`, or `limit` to `list()` causes silent failures or empty results. Instead, fetch all records and filter/sort in JavaScript.
- **`create()` takes data directly** — don't wrap data in `{ data: {...} }`. Pass the object directly: `entity.create({ symbol: "NICO", ... })`.
- **Use `asServiceRole` for server-side operations** — `base44.asServiceRole.entities.EntityName` bypasses row-level security for backend functions.

```typescript
// ❌ DON'T do this — SDK filter params are unreliable
const records = await base44.asServiceRole.entities.MseStockPrice.list({
  filter: { market_type: "mainboard" },
  sort: "-created_date",
  limit: 100
});

// ✅ DO this — fetch all, filter in JS
const allRecords = await base44.asServiceRole.entities.MseStockPrice.list();
const filtered = allRecords
  .filter(r => r.market_type === "mainboard")
  .sort((a, b) => (b.created_date || "").localeCompare(a.created_date || ""))
  .slice(0, 100);
```

### 12.3 Calculated vs Scraped Values

- **Don't trust scraped percentage changes** — source websites may display stale or inconsistent values. Calculate your own from raw prices.
- **Formula:** `change_percent = round((current_close - previous_close) / previous_close * 100, 2)`
- **Handle edge cases:** Previous close of 0 → return 0 (avoid division by zero)
- **Fetch previous close from DB** — find the most recent record for each symbol with a different `trade_date`

### 12.4 Dual-Database Backup

- **Primary database writes first** — ensures data is saved even if backup fails
- **Backup is best-effort** — wrap in try/catch, report failure in alerts, never block the primary write
- **Use upserts** — `ON CONFLICT ... DO UPDATE` prevents duplicates on re-runs
- **Log to both databases** — ETL logs in both Base44 and Neon for cross-database observability

### 12.5 API Key Management

- **Separate master key from API keys** — master key generates API keys; API keys access data
- **Track usage per key** — `requests_count` and `last_used` fields provide auditability
- **Soft-deactivate, don't delete** — set `is_active: false` to revoke access without losing history
- **Keys are UUID-based** — `crypto.randomUUID()` provides cryptographic randomness

### 12.6 Telegram Alerts

- **Non-blocking** — Telegram failures are caught and logged; they never fail the ETL
- **Include actionable info** — status, timing, record counts, error messages, backup status
- **Use HTML parse mode** — enables bold text, emoji, and line breaks
- **Send on both success AND failure** — silence is worse than a "no data" message

### 12.7 Workflow Scheduling

- **Use the user's timezone** — Base44 workflows support timezone-aware cron; no manual UTC conversion
- **Multiple runs per day** — markets update throughout the trading day; 3 runs capture intraday changes
- **Weekdays only** — `1-5` in cron excludes weekends when markets are closed
- **Agent step triggers function** — the workflow calls the agent, which calls the backend function

### 12.8 Number Parsing

- **Clean before parsing** — remove commas, currency symbols, and non-numeric characters
- **Handle NaN** — return 0 for unparseable values, never propagate NaN

```typescript
function parseNumber(str: string): number {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, "").replace(/[^0-9.\-]/g, "").trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}
```

---

## 13. Step-by-Step Replication Guide

### Prerequisites
- A Base44 account (Superagent plan)
- A Telegram account (for bot alerts)
- A Neon PostgreSQL account (free tier works)

### Step 1: Create Entities

Create three entities in your Base44 app:

1. **MseStockPrice** — fields: symbol (string), market_type (enum: mainboard/debt/edgex), trade_date (string), open_price (number), close_price (number), change_percent (number), volume (number), turnover (number), interest (number)
2. **MseEtlLog** — fields: run_date (string), status (enum: success/error), records_processed (number), error_message (string), duration_seconds (number), trigger (enum: scheduled/manual/api)
3. **MseApiKey** — fields: api_key (string), app_name (string), contact_email (string), is_active (boolean), last_used (string), requests_count (number)

### Step 2: Set Secrets

Configure these secrets in your Base44 agent:
- `MSE_API_KEY` — any strong random string (e.g., generate via `openssl rand -hex 32`)
- `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram
- `TELEGRAM_CHAT_ID` — your Telegram chat ID
- `DATABASE_URL` — Neon connection string

### Step 3: Deploy initNeonDb

Deploy the `initNeonDb` function and call it once to create tables in Neon.

### Step 4: Deploy Backend Functions

Deploy all 7 functions:
1. `runMseEtl` — the ETL pipeline
2. `generateApiKey` — API key generation
3. `getMseStocks` — latest prices endpoint
4. `getMseStockHistory` — historical data endpoint
5. `exportMseExcel` — CSV/JSON export
6. `initNeonDb` — Neon setup (already done in Step 3)
7. `syncToNeon` — manual backfill

### Step 5: Run Initial ETL + Backfill

1. Call `runMseEtl` manually to populate Base44 with current data
2. Call `syncToNeon` to backfill all data to Neon

### Step 6: Generate API Key

Call `generateApiKey` with your master key to create an API key for external apps.

### Step 7: Create Workflow

Create a scheduled workflow with cron `0 9,13,15 * * 1-5` in your timezone that triggers the ETL.

### Step 8: Test Everything

1. Verify Telegram received the ETL alert
2. Call `getMseStocks` with the API key — should return data
3. Call `getMseStockHistory` with a symbol — should return history
4. Call `exportMseExcel` — should download a CSV
5. Check Neon database — should have matching records

---

## 14. Full Source Code

All source files are in the `functions/` directory:

| File | Function | Lines | Purpose |
|------|----------|-------|---------|
| `functions/runMseEtl.ts` | runMseEtl | ~250 | ETL pipeline + Neon backup + Telegram |
| `functions/generateApiKey.ts` | generateApiKey | ~60 | API key creation (master-key protected) |
| `functions/getMseStocks.ts` | getMseStocks | ~70 | Latest prices API endpoint |
| `functions/getMseStockHistory.ts` | getMseStockHistory | ~70 | Historical data API endpoint |
| `functions/exportMseExcel.ts` | exportMseExcel | ~80 | CSV/JSON export endpoint |
| `functions/initNeonDb.ts` | initNeonDb | ~60 | Neon table setup (one-time) |
| `functions/syncToNeon.ts` | syncToNeon | ~70 | Manual backfill to Neon |

### API Documentation File

A separate API documentation file for external developers is available at:
`MSE_API_Documentation.md` — covers endpoints, parameters, code examples (JS/Python/cURL/PHP), and error handling.

---

## Summary

This system demonstrates a production-grade ETL pipeline with:

- **Automated data collection** from a non-API source (HTML scraping)
- **Calculated metrics** (change_percent) rather than trusting source data
- **Dual-database storage** with primary + backup strategy
- **Key-based API access** for external applications
- **Real-time alerting** via Telegram
- **Scheduled automation** via Base44 workflows
- **Export capabilities** (CSV/JSON)
- **Audit trail** (ETL logs in both databases)
- **Fault tolerance** (per-market error isolation, best-effort backup, non-blocking alerts)

The architecture is modular — each component can be replaced independently:
- Data source → swap the scraper for a different exchange
- Primary DB → swap Base44 for any database
- Backup DB → swap Neon for Supabase, MongoDB, etc.
- Notifications → swap Telegram for Slack, email, etc.
- Scheduling → swap Base44 workflows for cron, AWS EventBridge, etc.
