import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Helpers ──────────────────────────────────────────────

function parseNumber(str: string): number {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, "").replace(/[^0-9.\-]/g, "").trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function extractSymbol(rowHtml: string): string | null {
  const match = rowHtml.match(/<a[^>]*>\s*(.*?)\s*<\/a>/s);
  if (!match) return null;
  return match[1].trim();
}

function stripTags(html: string): string {
  // fixpoint loop: prevents "<scr<script>ipt>" reassembling into "<script>"
  let prev: string;
  do {
    prev = html;
    html = html.replace(/<[^>]*>/g, "");
  } while (html !== prev);
  return html.replace(/<|>/g, "");
}

function extractRightCells(rowHtml: string): string[] {
  const matches = [...rowHtml.matchAll(/<td\s+class="text-right[^"]*">(.*?)<\/td>/gs)];
  return matches.map(m => stripTags(m[1]).trim());
}

function extractTradeDate(html: string): string {
  const m = html.match(/Updated on:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${year}-${month}-${day}`;
  }
  return new Date().toISOString().split("T")[0];
}

function parseMarketRows(html: string, marketType: string) {
  const results: any[] = [];
  const rowRegex = /<tr>\s*<td><i class="fa fa-sort">.*?<a[^>]*>.*?<\/a>.*?<\/tr>/gs;
  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    const symbol = extractSymbol(row);
    if (!symbol) continue;
    const cells = extractRightCells(row);

    if (marketType === "debt") {
      results.push({
        symbol,
        market_type: "debt",
        open_price: 0,
        close_price: parseNumber(cells[1] || "0"),
        change_percent: parseNumber(cells[2] || "0"),
        volume: parseNumber(cells[3] || "0"),
        turnover: 0,
        interest: parseNumber(cells[0] || "0"),
      });
    } else {
      results.push({
        symbol,
        market_type: marketType,
        open_price: parseNumber(cells[0] || "0"),
        close_price: parseNumber(cells[1] || "0"),
        change_percent: parseNumber(cells[2] || "0"),
        volume: parseNumber(cells[3] || "0"),
        turnover: parseNumber(cells[4] || "0"),
        interest: 0,
      });
    }
  }
  return results;
}

async function fetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return await resp.text();
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

// ─── Calculate Change Percent ─────────────────────────────
// Looks up the most recent prior record for each symbol and
// calculates change_percent ourselves instead of trusting
// the MSE website's displayed value (which is often 0.00).

function calculateChangePercent(
  records: any[],
  existingRecords: any[],
  tradeDate: string
): { recalculated: number } {
  const prevCloseMap = new Map<string, { close: number; date: string }>();

  for (const rec of existingRecords) {
    if (rec.trade_date >= tradeDate) continue;
    const key = `${rec.symbol}_${rec.market_type}`;
    const existing = prevCloseMap.get(key);
    if (!existing || rec.trade_date > existing.date) {
      prevCloseMap.set(key, { close: rec.close_price, date: rec.trade_date });
    }
  }

  let recalculated = 0;

  for (const rec of records) {
    const key = `${rec.symbol}_${rec.market_type}`;
    const prev = prevCloseMap.get(key);

    if (prev && prev.close > 0) {
      const calculated = ((rec.close_price - prev.close) / prev.close) * 100;
      rec.change_percent = Math.round(calculated * 100) / 100;
      rec.previous_close = prev.close;
      recalculated++;
    } else {
      rec.previous_close = 0;
    }
  }

  return { recalculated };
}

// ─── Batch Upsert (optimized — reuses fetched records) ────
// Does a SINGLE list() call, then upserts all records using that snapshot.
// Avoids hitting read limits by not calling list() per record.

async function batchUpsertStockPrices(base44: any, records: any[], existingRecords: any[]): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  // Build lookup from existing records
  const existingMap = new Map<string, string>();
  for (const rec of existingRecords) {
    const key = `${rec.symbol}_${rec.market_type}_${rec.trade_date}`;
    existingMap.set(key, rec.id);
  }

  for (const rec of records) {
    const key = `${rec.symbol}_${rec.market_type}_${rec.trade_date}`;
    const existingId = existingMap.get(key);

    if (existingId) {
      await base44.asServiceRole.entities.MseStockPrice.update(existingId, rec);
      updated++;
    } else {
      await base44.asServiceRole.entities.MseStockPrice.create(rec);
      created++;
      // Add to map so subsequent records in same batch don't duplicate
      existingMap.set(key, "new");
    }
  }

  return { created, updated };
}

// ─── Neon Backup ──────────────────────────────────────────

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
        INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, change_percent, volume, turnover, interest, previous_close, data_source, etl_run_date)
        VALUES (${rec.symbol}, ${rec.market_type}, ${tradeDate}, ${rec.open_price}, ${rec.close_price}, ${rec.change_percent}, ${rec.volume}, ${rec.turnover}, ${rec.interest}, ${rec.previous_close || 0}, ${rec.data_source || "live_scrape"}, NOW())
        ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
          open_price = EXCLUDED.open_price,
          close_price = EXCLUDED.close_price,
          change_percent = EXCLUDED.change_percent,
          volume = EXCLUDED.volume,
          turnover = EXCLUDED.turnover,
          interest = EXCLUDED.interest,
          previous_close = EXCLUDED.previous_close,
          data_source = EXCLUDED.data_source,
          etl_run_date = NOW()
      `;
      inserted++;
    }

    return { success: true, count: inserted, error: "" };
  } catch (err) {
    return { success: false, count: 0, error: err.message };
  }
}

