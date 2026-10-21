const res = await fetch('https://mse-portal.wiztechsol-info.workers.dev/api/history');
const rows = await res.json();
console.log('rows:', rows.length, rows[0]);

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
console.log('stats AIRTEL:', stats['AIRTEL']);
console.log('typeof close:', typeof stats['AIRTEL'].close, 'r1m:', stats['AIRTEL'].r1m, typeof stats['AIRTEL'].r1m);
