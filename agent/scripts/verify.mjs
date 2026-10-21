import { neon } from '@neondatabase/serverless';
const cs = process.env.DATABASE_URL;
const sql = neon(cs);
try {
  const c = await sql`SELECT count(*)::int AS n FROM mse_stock_prices`;
  console.log('READ OK — rows in mse_stock_prices:', c[0].n);
  const s = await sql`SELECT DISTINCT symbol FROM mse_stock_prices ORDER BY symbol`;
  console.log('symbols:', s.length);
} catch (e) { console.log('READ FAILED:', e.message); process.exit(1); }
try {
  await sql`INSERT INTO mse_stock_prices (symbol, trade_date, close_price) VALUES ('HACK', '2026-01-01', 1)`;
  console.log('WRITE SUCCEEDED — BAD!');
} catch (e) { console.log('WRITE BLOCKED — good:', e.message.slice(0, 90)); }
try {
  await sql`DROP TABLE mse_stock_prices`;
  console.log('DROP SUCCEEDED — BAD!');
} catch (e) { console.log('DROP BLOCKED — good:', e.message.slice(0, 90)); }
