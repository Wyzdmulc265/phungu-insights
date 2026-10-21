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
    const allKeys = await base44.asServiceRole.entities.MseApiKey.list();
    const keyRecord = allKeys.find((k: any) => k.api_key === apiKey && k.is_active === true);

    if (!keyRecord) {
      return new Response(JSON.stringify({
        error: "Invalid or inactive API key"
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

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
  const symbol = url.searchParams.get("symbol");
  const fromDate = url.searchParams.get("from_date");
  const toDate = url.searchParams.get("to_date");
  const marketType = url.searchParams.get("market_type");
  const limit = parseInt(url.searchParams.get("limit") || "500");

  if (!symbol) {
    return new Response(JSON.stringify({
      error: "symbol is required. Example: ?symbol=AIRTEL&from_date=2026-08-01&to_date=2026-08-04"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  try {
    // Fetch ALL records (no params — SDK params unreliable; filter/sort in JS).
    // No limit here: a 500-record cap was cutting off older history.
    const allRecords = await base44.asServiceRole.entities.MseStockPrice.list();

    let filtered = allRecords.filter((r: any) => r.symbol === symbol);
    if (marketType) filtered = filtered.filter((r: any) => r.market_type === marketType);
    if (fromDate) filtered = filtered.filter((r: any) => r.trade_date >= fromDate);
    if (toDate) filtered = filtered.filter((r: any) => r.trade_date <= toDate);

    // Sort by trade_date descending (newest first) in JS
    filtered.sort((a: any, b: any) => {
      if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? 1 : -1;
      return (b.updated_date || "").localeCompare(a.updated_date || "");
    });

    filtered = filtered.slice(0, limit);

    return new Response(JSON.stringify({
      symbol,
      count: filtered.length,
      from_date: fromDate || "all",
      to_date: toDate || "all",
      data: filtered,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Failed to fetch stock history: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});