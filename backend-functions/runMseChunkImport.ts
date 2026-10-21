import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Durable 2025 Backfill Driver ──────────────────────────
// Reads pending chunks from MseImportChunk (status="pending",
// sorted by seq), imports up to `take` chunks per call into
// MseStockPrice (idempotent upsert, same key logic as
// importMseBatch) with Neon backup per day, marks each chunk
// status="done" only after success. Never throws — always
// returns a JSON summary so workflow steps can't hard-fail.

async function backupDayToNeon(sql: any, records: any[], tradeDate: string): Promise<number> {
  let inserted = 0;
  for (const rec of records) {
    await sql`
      INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, raw_close, change_percent, volume, turnover, interest, previous_close, market_capitalization, pe_ratio, dividend_yield_percent, etl_run_date)
      VALUES (${rec.symbol}, ${rec.market_type}, ${tradeDate}, ${rec.open_price || 0}, ${rec.close_price}, ${rec.raw_close == null ? null : rec.raw_close}, ${rec.change_percent || 0}, ${rec.volume || 0}, ${rec.turnover || 0}, ${rec.interest || 0}, ${rec.previous_close || 0}, ${rec.market_capitalization || 0}, ${rec.pe_ratio || 0}, ${rec.dividend_yield_percent || 0}, NOW())
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
        etl_run_date = NOW()
    `;
    inserted++;
  }
  return inserted;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const startTime = Date.now();
  let take = 3;
  let gapMs = 45000;

  try {
    const body = await req.json();
    if (body.take) take = Math.min(Number(body.take) || 3, 5);
    if (body.gap_seconds) gapMs = (Number(body.gap_seconds) || 45) * 1000;
  } catch {
    // empty body is fine — use defaults
  }

  const summary: any = { processed: 0, chunks: [], remaining_pending: 0, errors: [] };

  try {
    // one snapshot of the chunk queue
    const allChunks: any[] = await base44.asServiceRole.entities.MseImportChunk.list();
    const pending = allChunks
      .filter((c) => c.status === "pending" && c.chunk_id && !String(c.chunk_id).includes("probe"))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    summary.remaining_pending = pending.length;
    const batch = pending.slice(0, take);
    if (batch.length === 0) {
      summary.done_all = pending.length === 0;
      summary.duration_seconds = Math.round((Date.now() - startTime) / 1000);
      return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
    }

    // one snapshot of existing prices for upsert matching
    const existing: any[] = await base44.asServiceRole.entities.MseStockPrice.list();
    const index = new Map<string, any>();
    for (const r of existing) {
      index.set(`${r.symbol}|${r.market_type}|${r.trade_date}`, r);
    }

    const sql = (() => {
      const databaseUrl = Deno.env.get("DATABASE_URL");
      return databaseUrl ? neon(databaseUrl) : null;
    })();

    for (let ci = 0; ci < batch.length; ci++) {
      const chunk = batch[ci];
      try {
        const payload = JSON.parse(chunk.payload);
        const days = payload.days || [];
        let created = 0;
        let updated = 0;
        let neonFailed = 0;
        const daySummary: any[] = [];

        for (const day of days) {
          const tradeDate = day.trade_date;
          const records = (day.records || []).filter((r: any) => r.symbol && r.market_type && r.close_price);
          for (const rec of records) {
            const key = `${rec.symbol}|${rec.market_type}|${tradeDate}`;
            const clean = {
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
              data_source: payload.source || "excel_import",
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
          if (sql && records.length > 0) {
            try {
              await backupDayToNeon(sql, records, tradeDate);
            } catch (e) {
              neonFailed++;
              summary.errors.push(`neon ${chunk.chunk_id} ${tradeDate}: ${e.message}`);
            }
          }
          daySummary.push({ trade_date: tradeDate, records: records.length });
        }

        // mark done only after the chunk fully imported
        await base44.asServiceRole.entities.MseImportChunk.update(chunk.id, {
          chunk_id: chunk.chunk_id,
          group: chunk.group,
          seq: chunk.seq,
          status: "done",
          payload: chunk.payload,
        });
        summary.processed++;
        summary.chunks.push({
          chunk_id: chunk.chunk_id,
          days: daySummary.length,
          records: daySummary.reduce((s: number, d: any) => s + d.records, 0),
          created,
          updated,
          neon_failed_days: neonFailed,
        });
      } catch (e) {
        summary.errors.push(`${chunk.chunk_id}: ${e.message}`);
        try {
          await base44.asServiceRole.entities.MseImportChunk.update(chunk.id, {
            chunk_id: chunk.chunk_id,
            group: chunk.group,
            seq: chunk.seq,
            status: "failed",
            payload: chunk.payload,
          });
        } catch { /* keep going */ }
      }
      if (ci < batch.length - 1) await sleep(gapMs);
    }

    // recount remaining
    const after: any[] = await base44.asServiceRole.entities.MseImportChunk.list();
    summary.remaining_pending = after.filter((c) => c.status === "pending").length;
    summary.remaining_failed = after.filter((c) => c.status === "failed").length;
  } catch (e) {
    summary.fatal = e.message;
  }

  summary.duration_seconds = Math.round((Date.now() - startTime) / 1000);
  return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
});
