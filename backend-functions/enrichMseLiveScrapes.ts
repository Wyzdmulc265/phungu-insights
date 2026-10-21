import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Live-Scrape Record Enrichment ─────────────────────────
// Accepts { trade_dates: ["YYYY-MM-DD", ...] }
// For mainboard live_scrape records on the given dates, derives:
//   previous_close  → prior trading day's close from our own DB chain
//   change_percent  → recomputed from that prev_close
//   market_capitalization → shares_in_issue x close / 1e6
//   pe_ratio        → close / EPS (EPS = latest published after-tax profit / shares)
// dividend_yield_percent is intentionally NOT set — dividends change at AGMs
// and will come from the official monthly Excel.
// Updates Base44, then mirrors the day to Neon (ON CONFLICT upsert).

// Shares in issue (authoritative: July 2026 Excel, Jul 31 rows; CHL = IPO prospectus/Mansa)
const SHARES: Record<string, number> = {
  AIRTEL: 11000000000,
  BHL: 5878254935,
  CHL: 3013234416,
  FDHB: 6901031250,
  FMBCH: 2458250000,
  ICON: 6680000000,
  ILLOVO: 713444391,
  MPICO: 2298047460,
  NBM: 466931738,
  NBS: 2910573356,
  NICO: 1043041096,
  NITL: 135000000,
  OMU: 30938694,
  PCL: 4208953700, // 1:35 split Sep 7 2026 (was 120,255,820)
  STANDARD: 1173340810,
  SUNBIRD: 261582580,
  TNM: 11541200375,
};

// Latest published after-tax profit, MK millions (July 2026 Excel, Jul 31 rows)
const ATP_MILLIONS: Record<string, number> = {
  AIRTEL: 51248.01,
  BHL: 5504.35,
  FDHB: 147789.14,
  FMBCH: 195680.05,
  ICON: 32644.45,
  ILLOVO: 77215,
  MPICO: 13580.42,
  NBM: 202867,
  NBS: 150422,
  NICO: 167833,
  NITL: 202128.18,
  OMU: 5370.37,
  PCL: 145209,
  STANDARD: 121698,
  SUNBIRD: 12478.76,
  TNM: 21270,
  CHL: 40274.00,
};

// Special case: CHL first trading day reference price = IPO price
const FIRST_DAY_PREV: Record<string, number> = { "2026-08-10|CHL": 195.0 };

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  let tradeDates: string[] = [];
  try {
    const body = await req.json();
    tradeDates = body.trade_dates || [];
  } catch {
    // fall through
  }

  if (!Array.isArray(tradeDates) || tradeDates.length === 0) {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with a non-empty 'trade_dates' array",
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // ONE full snapshot — no repeated list() calls
  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();

  // per-symbol mainboard close history, sorted by date
  const history = new Map<string, { date: string; close: number }[]>();
  for (const r of all) {
    if (r.market_type !== "mainboard") continue;
    if (!history.has(r.symbol)) history.set(r.symbol, []);
    history.get(r.symbol)!.push({ date: r.trade_date, close: r.close_price });
  }
  for (const [sym, arr] of history) {
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const sql = (() => {
    const databaseUrl = Deno.env.get("DATABASE_URL");
    return databaseUrl ? neon(databaseUrl) : null;
  })();

  const results: any[] = [];

  for (const td of tradeDates) {
    // mainboard live-scrape rows (incl. old ETL rows with null data_source)
    // that are still missing derived fields — keeps re-runs cheap and idempotent
    const targets = all.filter(
      (r) =>
        r.trade_date === td &&
        r.market_type === "mainboard" &&
        (r.data_source === "live_scrape" || r.data_source == null) &&
        (!r.market_capitalization || !r.previous_close)
    );

    let updated = 0;
    let skipped = 0;
    const neonRows: any[] = [];
    const errors: string[] = [];

    for (const rec of targets) {
      const shares = SHARES[rec.symbol];
      const hist = history.get(rec.symbol) || [];
      let prevIdx = -1;
      for (let i = 0; i < hist.length; i++) {
        if (hist[i].date < td) prevIdx = i;
        else break;
      }
      const prev = prevIdx >= 0 ? hist[prevIdx].close : FIRST_DAY_PREV[`${td}|${rec.symbol}`];
      const close = rec.close_price;

      if (!shares || prev === undefined || !close) {
        skipped++;
        continue;
      }

      const prevClose = round2(prev);
      const change = round2(((close - prevClose) / prevClose) * 100);
      const mktcap = round2((shares * close) / 1e6);
      const atp = ATP_MILLIONS[rec.symbol];
      const eps = atp ? (atp * 1e6) / shares : 0;
      const pe = eps > 0 ? round2(close / eps) : rec.pe_ratio;

      const patch: any = {
        previous_close: prevClose,
        change_percent: change,
        market_capitalization: mktcap,
      };
      if (pe !== null && pe !== undefined) patch.pe_ratio = pe;

      try {
        await base44.asServiceRole.entities.MseStockPrice.update(rec.id, patch);
        updated++;
        neonRows.push({ ...rec, ...patch });
      } catch (e) {
        errors.push(`${rec.symbol}: ${String(e).slice(0, 80)}`);
      }
    }

    // mirror the day to Neon
    let neonStatus = "skipped";
    let neonCount = 0;
    if (sql && neonRows.length > 0) {
      try {
        for (const rec of neonRows) {
          await sql`
            INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, change_percent, volume, turnover, interest, previous_close, market_capitalization, pe_ratio, dividend_yield_percent, etl_run_date)
            VALUES (${rec.symbol}, ${rec.market_type}, ${td}, ${rec.open_price || 0}, ${rec.close_price}, ${rec.change_percent || 0}, ${rec.volume || 0}, ${rec.turnover || 0}, ${rec.interest || 0}, ${rec.previous_close || 0}, ${rec.market_capitalization || 0}, ${rec.pe_ratio || 0}, ${rec.dividend_yield_percent || 0}, NOW())
            ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
              previous_close = EXCLUDED.previous_close,
              change_percent = EXCLUDED.change_percent,
              market_capitalization = EXCLUDED.market_capitalization,
              pe_ratio = EXCLUDED.pe_ratio,
              etl_run_date = NOW()
          `;
          neonCount++;
        }
        neonStatus = "success";
      } catch (e) {
        neonStatus = `error: ${String(e).slice(0, 80)}`;
      }
    }

    results.push({
      trade_date: td,
      updated,
      skipped,
      neon: { status: neonStatus, count: neonCount },
      errors: errors.slice(0, 5),
    });
  }

  return new Response(JSON.stringify({ success: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
