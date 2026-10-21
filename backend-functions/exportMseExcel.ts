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
  const marketType = url.searchParams.get("market_type");
  const symbol = url.searchParams.get("symbol");
  const tradeDate = url.searchParams.get("trade_date");
  const format = url.searchParams.get("format") || "csv";

  try {
    // Fetch ALL records (no params — SDK params unreliable; filter/sort in JS).
    // No limit here: a 500-record cap was cutting off older records.
    const allRecords = await base44.asServiceRole.entities.MseStockPrice.list();

    let filtered = allRecords;
    if (marketType) filtered = filtered.filter((r: any) => r.market_type === marketType);
    if (symbol) filtered = filtered.filter((r: any) => r.symbol === symbol);
    if (tradeDate) filtered = filtered.filter((r: any) => r.trade_date === tradeDate);

    // Sort by trade_date descending, then symbol (consistent output order)
    filtered.sort((a: any, b: any) => {
      if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? 1 : -1;
      return a.symbol.localeCompare(b.symbol);
    });

    if (filtered.length === 0) {
      return new Response(JSON.stringify({
        error: "No data found for the given filters"
      }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    if (format === "json") {
      return new Response(JSON.stringify({
        count: filtered.length,
        data: filtered,
      }), { headers: { "Content-Type": "application/json" } });
    }

    const headers = [
      "symbol", "market_type", "trade_date", "open_price", "close_price",
      "change_percent", "volume", "turnover", "interest"
    ];

    let csv = headers.join(",") + "\n";
    for (const rec of filtered) {
      const row = headers.map(h => {
        const val = (rec as any)[h] ?? "";
        return typeof val === "string" && val.includes(",") ? `"${val}"` : val;
      });
      csv += row.join(",") + "\n";
    }

    const filename = `mse_stock_data_${new Date().toISOString().split("T")[0]}.csv`;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Failed to export data: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});