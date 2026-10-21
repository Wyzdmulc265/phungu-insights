import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('/app/.agents/.env', 'utf8');
const m = env.match(/^export DATABASE_URL=\$'([^']+)'/m);
const sql = neon(m[1]);
try {
  await sql`GRANT SELECT ON mse_model_signals TO mse_site_read`;
  console.log('granted');
} catch (e) {
  console.log('grant result:', String(e).slice(0, 200));
}
