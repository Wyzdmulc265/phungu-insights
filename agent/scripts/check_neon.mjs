import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('/app/.agents/.env', 'utf8');
const m = env.match(/^export DATABASE_URL=\$'([^']+)'/m);
const sql = neon(m[1]);
const r = await sql`SELECT trade_date, close_price, previous_close, change_percent FROM mse_stock_prices WHERE symbol='PCL' AND market_type='mainboard' ORDER BY trade_date DESC LIMIT 6`;
console.log(r);
const bad = await sql`SELECT count(*)::int AS n FROM mse_stock_prices WHERE symbol='PCL' AND market_type='mainboard' AND trade_date < '2026-09-07' AND close_price > 1000`;
console.log('unadjusted rows remaining:', bad[0].n);
