// ─── setMsePbv: write Price/Book values onto existing MseStockPrice records ───
// Accepts { rows: [{ symbol, trade_date, pbv }] }
// Updates ONLY the pbv field on the matching mainboard record (symbol + trade_date).
// Idempotent: safe to re-run. Does not create records or touch any other field.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

interface PbvRow {
  symbol: string;
  trade_date: string;
  pbv: number;
}

export default async function (req: Request): Promise<Response> {
  const client = createClientFromRequest(req);
  const base44 = client;

  let rows: PbvRow[] = [];
  try {
    const body = await req.json();
    rows = body.rows || [];
  } catch {
    return new Response(JSON.stringify({ success: false, error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response(
      JSON.stringify({ success: false, error: "'rows' must be a non-empty array of {symbol, trade_date, pbv}" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Read the full dataset once (per project convention: manual filtering in JS)
  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();
  const byKey = new Map<string, string>();
  for (const r of all) {
    if (r.market_type === "mainboard") {
      byKey.set(`${r.symbol}|${r.trade_date}`, r.id);
    }
  }

  let updated = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.symbol || !row.trade_date || row.pbv == null) {
      skipped.push(`${row.symbol || "?"}@${row.trade_date || "?"} (incomplete)`);
      continue;
    }
    const id = byKey.get(`${row.symbol}|${row.trade_date}`);
    if (!id) {
      skipped.push(`${row.symbol}@${row.trade_date} (no record)`);
      continue;
    }
    try {
      await base44.asServiceRole.entities.MseStockPrice.update(id, { pbv: row.pbv });
      updated++;
    } catch (e) {
      errors.push(`${row.symbol}@${row.trade_date}: ${e.message}`);
    }
  }

  return new Response(
    JSON.stringify({
      success: errors.length === 0,
      updated,
      skipped,
      errors,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
