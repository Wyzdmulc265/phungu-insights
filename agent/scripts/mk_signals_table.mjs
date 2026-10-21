import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('/app/.agents/.env', 'utf8');
const m = env.match(/^export DATABASE_URL=\$'([^']+)'/m);
const sql = neon(m[1]);
await sql`
  CREATE TABLE IF NOT EXISTS mse_model_signals (
    id SERIAL PRIMARY KEY,
    run_date DATE NOT NULL,
    symbol VARCHAR(50) NOT NULL,
    signal VARCHAR(30),
    tech_score DOUBLE PRECISION,
    value_score DOUBLE PRECISION,
    return_1m DOUBLE PRECISION,
    return_3m DOUBLE PRECISION,
    ytd_return DOUBLE PRECISION,
    volatility DOUBLE PRECISION,
    vs_ma20 DOUBLE PRECISION,
    max_drawdown DOUBLE PRECISION,
    pe_ratio DOUBLE PRECISION,
    dividend_yield DOUBLE PRECISION,
    sentiment_score DOUBLE PRECISION,
    sentiment_note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(run_date, symbol)
  )`;
await sql`CREATE INDEX IF NOT EXISTS idx_signals_date ON mse_model_signals(run_date)`;
console.log('table created');
