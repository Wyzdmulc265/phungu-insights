import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: "Missing API key. Provide it in the 'x-api-key' header."
    }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  try {
    // List all keys and filter in JS (SDK filter param not reliable)
    const allKeys = await base44.asServiceRole.entities.MseApiKey.list();
    const keyRecord = allKeys.find((k: any) => k.api_key === apiKey && k.is_active === true);

    if (!keyRecord) {
      return new Response(JSON.stringify({
        error: "Invalid or inactive API key"
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    // Update usage stats
    await base44.asServiceRole.entities.MseApiKey.update(keyRecord.id, {
      last_used: new Date().toISOString(),
      requests_count: (keyRecord.requests_count || 0) + 1,
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Authentication error: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const marketType = url.searchParams.get("market_type");
  const symbol = url.searchParams.get("symbol");
  const limit = parseInt(url.searchParams.get("limit") || "100");

  try {
    // Fetch ALL records (no params — SDK params unreliable; filter/sort in JS).
    // No limit here: the DB has 1000+ records and a limit cap caused
    // fresh scraped data to be invisible to the API.
    const allRecords = await base44.asServiceRole.entities.MseStockPrice.list();

    let filtered = allRecords;
    if (marketType) filtered = filtered.filter((r: any) => r.market_type === marketType);
    if (symbol) filtered = filtered.filter((r: any) => r.symbol === symbol);

    // Group by symbol+market_type and keep the record with the LATEST
    // trade_date (tie-break on updated_date). NOT created_date — upserts
    // keep the original created_date, so fresh data on updated records
    // would look "old" if we sorted by created_date.
    const latestBySymbol: Record<string, any> = {};
    for (const rec of filtered) {
      const key = `${rec.symbol}_${rec.market_type}`;
      const current = latestBySymbol[key];
      if (
        !current ||
        rec.trade_date > current.trade_date ||
        (rec.trade_date === current.trade_date &&
          (rec.updated_date || "") > (current.updated_date || ""))
      ) {
        latestBySymbol[key] = rec;
      }
    }

    const results = Object.values(latestBySymbol)
      .sort((a: any, b: any) => a.symbol.localeCompare(b.symbol))
      .slice(0, limit);

    return new Response(JSON.stringify({
      count: results.length,
      trade_date: results.length > 0 ? results[0].trade_date : null,
      data: results,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Failed to fetch stock data: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});