import { neon } from '@neondatabase/serverless';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300',
};

// ─── Live model computation (matches computeMseModel v0.2 logic) ───
const isoD = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
function zScores(values) {
  const defined = values.filter((v) => v != null && isFinite(v));
  if (defined.length < 2) return values.map(() => null);
  const mean = defined.reduce((a, b) => a + b, 0) / defined.length;
  const std = Math.sqrt(defined.reduce((a, b) => a + (b - mean) ** 2, 0) / defined.length) || 1e-9;
  return values.map((v) => (v == null || !isFinite(v)) ? null : (v - mean) / std);
}
const band = (score) => score == null ? 'NEUTRAL' : score >= 0.25 ? 'BULL' : score <= -0.25 ? 'BEAR' : 'NEUTRAL';

async function forecastPayload(env) {
  const sql = neon(env.NEON_DATABASE_URL);
  const rows = await sql`
    SELECT trade_date AS d, symbol AS s, close_price AS c, pe_ratio AS pe, dividend_yield_percent AS dy, pbv
    FROM mse_stock_prices
    WHERE market_type = 'mainboard'
    ORDER BY trade_date, symbol`;
  const sigs = await sql`
    SELECT run_date, symbol, signal, tech_score, value_score, sentiment_score, sentiment_note
    FROM mse_model_signals
    WHERE run_date = (SELECT MAX(run_date) FROM mse_model_signals)`;

  // series per symbol
  const series = new Map(); // sym -> [{d, c}]
  for (const r of rows) {
    const c = Number(r.c), pe = r.pe == null ? null : Number(r.pe), dy = r.dy == null ? null : Number(r.dy), pbv = r.pbv == null ? null : Number(r.pbv);
    const d = isoD(r.d);
    if (!series.has(r.s)) series.set(r.s, []);
    series.get(r.s).push({ d, c, pe, dy, pbv });
  }

  const stocks = [];
  for (const [sym, arr] of series) {
    if (arr.length < 25) continue; // need some history
    const n = arr.length;
    const last = arr[n - 1];
    const ret = (k) => n > k && arr[n - 1 - k] && arr[n - 1 - k].c > 0 ? (last.c / arr[n - 1 - k].c - 1) * 100 : null;
    const ret1m = ret(21), ret3m = ret(63);
    const firstYtd = arr.find((x) => x.d >= '2026-01-01');
    const ytd = firstYtd && firstYtd.c > 0 ? (last.c / firstYtd.c - 1) * 100 : null;
    // volatility: last 63 daily returns
    const rets = [];
    for (let i = Math.max(1, n - 63); i < n; i++) {
      if (arr[i - 1].c > 0) rets.push(arr[i].c / arr[i - 1].c - 1);
    }
    const rMean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const vol = rets.length > 10 ? Math.sqrt(rets.reduce((a, b) => a + (b - rMean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100 : null;
    const ma20 = n >= 20 ? arr.slice(-20).reduce((a, b) => a + b.c, 0) / 20 : null;
    const vsMa20 = ma20 && ma20 > 0 ? (last.c / ma20 - 1) * 100 : null;
    let peL = null, dyL = null, pbvL = null;
    for (let i = n - 1; i >= 0; i--) {
      if (peL == null && arr[i].pe != null && arr[i].pe > 0) peL = arr[i].pe;
      if (dyL == null && arr[i].dy != null && arr[i].dy > 0) dyL = arr[i].dy;
      if (pbvL == null && arr[i].pbv != null && arr[i].pbv > 0) pbvL = arr[i].pbv;
      if (peL != null && dyL != null && pbvL != null) break;
    }
    stocks.push({
      symbol: sym, close: last.c, pe: last.pe, dy: last.dy,
      ret1m, ret3m, ytd, vol, vsMa20,
      latestPe: peL ?? last.pe, latestDy: dyL ?? last.dy, latestPbv: pbvL ?? last.pbv,
    });
  }

  const z3m = zScores(stocks.map((s) => s.ret3m));
  const z1m = zScores(stocks.map((s) => s.ret1m));
  const zMa = zScores(stocks.map((s) => s.vsMa20));
  const zPe = zScores(stocks.map((s) => s.latestPe != null && s.latestPe > 0 ? -s.latestPe : null));
  const zDy = zScores(stocks.map((s) => s.latestDy != null && s.latestDy > 0 ? s.latestDy : null));
  const zPbv = zScores(stocks.map((s) => s.latestPbv != null && s.latestPbv > 0 ? -s.latestPbv : null));

  stocks.forEach((s, i) => {
    s.techScore = (z3m[i] != null || z1m[i] != null || zMa[i] != null)
      ? 0.5 * (z3m[i] ?? 0) + 0.3 * (z1m[i] ?? 0) + 0.2 * (zMa[i] ?? 0) : null;
    // value v0.3: 0.4 z(-PE) + 0.3 z(DY) + 0.3 z(-PBV), renormalized when a component is missing
    const vParts = [[0.4, zPe[i]], [0.3, zDy[i]], [0.3, zPbv[i]]].filter(([, z]) => z != null && isFinite(z));
    const vW = vParts.reduce((a, [w]) => a + w, 0);
    s.valueScore = vW > 0 ? vParts.reduce((a, [w, z]) => a + w * z, 0) / vW : null;
    s.techSignal = band(s.techScore);
    s.valueSignal = band(s.valueScore);
  });

  // merge latest Saturday model signals + AI sentiment
  const sigMap = new Map(sigs.map((g) => [g.symbol, g]));
  const sigDate = sigs.length ? isoD(sigs[0].run_date) : null;
  stocks.forEach((s, i) => {
    const g = sigMap.get(s.symbol);
    s.model = g ? {
      run_date: isoD(g.run_date),
      signal: g.signal,
      tech_score: g.tech_score == null ? null : Number(g.tech_score),
      value_score: g.value_score == null ? null : Number(g.value_score),
      sentiment_score: g.sentiment_score == null ? null : Number(g.sentiment_score),
      sentiment_note: g.sentiment_note,
    } : null;
    const sent = s.model?.sentiment_score;
    s.aiSignal = sent == null ? 'NA' : sent > 0.1 ? 'BULL' : sent < -0.1 ? 'BEAR' : 'NEUTRAL';
    const comp = s.model?.signal || '';
    s.modelSignal = comp.includes('ALIGNED') || comp.includes('MOMENTUM') ? 'BULL'
      : comp.includes('WEAK') ? 'BEAR' : comp ? 'NEUTRAL' : 'NA';
    const votes = [s.techSignal, s.valueSignal, s.aiSignal, s.modelSignal];
    s.consensus = { bull: votes.filter((v) => v === 'BULL').length, bear: votes.filter((v) => v === 'BEAR').length, total: 4 };
    s.quadrant = comp || null;

    // ─── Verdicts v1: stance (Buy/Hold/Sell) + valuation, with reasons ───
    // Stance from technical composite; sentiment nudges borderline cases only.
    let stance = null;
    if (s.techScore != null) {
      if (s.techScore >= 0.5) stance = 'BUY';
      else if (s.techScore <= -0.5) stance = 'SELL';
      else if (s.techScore >= 0.25 && s.aiSignal === 'BULL') stance = 'BUY';
      else if (s.techScore <= -0.25 && s.aiSignal === 'BEAR') stance = 'SELL';
      else stance = 'HOLD';
    }
    let valuation = null;
    if (s.valueScore != null) {
      if (s.valueScore >= 0.5) valuation = 'UNDERVALUED';
      else if (s.valueScore <= -0.5) valuation = 'OVERVALUED';
      else valuation = 'FAIRLY VALUED';
    }
    const rs = [];
    if (zPbv[i] != null && zPbv[i] >= 0.5) rs.push('P/B below market average');
    if (zPbv[i] != null && zPbv[i] <= -0.5) rs.push('P/B above market average');
    if (zPe[i] != null && zPe[i] >= 0.5) rs.push('low P/E vs market');
    if (zPe[i] != null && zPe[i] <= -0.5) rs.push('high P/E vs market');
    if (zDy[i] != null && zDy[i] >= 0.5) rs.push('dividend yield above market');
    if (zDy[i] != null && zDy[i] <= -0.5) rs.push('low dividend yield');
    if (s.ret3m != null && s.ret3m >= 10) rs.push(`strong 3M momentum (+${Math.round(s.ret3m)}%)`);
    if (s.ret3m != null && s.ret3m <= -10) rs.push(`weak 3M momentum (${Math.round(s.ret3m)}%)`);
    if (s.vsMa20 != null && s.vsMa20 >= 2) rs.push('above 20-day average');
    if (s.vsMa20 != null && s.vsMa20 <= -2) rs.push('below 20-day average');
    if (s.aiSignal === 'BULL') rs.push('news sentiment positive');
    if (s.aiSignal === 'BEAR') rs.push('news sentiment negative');
    s.verdict = { stance, valuation, reasons: rs.slice(0, 3) };
  });

  return {
    asof: rows.length ? isoD(rows[rows.length - 1].d) : null,
    model_run: sigDate,
    stocks,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/history') {
        const sql = neon(env.NEON_DATABASE_URL);
        const rows = await sql`
          SELECT trade_date AS d, symbol AS s, close_price AS c, change_percent AS ch, volume AS v, market_capitalization AS mc
          FROM mse_stock_prices
          WHERE market_type = 'mainboard'
          ORDER BY trade_date, symbol`;
        return new Response(JSON.stringify(rows), { headers: JSON_HEADERS });
      }

      if (path === '/api/forecast') {
        const payload = await forecastPayload(env);
        return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
      }

      const stockMatch = path.match(/^\/api\/stock\/([A-Z]+)$/);
      if (stockMatch) {
        const sym = stockMatch[1];
        const sql = neon(env.NEON_DATABASE_URL);
        const rows = await sql`
          SELECT trade_date AS d, close_price AS c, raw_close AS rc, change_percent AS ch, volume AS v,
                 turnover AS t, market_capitalization AS mc, pe_ratio AS pe, dividend_yield_percent AS dy,
                 after_tax_profit AS atp
          FROM mse_stock_prices
          WHERE market_type = 'mainboard' AND symbol = ${sym}
          ORDER BY trade_date`;
        if (rows.length === 0) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(rows), { headers: JSON_HEADERS });
      }

      if (path === '/api/index') {
        const sql = neon(env.NEON_DATABASE_URL);
        const rows = await sql`
          SELECT trade_date AS d, masi, domestic_index AS dsi, foreign_index AS fsi
          FROM mse_index_daily
          ORDER BY trade_date`;
        return new Response(JSON.stringify(rows), { headers: JSON_HEADERS });
      }

      if (path === '/api/health') {
        return new Response(JSON.stringify({ ok: true, ts: Date.now() }), { headers: JSON_HEADERS });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: JSON_HEADERS,
      });
    }
  },
};
