import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// ─── Duplicate Scraper Record Cleanup ──────────────────────
// Accepts { trade_dates: ["YYYY-MM-DD", ...] }
// For each trade_date: group records by symbol|market_type,
// KEEP the record with the latest updated_date (the final
// 15:30 scrape), DELETE the older intraday snapshots.
// Neon is already deduped via ON CONFLICT upserts — no Neon action needed.

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  let tradeDates: string[] = [];
  try {
    const body = await req.json();
    tradeDates = body.trade_dates || [];
  } catch {
    // fall through to error below
  }

  if (!Array.isArray(tradeDates) || tradeDates.length === 0) {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with a non-empty 'trade_dates' array"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // ONE full snapshot — no repeated list() calls
  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();

  const results: any[] = [];

  for (const td of tradeDates) {
    const rows = all.filter((r) => r.trade_date === td);
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.symbol}|${r.market_type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    let deleted = 0;
    let kept = 0;
    const errors: string[] = [];

    for (const [key, g] of groups) {
      // latest updated_date = the final scrape of the day → keep it
      g.sort((a, b) => new Date(a.updated_date).getTime() - new Date(b.updated_date).getTime());
      kept++;
      const toDelete = g.slice(0, -1);

      // small parallel batches to stay under write rate limits
      for (let i = 0; i < toDelete.length; i += 5) {
        const chunk = toDelete.slice(i, i + 5);
        const outcomes = await Promise.allSettled(
          chunk.map((r) => base44.asServiceRole.entities.MseStockPrice.delete(r.id))
        );
        for (const o of outcomes) {
          if (o.status === "fulfilled") {
            deleted++;
          } else {
            errors.push(String(o.reason).slice(0, 100));
          }
        }
      }
    }

    results.push({
      trade_date: td,
      unique_keys: kept,
      deleted,
      errors: errors.slice(0, 5),
    });
  }

  return new Response(JSON.stringify({
    success: true,
    results,
  }), { headers: { "Content-Type": "application/json" } });
});
