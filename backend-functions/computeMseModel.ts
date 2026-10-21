import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// ─── MSE Model v0.3 — Compute Layer ───────────────────────
// Value layer v0.3: 0.4 z(-PE) + 0.3 z(DY) + 0.3 z(-PBV) (renormalized if PBV missing).
// Computes technical + fundamental layers from the full price archive,
// z-scores them, assigns quadrant signals, stores per-stock signals in
// MseModelSignal (idempotent per run_date), and returns a compact
// report_text for the agent step to blend with sentiment and deliver.

function round1(x: number): number { return Math.round(x * 10) / 10; }

function zscores(obj: Record<string, number>): Record<string, number> {
  const vals = Object.values(obj);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const var_ = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
  const sd = Math.sqrt(var_);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = sd > 0 ? (v - mean) / sd : 0;
  return out;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const runDate = new Date().toISOString().slice(0, 10);

  const all: any[] = await base44.asServiceRole.entities.MseStockPrice.list();
  const main = all.filter((r) => r.market_type === "mainboard");

  // per-symbol history + latest fundamentals
  const hist = new Map<string, { d: string; c: number }[]>();
  const pe = new Map<string, number>();
  const dy = new Map<string, number>();
  const mc = new Map<string, number>();
  const pbv = new Map<string, number>();
  for (const r of main) {
    if (!hist.has(r.symbol)) hist.set(r.symbol, []);
    hist.get(r.symbol)!.push({ d: r.trade_date, c: r.close_price });
    if (r.pe_ratio != null && !pe.has(r.symbol)) pe.set(r.symbol, r.pe_ratio);
    if (r.dividend_yield_percent != null && !dy.has(r.symbol)) dy.set(r.symbol, r.dividend_yield_percent);
    if (r.market_capitalization != null && !mc.has(r.symbol)) mc.set(r.symbol, r.market_capitalization);
    if (r.pbv != null && r.pbv > 0 && !pbv.has(r.symbol)) pbv.set(r.symbol, r.pbv);
  }
  for (const [s, h] of hist) h.sort((a, b) => (a.d < b.d ? -1 : 1));

  const M: Record<string, any> = {};
  for (const [sym, h] of hist) {
    const closes = h.map((x) => x.c);
    const last = closes[closes.length - 1];
    const ret = (n: number) => (closes.length > n ? ((last / closes[closes.length - 1 - n] - 1) * 100) : null);
    const first2026 = h.find((x) => x.d >= "2026-01-01");
    const ytd = first2026 ? (last / first2026.c - 1) * 100 : null;
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    const meanR = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const varR = rets.reduce((a, b) => a + (b - meanR) * (b - meanR), 0) / (rets.length || 1);
    const vol = Math.sqrt(varR) * Math.sqrt(252) * 100;
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
    let peak = closes[0], mdd = 0;
    for (const c of closes) { peak = Math.max(peak, c); mdd = Math.min(mdd, (c / peak - 1) * 100); }
    M[sym] = {
      ytd, r3m: ret(63), r1m: ret(21), vol, ma20dev: (last / ma20 - 1) * 100, mdd,
      pe: pe.get(sym) ?? null, dy: dy.get(sym) ?? null, mc: mc.get(sym) ?? null,
      pbv: pbv.get(sym) ?? null,
      days: closes.length, last,
    };
  }

  // z-score pools (exclude stocks without 3M history or P/E)
  const pool = Object.keys(M).filter((s) => M[s].r3m != null && M[s].pe != null);
  const techRaw: Record<string, number> = {};
  const valRaw: Record<string, number> = {};
  const z3 = zscores(Object.fromEntries(pool.map((s) => [s, M[s].r3m])));
  const z1 = zscores(Object.fromEntries(pool.map((s) => [s, M[s].r1m ?? 0])));
  const zm = zscores(Object.fromEntries(pool.map((s) => [s, M[s].ma20dev])));
  const zp = zscores(Object.fromEntries(pool.map((s) => [s, -M[s].pe])));
  const zd = zscores(Object.fromEntries(pool.map((s) => [s, M[s].dy ?? 0])));
  const zpb = zscores(Object.fromEntries(pool.map((s) => [s, M[s].pbv != null ? -M[s].pbv : 0])));
  for (const s of pool) {
    techRaw[s] = 0.5 * z3[s] + 0.3 * z1[s] + 0.2 * zm[s];
    // v0.3: 0.4 z(-PE) + 0.3 z(DY) + 0.3 z(-PBV), renormalized when PBV is missing
    const parts: [number, number][] = [[0.4, zp[s]], [0.3, zd[s]], [0.3, zpb[s]]];
    const use = parts.filter(([, z]) => z != null && isFinite(z));
    const wsum = use.reduce((a, [w]) => a + w, 0);
    valRaw[s] = wsum > 0 ? use.reduce((a, [w, z]) => a + w * z, 0) / wsum : 0;
  }
  const tech = zscores(techRaw);
  const val = zscores(valRaw);

  const classify = (t: number, v: number): string => {
    if (t > 0.25 && v > 0.25) return "ALIGNED BULL";
    if (t > 0.25 && v <= 0.25) return "MOMENTUM (RICH)";
    if (t <= 0.25 && v > 0.25) return t < -0.25 ? "VALUE WATCH" : "LEAN VALUE";
    if (t < -0.25 && v < -0.25) return "WEAK BOTH";
    return "NEUTRAL";
  };

  // prior run signals
  const sigs: any[] = await base44.asServiceRole.entities.MseModelSignal.list();
  const priorDates = [...new Set(sigs.map((r: any) => r.run_date))].filter((d: string) => d < runDate).sort();
  const priorMap = new Map<string, string>();
  if (priorDates.length > 0) {
    const pd = priorDates[priorDates.length - 1];
    for (const r of sigs) if (r.run_date === pd) priorMap.set(r.symbol, r.signal);
  }

  const rows: any[] = [];
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const sym of Object.keys(M).sort()) {
    const m = M[sym];
    let signal: string, tS: number | null = null, vS: number | null = null;
    if (m.r3m == null || m.pe == null) {
      signal = "NEW LISTING (history building)";
    } else {
      tS = Math.round(tech[sym] * 100) / 100;
      vS = Math.round(val[sym] * 100) / 100;
      signal = classify(tS, vS);
    }
    counts[signal] = (counts[signal] || 0) + 1;
    const prev = priorMap.get(sym);
    const changed = prev && prev !== signal ? ` [was ${prev}]` : "";
    rows.push({
      run_date: runDate, symbol: sym,
      ytd_return: m.ytd != null ? round1(m.ytd) : null,
      return_3m: m.r3m != null ? round1(m.r3m) : null,
      return_1m: m.r1m != null ? round1(m.r1m) : null,
      volatility: round1(m.vol), vs_ma20: round1(m.ma20dev), max_drawdown: round1(m.mdd),
      pe_ratio: m.pe, dividend_yield: m.dy, tech_score: tS, value_score: vS, signal,
    });
    lines.push(
      `${sym} | last ${m.last} | YTD ${m.ytd != null ? round1(m.ytd) + "%" : "n/a"} 3M ${m.r3m != null ? round1(m.r3m) + "%" : "n/a"} 1M ${m.r1m != null ? round1(m.r1m) + "%" : "n/a"} | PE ${m.pe ?? "n/a"} DY ${m.dy ?? "n/a"}% PBV ${m.pbv != null ? m.pbv : "n/a"} | tech ${tS ?? "-"} value ${vS ?? "-"} | ${signal}${changed}`
    );
  }

  // idempotent store: remove this run_date's rows, then create
  for (const r of sigs) if (r.run_date === runDate) {
    try { await base44.asServiceRole.entities.MseModelSignal.delete(r.id); } catch { /* transient */ }
  }
  let stored = 0;
  for (const row of rows) {
    try { await base44.asServiceRole.entities.MseModelSignal.create(row); stored++; } catch { /* transient */ }
  }

  const reportText =
    `MSE Model v0.3 compute — run ${runDate}\n` +
    `Signals: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}\n` +
    lines.join("\n");

  return new Response(JSON.stringify({
    success: true, run_date: runDate, stocks: rows.length, stored,
    signal_counts: counts, report_text: reportText,
  }), { headers: { "Content-Type": "application/json" } });
});
