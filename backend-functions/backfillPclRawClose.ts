import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// ─── Backfill raw_close for pre-split PCL rows (Base44 side) ──────
// Restores the as-traded close (adjusted close × 35) for PCL records
// dated before the 1:35 split (2026-09-07), so the stock page can show
// both truths: split-adjusted series for the models, as-traded for
// display. Idempotent: skips rows that already have raw_close set.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();

  const targets = all.filter(
    (r) => r.symbol === "PCL" && r.trade_date < "2026-09-07" && r.raw_close == null
  );

  let updated = 0, skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < targets.length; i += 15) {
    const chunk = targets.slice(i, i + 15);
    for (const r of chunk) {
      const raw = Math.round(r.close_price * 35 * 100) / 100;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          await base44.asServiceRole.entities.MseStockPrice.update(r.id, { raw_close: raw });
          ok = true; updated++;
        } catch (e) {
          if (attempt < 2) await sleep(1500 * (attempt + 1));
          else errors.push(`${r.trade_date}: ${String(e).slice(0, 80)}`);
        }
      }
    }
    await sleep(400);
  }
  skipped = all.filter((r) => r.symbol === "PCL" && r.trade_date < "2026-09-07" && r.raw_close != null).length;

  return new Response(JSON.stringify({
    success: errors.length === 0,
    pcl_pre_split_rows: targets.length + skipped,
    updated_this_run: updated,
    already_set: skipped,
    errors: errors.slice(0, 5),
  }), { headers: { "Content-Type": "application/json" } });
});
