import { neon } from "npm:@neondatabase/serverless@0.10.0";

Deno.serve(async (req) => {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    return new Response(JSON.stringify({
      error: "DATABASE_URL not configured. Set it in agent secrets."
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  try {
    const sql = neon(databaseUrl);

    // Create the mse_stock_prices table
    await sql`
      CREATE TABLE IF NOT EXISTS mse_stock_prices (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(50) NOT NULL,
        market_type VARCHAR(20) NOT NULL,
        trade_date DATE NOT NULL,
        open_price NUMERIC(20, 2),
        close_price NUMERIC(20, 2),
        change_percent NUMERIC(10, 4),
        volume BIGINT,
        turnover NUMERIC(20, 2),
        interest NUMERIC(10, 4),
        etl_run_date TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(symbol, market_type, trade_date)
      )
    `;

    // Create the etl_log table
    await sql`
      CREATE TABLE IF NOT EXISTS mse_etl_log (
        id SERIAL PRIMARY KEY,
        run_date TIMESTAMPTZ DEFAULT NOW(),
        status VARCHAR(20) NOT NULL,
        records_processed INTEGER DEFAULT 0,
        duration_seconds NUMERIC(10, 2),
        error_message TEXT,
        trigger VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Create indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_mse_symbol ON mse_stock_prices(symbol)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_mse_trade_date ON mse_stock_prices(trade_date)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_mse_market_type ON mse_stock_prices(market_type)`;

    // Test with a simple query
    const testResult = await sql`SELECT COUNT(*) as count FROM mse_stock_prices`;

    return new Response(JSON.stringify({
      success: true,
      message: "Neon database initialized successfully",
      tables_created: ["mse_stock_prices", "mse_etl_log"],
      indexes_created: ["idx_mse_symbol", "idx_mse_trade_date", "idx_mse_market_type"],
      current_record_count: testResult[0].count,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Neon connection failed: " + err.message,
      hint: "Check that DATABASE_URL is a valid Neon connection string"
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});