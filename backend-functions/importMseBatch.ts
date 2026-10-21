import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Batch Excel/XLSX/PDF Import ──────────────────────────
// Accepts { days: [{ trade_date, records: [...] }], source? }
// Reads the full entity list ONCE, upserts all records, then
// batch-backs-up each day to Neon. Designed for multi-day imports.
// raw_close (split-aware: as-traded close, null when no split) and
// after_tax_profit (official PDF ATP column, MK millions) are passed
// through to BOTH the entity and Neon.

async function ensureNeonColumn(sql: any): Promise<void> {
  // Idempotent: safe on every call.
  await sql`ALTER TABLE mse_stock_prices ADD COLUMN IF NOT EXISTS after_tax_profit NUMERIC`;
}

async function backupDayToNeon(sql: any, records: any[], tradeDate: string): Promise<number> {
  let inserted = 0;
  for (const rec of records) {
    await sql`
      INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, raw_close, change_percent, volume, turnover, interest, previous_close, market_capitalization, pe_ratio, dividend_yield_percent, after_tax_profit, etl_run_date)
      VALUES (${rec.symbol}, ${rec.market_type}, ${tradeDate}, ${rec.open_price || 0}, ${rec.close_price}, ${rec.raw_close == null ? null : rec.raw_close}, ${rec.change_percent || 0}, ${rec.volume || 0}, ${rec.turnover || 0}, ${rec.interest || 0}, ${rec.previous_close || 0}, ${rec.market_capitalization || 0}, ${rec.pe_ratio || 0}, ${rec.dividend_yield_percent || 0}, ${rec.after_tax_profit == null ? null : rec.after_tax_profit}, NOW())
      ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
        open_price = EXCLUDED.open_price,
        close_price = EXCLUDED.close_price,
        raw_close = EXCLUDED.raw_close,
        change_percent = EXCLUDED.change_percent,
        volume = EXCLUDED.volume,
        turnover = EXCLUDED.turnover,
        interest = EXCLUDED.interest,
        previous_close = EXCLUDED.previous_close,
        market_capitalization = EXCLUDED.market_capitalization,
        pe_ratio = EXCLUDED.pe_ratio,
        dividend_yield_percent = EXCLUDED.dividend_yield_percent,
        after_tax_profit = EXCLUDED.after_tax_profit,
        etl_run_date = NOW()
    `;
    inserted++;
  }
  return inserted;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const startTime = Date.now();

  let days: any[] = [];
  let source = "excel_import";

  try {
    const body = await req.json();
    days = body.days || [];
    if (body.source) source = body.source;
  } catch {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with 'days' array"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  if (!Array.isArray(days) || days.length === 0) {
    return new Response(JSON.stringify({
      error: "'days' must be a non-empty array of {trade_date, records}"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // ONE full snapshot — no repeated list() calls
  const existing: any[] = await base44.asServiceRole.entities.MseStockPrice.list();
  const index = new Map<string, any>();
  for (const r of existing) {
    index.set(`${r.symbol}|${r.market_type}|${r.trade_date}`, r);
  }

  const sql = (() => {
    const databaseUrl = Deno.env.get("DATABASE_URL");
    return databaseUrl ? neon(databaseUrl) : null;
  })();

  if (sql) {
    try {
      await ensureNeonColumn(sql);
    } catch {
      // Column may already exist with different session rights; Neon sync will surface real errors.
    }
  }

  const results: any[] = [];

  try {
    for (const day of days) {
      const tradeDate = day.trade_date;
      const records = (day.records || []).filter((r: any) => r.symbol && r.market_type && r.close_price);
      let created = 0;
      let updated = 0;

      for (const rec of records) {
        const key = `${rec.symbol}|${rec.market_type}|${tradeDate}`;
        const clean: any = {
          symbol: rec.symbol,
          market_type: rec.market_type,
          trade_date: tradeDate,
          open_price: rec.open_price || 0,
          close_price: rec.close_price,
          raw_close: rec.raw_close == null ? null : rec.raw_close,
          change_percent: rec.change_percent || 0,
          volume: rec.volume || 0,
          turnover: rec.turnover || 0,
          interest: rec.interest || 0,
          previous_close: rec.previous_close || 0,
          market_capitalization: rec.market_capitalization || 0,
          pe_ratio: rec.pe_ratio || 0,
          dividend_yield_percent: rec.dividend_yield_percent || 0,
          after_tax_profit: rec.after_tax_profit == null ? null : rec.after_tax_profit,
          data_source: source,
        };
        const match = index.get(key);
        if (match) {
          await base44.asServiceRole.entities.MseStockPrice.update(match.id, clean);
          updated++;
        } else {
          const createdRec = await base44.asServiceRole.entities.MseStockPrice.create(clean);
          index.set(key, createdRec);
          created++;
        }
      }

      // Neon backup for this day (best-effort)
      let neonStatus = "skipped";
      let neonCount = 0;
      if (sql && records.length > 0) {
        try {
          neonCount = await backupDayToNeon(sql, records, tradeDate);
          neonStatus = neonCount === records.length ? "success" : "partial";
        } catch (e) {
          neonStatus = "failed: " + e.message;
        }
      }

      results.push({
        trade_date: tradeDate,
        created,
        updated,
        neon: { status: neonStatus, count: neonCount },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Batch import failed: " + err.message,
      completed_days: results,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  return new Response(JSON.stringify({
    success: true,
    days_processed: results.length,
    results,
    duration_seconds: durationSeconds,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