async function logToNeon(runDate: string, status: string, recordsProcessed: number, durationSeconds: number, errorMessage: string, trigger: string): Promise<void> {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) return;

  try {
    const sql = neon(databaseUrl);
    await sql`
      INSERT INTO mse_etl_log (run_date, status, records_processed, duration_seconds, error_message, trigger)
      VALUES (${runDate}, ${status}, ${recordsProcessed}, ${durationSeconds}, ${errorMessage || null}, ${trigger})
    `;
  } catch (e) {
    console.error("Neon ETL log failed:", e.message);
  }
}

// ─── Main Handler ──────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const startTime = Date.now();
  let status = "success";
  let errorMessage = "";
  let totalRecords = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let recalculated = 0;
  const marketSummaries: string[] = [];
  let neonBackupStatus = "not attempted";
  let neonBackupCount = 0;
  let neonBackupError = "";

  let trigger = "manual";
  try {
    const body = await req.json();
    if (body?.trigger) trigger = body.trigger;
  } catch {}

  try {
    const baseUrl = "https://mse.co.mw";
    const todayDate = new Date().toISOString().split("T")[0];
    let actualTradeDate = todayDate;

    const markets = [
      { url: `${baseUrl}/market/mainboard`, type: "mainboard" },
      { url: `${baseUrl}/market/debt`, type: "debt" },
      { url: `${baseUrl}/market/edgex`, type: "edgex" },
    ];

    const allRecordsForNeon: any[] = [];

    // Fetch existing records ONCE for change calculation + dedup
    const existingRecords = await base44.asServiceRole.entities.MseStockPrice.list();

    for (const market of markets) {
      try {
        const html = await fetchPage(market.url);
        const pageDate = extractTradeDate(html);
        if (pageDate !== todayDate) actualTradeDate = pageDate;

        const records = parseMarketRows(html, market.type);

        if (records.length === 0) {
          marketSummaries.push(`${market.type}: 0 records (market closed or no data)`);
          continue;
        }

        // Calculate our own change_percent using previous day's close
        const calcResult = calculateChangePercent(records, existingRecords, actualTradeDate);
        recalculated += calcResult.recalculated;

        // Set trade_date and data_source before upsert
        for (const rec of records) {
          rec.trade_date = actualTradeDate;
          rec.data_source = "live_scrape";
        }

        // Batch upsert — reuses existingRecords, no extra list() calls
        const upsertResult = await batchUpsertStockPrices(base44, records, existingRecords);
        createdCount += upsertResult.created;
        updatedCount += upsertResult.updated;

        allRecordsForNeon.push(...records);
        totalRecords += records.length;
        marketSummaries.push(`${market.type}: ${records.length} records`);
      } catch (err) {
        marketSummaries.push(`${market.type}: ERROR — ${err.message}`);
        console.error(`Error fetching ${market.type}:`, err.message);
      }
    }

    if (totalRecords === 0) {
      status = "error";
      errorMessage = "No records were extracted from any market";
    }

    // Backup to Neon
    if (allRecordsForNeon.length > 0) {
      const neonResult = await backupToNeon(allRecordsForNeon, actualTradeDate);
      if (neonResult.success) {
        neonBackupStatus = "success";
        neonBackupCount = neonResult.count;
      } else {
        neonBackupStatus = "failed";
        neonBackupError = neonResult.error;
        console.error("Neon backup failed:", neonResult.error);
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err.message;
    console.error("ETL error:", err);
  }

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  // Log to Base44
  try {
    await base44.asServiceRole.entities.MseEtlLog.create({
      run_date: new Date().toISOString(),
      status,
      records_processed: totalRecords,
      error_message: errorMessage,
      duration_seconds: durationSeconds,
      trigger,
    });
  } catch (e) {
    console.error("Failed to write ETL log:", e.message);
  }

  // Log to Neon
  await logToNeon(new Date().toISOString(), status, totalRecords, durationSeconds, errorMessage, trigger);

  // Send Telegram notification
  const emoji = status === "success" ? "✅" : "❌";
  const summaryLines = marketSummaries.map(s => `  • ${s}`).join("\n");
  const neonLine = neonBackupStatus === "success"
    ? `💾 Neon backup: ✅ ${neonBackupCount} records`
    : neonBackupStatus === "failed"
    ? `💾 Neon backup: ❌ ${neonBackupError}`
    : `💾 Neon backup: skipped`;
  const dedupLine = status === "success"
    ? `📝 ${createdCount} new, ${updatedCount} updated, ${recalculated} changes recalculated`
    : "";
  const telegramMsg = `${emoji} <b>MSE ETL ${status.toUpperCase()}</b>\n` +
    `📅 ${new Date().toISOString()}\n` +
    `⏱ ${durationSeconds}s\n` +
    `📊 ${totalRecords} records processed\n` +
    (dedupLine ? `${dedupLine}\n` : "") +
    `🔑 Trigger: ${trigger}\n` +
    `${neonLine}\n` +
    (errorMessage ? `⚠️ Error: ${errorMessage}\n` : "") +
    `\n${summaryLines}`;

  await sendTelegram(telegramMsg);

  return new Response(JSON.stringify({
    status,
    records_processed: totalRecords,
    created: createdCount,
    updated: updatedCount,
    changes_recalculated: recalculated,
    duration_seconds: durationSeconds,
    market_summaries: marketSummaries,
    neon_backup: {
      status: neonBackupStatus,
      count: neonBackupCount,
      error: neonBackupError || undefined,
    },
    error: errorMessage || undefined,
  }), {
    headers: { "Content-Type": "application/json" },
  });
});