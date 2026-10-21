import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('/app/.agents/.env', 'utf8');
const m = env.match(/^export DATABASE_URL=\$'([^']+)'/m);
const sql = neon(m[1]);

const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='mse_stock_prices' AND column_name='pbv'`;
if (cols.length === 0) await sql`ALTER TABLE mse_stock_prices ADD COLUMN pbv NUMERIC(10,2)`;

const days = JSON.parse(fs.readFileSync('/tmp/pbv/pbv_days.json', 'utf8'));
let set = 0, missing = [];
for (const [d, rows] of Object.entries(days)) {
  for (const [sym, r] of Object.entries(rows)) {
    if (r.pbv == null) continue;
    const res = await sql`UPDATE mse_stock_prices SET pbv = ${r.pbv} WHERE symbol = ${sym} AND trade_date = ${d} AND market_type = 'mainboard'`;
    set += res.count;
    if (res.count === 0) missing.push(`${sym}@${d}`);
  }
}
console.log('pbv values set:', set);
console.log('rows not found:', missing.length ? missing : 'none');

const chk = await sql`SELECT symbol, trade_date, pbv FROM mse_stock_prices WHERE pbv IS NOT NULL ORDER BY trade_date DESC, symbol LIMIT 20`;
console.log(chk.map(r => `${r.symbol}@${r.trade_date.slice(0,10)}=${r.pbv}`).join('\n'));
