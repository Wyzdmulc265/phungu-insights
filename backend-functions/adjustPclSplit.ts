import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── PCL 1:35 Share Split Adjustment (2026-09-07) ───────────
// Press Corporation traded at its split-adjusted price from Sep 7, 2026
// (last pre-split close 9,520 → 9,520/35 = 272.00 reference).
// This adjusts ALL historical PCL rows for price continuity:
//   close_price / 35, previous_close / 35, open_price / 35 (rounded 2dp)
//   market_capitalization, pe_ratio, dividend_yield_percent: UNCHANGED (invariants)
//   volume / turnover: UNCHANGED (actual traded history)
// Today's row (2026-09-07): previous_close = 272.00, change% recomputed.
// Idempotent: history rows with close_price < 1000 are skipped; the
// Neon UPDATE carries the same >1000 guard. Accepts { start, end } date
// range so Base44 writes can be chunked to stay under rate limits.

const SPLIT_DATE = "2026-09-07";
const SPLIT_RATIO = 35;
const REF_PREV = 272.0; // 9520 / 35

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  let start = "", end = "";
  try {
    const body = await req.json();
    start = body.start || "";
    end = body.end || "";
  } catch { /* defaults */ }

  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();
  const rows = all.filter((r) =>
    r.symbol === "PCL" &&
    r.market_type === "mainboard" &&
    (!start || r.trade_date >= start) &&
    (!end || r.trade_date <= end)
  );

  let updated = 0, skipped = 0, alreadyAdjusted = 0;
  const errors: string[] = [];

  // small parallel batches to stay under write rate limits
  const targets = rows.filter((r) => {
    if (r.trade_date < SPLIT_DATE) {
      return (r.close_price ?? 0) > 1000; // idempotency guard
    }
    return r.trade_date === SPLIT_DATE;
  });

  for (let i = 0; i < targets.length; i += 5) {
    const chunk = targets.slice(i, i + 5);
    const outcomes = await Promise.allSettled(
      chunk.map((r) => {
        if (r.trade_date < SPLIT_DATE) {
          const patch: any = { close_price: round2(r.close_price / SPLIT_RATIO) };
          if ((r.previous_close ?? 0) > 1000) patch.previous_close = round2(r.previous_close / SPLIT_RATIO);
          if ((r.open_price ?? 0) > 1000) patch.open_price = round2(r.open_price / SPLIT_RATIO);
          return base44.asServiceRole.entities.MseStockPrice.update(r.id, patch);
        }
        // today's row: fix previous_close + change% against the split reference
        const close = r.close_price ?? 0;
        const chg = close > 0 ? round2((close / REF_PREV - 1) * 100) : 0;
        return base44.asServiceRole.entities.MseStockPrice.update(r.id, {
          previous_close: REF_PREV,
          change_percent: chg,
        });
      })
    );
    for (const o of outcomes) {
      if (o.status === "fulfilled") updated++;
      else errors.push(String(o.reason).slice(0, 100));
    }
  }

  for (const r of rows) {
    if (r.trade_date < SPLIT_DATE && (r.close_price ?? 0) <= 1000) alreadyAdjusted++;
  }

  // Neon: one idempotent pass per call (guard: close_price > 1000)
  let neonUpdated = 0;
  try {
    const databaseUrl = Deno.env.get("DATABASE_URL");
    if (databaseUrl) {
      const sql = neon(databaseUrl);
      const hist = await sql`
        UPDATE mse_stock_prices
        SET close_price = ROUND(close_price / ${SPLIT_RATIO}::numeric, 2),
            previous_close = CASE WHEN previous_close > 1000 THEN ROUND(previous_close / ${SPLIT_RATIO}::numeric, 2) ELSE previous_close END,
            open_price = CASE WHEN open_price > 1000 THEN ROUND(open_price / ${SPLIT_RATIO}::numeric, 2) ELSE open_price END
        WHERE symbol = 'PCL' AND market_type = 'mainboard'
          AND trade_date < ${SPLIT_DATE + "T00:00:00Z"} AND close_price > 1000`;
      neonUpdated = hist.count;
      const today = await sql`
        UPDATE mse_stock_prices
        SET previous_close = ${REF_PREV},
            change_percent = ROUND(((close_price - ${REF_PREV}) / ${REF_PREV}) * 100, 2)
        WHERE symbol = 'PCL' AND market_type = 'mainboard' AND trade_date = ${SPLIT_DATE + "T00:00:00Z"}`;
      neonUpdated += today.count;
    }
  } catch (e) {
    errors.push("neon: " + String(e).slice(0, 120));
  }

  return new Response(JSON.stringify({
    success: errors.length === 0,
    range: { start: start || "beginning", end: end || "latest" },
    pcl_rows_in_range: rows.length,
    base44_updated: updated,
    already_adjusted_skipped: alreadyAdjusted,
    neon_updated: neonUpdated,
    errors: errors.slice(0, 5),
  }), { headers: { "Content-Type": "application/json" } });
});
