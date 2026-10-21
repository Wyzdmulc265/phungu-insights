const res = await fetch('https://mse-portal.wiztechsol-info.workers.dev/api/history');
const rows = await res.json();
const bySym = {};
for (const r of rows) (bySym[r.s] = bySym[r.s] || []).push(r);
for (const s in bySym) bySym[s].sort((a, b) => a.d < b.d ? -1 : 1);
const stats = {};
for (const s in bySym) {
  const h = bySym[s];
  const last = h[h.length - 1];
  const closeAt = n => h.length > n ? h[h.length - 1 - n].c : null;
  const ytd = h.find(r => r.d >= '2026-01-01');
  stats[s] = {
    close: last.c, ch: last.ch, lastd: last.d,
    r1m: closeAt(21) ? (last.c / closeAt(21) - 1) * 100 : null,
    r3m: closeAt(63) ? (last.c / closeAt(63) - 1) * 100 : null,
    ytd: ytd ? (last.c / ytd.c - 1) * 100 : null,
    mc: (h.slice().reverse().find(r => r.mc != null) || {}).mc || null
  };
}
const latestDate = rows[rows.length - 1].d;
console.log('latestDate:', latestDate);

const byDate = {};
for (const r of rows) (byDate[r.d] = byDate[r.d] || {})[r.s] = r.c;
const dates = Object.keys(byDate).sort();
const base = {};
const series = [];
for (const d of dates) {
  let sum = 0, n = 0;
  for (const s in byDate[d]) {
    if (!(s in base)) base[s] = byDate[d][s];
    sum += byDate[d][s] / base[s]; n++;
  }
  if (n >= 10) series.push({ d, v: (sum / n) * 100 });
}
console.log('series length', series.length, series[series.length-1]);

const idx = series[series.length - 1].v;
const idxPrev = series[series.length - 2] ? series[series.length - 2].v : idx;
const idxChg = idx - 100;
let adv = 0, dec = 0;
for (const s in stats) { const ch = parseFloat(stats[s].ch) || 0; if (ch > 0) adv++; else if (ch < 0) dec++; }
const syms = Object.keys(stats);
console.log('syms count:', syms.length, syms);
const ytdVals = syms.map(s => stats[s].ytd).filter(v => v !== null);
const best = syms.filter(s => stats[s].ytd !== null).sort((a, b) => stats[b].ytd - stats[a].ytd);
console.log('best[0]', best[0], 'best last', best[best.length-1]);

// table render
let sortKey = 'ytd', sortDesc = true;
const arr = syms.slice().sort((a, b) => {
  const va = stats[a][sortKey] ?? -1e9, vb = stats[b][sortKey] ?? -1e9;
  return (sortDesc ? vb - va : va - vb);
});
console.log('arr', arr);
try {
  const html = arr.map(s => {
    const st = stats[s];
    const cls = v => v == null ? '' : (v >= 0 ? 'up' : 'down');
    const pc = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
    const nm = s; // simulate COMPANIES undefined
    return `<tr><td>${s} ${nm}</td><td>${Number(st.close).toLocaleString()}</td></tr>`;
  }).join('');
  console.log('HTML OK, length', html.length);
} catch(e) { console.log('RENDER ERROR:', e.message); }
