import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.10.0";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const databaseUrl = Deno.env.get("DATABASE_URL");

  if (!databaseUrl) {
    return new Response(JSON.stringify({
      error: "DATABASE_URL not configured. Set it in agent secrets."
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let tradeDate = "";
  try {
    const body = await req.json();
    tradeDate = body.trade_date || "";
  } catch {
    return new Response(JSON.stringify({
      error: "Request body must be JSON with 'trade_date'"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  if (!tradeDate) {
    return new Response(JSON.stringify({
      error: "trade_date is required. Example: {\"trade_date\": \"2026-01-29\"}"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const startTime = Date.now();

  try {
    const sql = neon(databaseUrl);

    // Fetch all records, filter to the target date in JS (SDK params unreliable)
    const allRecords = await base44.asServiceRole.entities.MseStockPrice.list();
    const dayRecords = allRecords.filter((r: any) => r.trade_date === tradeDate);
    console.log(`Found ${dayRecords.length} records for ${tradeDate}`);

    if (dayRecords.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        trade_date: tradeDate,
        synced: 0,
        message: "No records found for this trade date"
      }), { headers: { "Content-Type": "application/json" } });
    }

    let synced = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const rec of dayRecords) {
      try {
        await sql`
          INSERT INTO mse_stock_prices (symbol, market_type, trade_date, open_price, close_price, change_percent, volume, turnover, interest, etl_run_date)
          VALUES (${rec.symbol}, ${rec.market_type}, ${rec.trade_date}, ${rec.open_price || 0}, ${rec.close_price || 0}, ${rec.change_percent || 0}, ${rec.volume || 0}, ${rec.turnover || 0}, ${rec.interest || 0}, ${rec.updated_date || new Date().toISOString()})
          ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
            open_price = EXCLUDED.open_price,
            close_price = EXCLUDED.close_price,
            change_percent = EXCLUDED.change_percent,
            volume = EXCLUDED.volume,
            turnover = EXCLUDED.turnover,
            interest = EXCLUDED.interest,
            etl_run_date = EXCLUDED.etl_run_date
        `;
        synced++;
      } catch (err) {
        errors++;
        if (errorDetails.length < 5) {
          errorDetails.push(`${rec.symbol}/${rec.market_type}: ${err.message}`);
        }
      }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    return new Response(JSON.stringify({
      success: errors === 0,
      trade_date: tradeDate,
      synced,
      errors,
      error_details: errorDetails,
      duration_seconds: durationSeconds
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Sync failed: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});