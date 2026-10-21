import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Upsert Helper (same dedup logic as runMseEtl) ─────────
// Checks for existing record by symbol + market_type + trade_date
// Updates if found, creates if not — prevents duplicates

async function upsertStockPrice(base44: any, rec: any): Promise<"created" | "updated"> {
  const existing = await base44.asServiceRole.entities.MseStockPrice.list();
  const match = existing.find((r: any) =>
    r.symbol === rec.symbol &&
    r.market_type === rec.market_type &&
    r.trade_date === rec.trade_date
  );

  if (match) {
    await base44.asServiceRole.entities.MseStockPrice.update(match.id, rec);
    return "updated";
  } else {
    await base44.asServiceRole.entities.MseStockPrice.create(rec);
    return "created";
  }
}

// ─── Neon Backup for PDF imports ──────────────────────────

async function backupToNeon(records: any[], tradeDate: string): Promise<{ success: boolean; count: number; error: string }> {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    return { success: false, count: 0, error: "DATABASE_URL not configured" };
  }

  try {
    const sql = neon(databaseUrl);
    let inserted = 0;

    for (const rec of records) {
      await sql`
        INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, change_percent, volume, turnover, interest, previous_close, market_capitalization, pe_ratio, dividend_yield_percent, etl_run_date)
        VALUES (${rec.symbol}, ${rec.market_type}, ${tradeDate}, ${rec.open_price || 0}, ${rec.close_price}, ${rec.change_percent || 0}, ${rec.volume || 0}, ${rec.turnover || 0}, ${rec.interest || 0}, ${rec.previous_close || 0}, ${rec.market_capitalization || 0}, ${rec.pe_ratio || 0}, ${rec.dividend_yield_percent || 0}, NOW())
        ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
          open_price = EXCLUDED.open_price,
          close_price = EXCLUDED.close_price,
          change_percent = EXCLUDED.change_percent,
          volume = EXCLUDED.volume,
          turnover = EXCLUDED.turnover,
          interest = EXCLUDED.interest,
          previous_close = EXCLUDED.previous_close,
          market_capitalization = EXCLUDED.market_capitalization,
          pe_ratio = EXCLUDED.pe_ratio,
          dividend_yield_percent = EXCLUDED.dividend_yield_percent,
          etl_run_date = NOW()
      `;
      inserted++;
    }

    return { success: true, count: inserted, error: "" };
  } catch (err) {
    return { success: false, count: 0, error: err.message };
  }
}

async function sendTelegram(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("Telegram send failed:", e.message);
  }
}

// ─── Main Handler ──────────────────────────────────────────
// Accepts a JSON array of stock records with trade_date
// Each record must have: symbol, market_type, close_price, trade_date
// Optional: open_price, change_percent, volume, turnover, interest,
//           previous_close, market_capitalization, pe_ratio, dividend_yield_percent
//
// Example body:
// {
//   "trade_date": "2026-01-23",
//   "records": [
//     { "symbol": "NICO", "market_type": "mainboard", "close_price": 1724.97, ... }
//   ]
// }

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const startTime = Date.now();

  let tradeDate = "";
  let records: any[] = [];
  let trigger = "pdf_import";

  try {
    const body = await req.json();
    tradeDate = body.trade_date || "";
    records = body.records || [];
    if (body.trigger) trigger = body.trigger;
  } catch {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with 'trade_date' and 'records' array"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  if (!tradeDate || records.length === 0) {
    return new Response(JSON.stringify({
      error: "Both 'trade_date' and non-empty 'records' array are required"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  let createdCount = 0;
  let updatedCount = 0;
  let neonBackupStatus = "not attempted";
  let neonBackupCount = 0;
  let neonBackupError = "";

  try {
    // Upsert each record to Base44 with dedup
    for (const rec of records) {
      if (!rec.symbol || !rec.market_type || !rec.close_price) {
        console.error("Skipping invalid record:", JSON.stringify(rec));
        continue;
      }
      rec.trade_date = tradeDate;
      rec.data_source = "pdf_import";

      const result = await upsertStockPrice(base44, rec);
      if (result === "created") createdCount++;
      else updatedCount++;
    }

    // Backup to Neon
    if (records.length > 0) {
      const neonResult = await backupToNeon(records, tradeDate);
      if (neonResult.success) {
        neonBackupStatus = "success";
        neonBackupCount = neonResult.count;
      } else {
        neonBackupStatus = "failed";
        neonBackupError = neonResult.error;
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Import failed: " + err.message,
      created: createdCount,
      updated: updatedCount,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  // Send Telegram notification
  const neonLine = neonBackupStatus === "success"
    ? `💾 Neon: ✅ ${neonBackupCount} records`
    : neonBackupStatus === "failed"
    ? `💾 Neon: ❌ ${neonBackupError}`
    : `💾 Neon: skipped`;

  const telegramMsg = `📥 <b>MSE PDF Import</b>\n` +
    `📅 ${tradeDate}\n` +
    `📊 ${createdCount + updatedCount} records (${createdCount} new, ${updatedCount} updated)\n` +
    `${neonLine}\n` +
    `⏱ ${durationSeconds}s`;

  await sendTelegram(telegramMsg);

  return new Response(JSON.stringify({
    success: true,
    trade_date: tradeDate,
    total_records: createdCount + updatedCount,
    created: createdCount,
    updated: updatedCount,
    neon_backup: {
      status: neonBackupStatus,
      count: neonBackupCount,
      error: neonBackupError || undefined,
    },
    duration_seconds: durationSeconds,
  }), {
    headers: { "Content-Type": "application/json" },
  });
});
