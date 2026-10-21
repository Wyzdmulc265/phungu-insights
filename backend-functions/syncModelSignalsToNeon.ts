import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

// ─── Sync Model Signals + AI Sentiment to Neon ──────────────
// No args needed. Reads ALL MseModelSignal rows (whole track record)
// and ALL MseSentiment rows, merges sentiment by run_date|symbol,
// and upserts into the Neon mse_model_signals table that the public
// portal (Cloudflare Worker) reads for its Outlook page — zero
// Base44 read traffic from the site.
// Idempotent: ON CONFLICT (run_date, symbol) upsert.

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const signals: any[] = await base44.asServiceRole.entities.MseModelSignal.list();
  const sentiments: any[] = await base44.asServiceRole.entities.MseSentiment.list();

  const sentMap = new Map<string, any>();
  for (const s of sentiments) {
    const key = `${(s.run_date || "").slice(0, 10)}|${s.symbol}`;
    sentMap.set(key, s);
  }

  let synced = 0;
  const errors: string[] = [];

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    return new Response(JSON.stringify({ success: false, error: "DATABASE_URL missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const sql = neon(databaseUrl);

  // small batches to stay under Neon statement flow
  for (let i = 0; i < signals.length; i += 20) {
    const chunk = signals.slice(i, i + 20);
    const outcomes = await Promise.allSettled(
      chunk.map((r) => {
        const rd = (r.run_date || "").slice(0, 10);
        const s = sentMap.get(`${rd}|${r.symbol}`);
        return sql`
          INSERT INTO mse_model_signals
            (run_date, symbol, signal, tech_score, value_score, return_1m, return_3m,
             ytd_return, volatility, vs_ma20, max_drawdown, pe_ratio, dividend_yield,
             sentiment_score, sentiment_note)
          VALUES (${rd}, ${r.symbol}, ${r.signal ?? null}, ${r.tech_score ?? null},
                  ${r.value_score ?? null}, ${r.return_1m ?? null}, ${r.return_3m ?? null},
                  ${r.ytd_return ?? null}, ${r.volatility ?? null}, ${r.vs_ma20 ?? null},
                  ${r.max_drawdown ?? null}, ${r.pe_ratio ?? null}, ${r.dividend_yield ?? null},
                  ${s?.score ?? null}, ${s?.note ?? null})
          ON CONFLICT (run_date, symbol) DO UPDATE SET
            signal = EXCLUDED.signal,
            tech_score = EXCLUDED.tech_score,
            value_score = EXCLUDED.value_score,
            return_1m = EXCLUDED.return_1m,
            return_3m = EXCLUDED.return_3m,
            ytd_return = EXCLUDED.ytd_return,
            volatility = EXCLUDED.volatility,
            vs_ma20 = EXCLUDED.vs_ma20,
            max_drawdown = EXCLUDED.max_drawdown,
            pe_ratio = EXCLUDED.pe_ratio,
            dividend_yield = EXCLUDED.dividend_yield,
            sentiment_score = EXCLUDED.sentiment_score,
            sentiment_note = EXCLUDED.sentiment_note`;
      })
    );
    for (const o of outcomes) {
      if (o.status === "fulfilled") synced++;
      else errors.push(String(o.reason).slice(0, 100));
    }
  }

  return new Response(JSON.stringify({
    success: errors.length === 0,
    signal_rows: signals.length,
    sentiment_rows: sentiments.length,
    neon_synced: synced,
    errors: errors.slice(0, 5),
  }), { headers: { "Content-Type": "application/json" } });
});
