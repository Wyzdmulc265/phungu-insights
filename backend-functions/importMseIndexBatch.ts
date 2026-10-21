import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Official MSE Index Series Import (MASI / DSI / FSI) ──
// Accepts { days: [{ trade_date, masi, domestic_index, foreign_index }] }
// Upserts into the MseIndexDaily entity (one snapshot, keyed by trade_date)
// and mirrors to the Neon mse_index_daily table (created if missing, with
// SELECT granted to the mse_site_read role the portal uses).

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const startTime = Date.now();

  let days: any[] = [];
  try {
    const body = await req.json();
    days = body.days || [];
  } catch {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with 'days' array"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  if (!Array.isArray(days) || days.length === 0) {
    return new Response(JSON.stringify({
      error: "'days' must be a non-empty array of {trade_date, masi, ...}"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const sql = (() => {
    const databaseUrl = Deno.env.get("DATABASE_URL");
    return databaseUrl ? neon(databaseUrl) : null;
  })();

  // Entity snapshot (small entity — one list is fine)
  const existing: any[] = await base44.asServiceRole.entities.MseIndexDaily.list();
  const index = new Map<string, any>();
  for (const r of existing) index.set(r.trade_date, r);

  let created = 0;
  let updated = 0;
  let neonStatus = "skipped";
  let neonCount = 0;

  try {
    for (const day of days) {
      const d = day.trade_date;
      if (!d || day.masi == null) continue;
      const clean = {
        trade_date: d,
        masi: day.masi,
        domestic_index: day.domestic_index == null ? null : day.domestic_index,
        foreign_index: day.foreign_index == null ? null : day.foreign_index,
      };
      const match = index.get(d);
      if (match) {
        await base44.asServiceRole.entities.MseIndexDaily.update(match.id, clean);
        updated++;
      } else {
        const rec = await base44.asServiceRole.entities.MseIndexDaily.create(clean);
        index.set(d, rec);
        created++;
      }
    }

    if (sql) {
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS mse_index_daily (
            trade_date DATE PRIMARY KEY,
            masi NUMERIC NOT NULL,
            domestic_index NUMERIC,
            foreign_index NUMERIC
          )`;
        try {
          await sql`GRANT SELECT ON mse_index_daily TO mse_site_read`;
        } catch {
          // Role may already have grants; non-fatal.
        }
        for (const day of days) {
          const d = day.trade_date;
          if (!d || day.masi == null) continue;
          await sql`
            INSERT INTO mse_index_daily (trade_date, masi, domestic_index, foreign_index)
            VALUES (${d}, ${day.masi}, ${day.domestic_index == null ? null : day.domestic_index}, ${day.foreign_index == null ? null : day.foreign_index})
            ON CONFLICT (trade_date) DO UPDATE SET
              masi = EXCLUDED.masi,
              domestic_index = EXCLUDED.domestic_index,
              foreign_index = EXCLUDED.foreign_index`;
          neonCount++;
        }
        neonStatus = "success";
      } catch (e) {
        neonStatus = "failed: " + e.message;
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Index import failed: " + err.message,
      created,
      updated,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    success: true,
    days_processed: days.length,
    created,
    updated,
    neon: { status: neonStatus, count: neonCount },
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
