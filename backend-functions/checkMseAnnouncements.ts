import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

// ─── MSE Announcement Sweep ───────────────────────────────
// Fetches announcement feeds from two public sources, diffs against
// the MseAnnouncement entity (dedup_key), stores new items, and
// sends a Telegram alert when new announcements are found.
// Sources:
//   1. african-markets.com MSE page (republishes MSE official notices:
//      "ILLOVO | AGM notice", "FDHB | 2ND interim dividend", ...)
//   2. mansamarkets.com/dividends/malawi (dividend calendar rows)
// No LLM work — pure fetch/diff/store/notify, safe for scheduled runs.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

function clean(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function classify(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("dividend")) return "dividend";
  if (t.includes("agm")) return "AGM notice";
  if (t.includes("trading statement")) return "trading statement";
  if (t.includes("chairman") || t.includes("appointment") || t.includes("board")) return "corporate";
  return "other";
}

async function fetchAfricanMarkets(): Promise<any[]> {
  const res = await fetch("https://www.african-markets.com/en/stock-markets/mse", {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`african-markets HTTP ${res.status}`);
  const html = await res.text();
  const items: any[] = [];
  const re = /<a class="pdfviewer_module title" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = clean(m[2]);
    if (!title) continue;
    const company = title.includes("|") ? title.split("|")[0].trim() : "";
    items.push({
      dedup_key: `AM|${title}`,
      title,
      company,
      type: classify(title),
      source_site: "african-markets",
      source_url: `https://www.african-markets.com${m[1]}`,
      announced_date: "",
      raw_text: title,
    });
  }
  return items;
}

async function fetchMansaDividends(): Promise<any[]> {
  const res = await fetch("https://www.mansamarkets.com/dividends/malawi", {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`mansamarkets HTTP ${res.status}`);
  const html = await res.text();
  const items: any[] = [];
  // rows: <tr class="border-b border-gold/10"> ... cells ...
  const rows = html.split('<tr class="border-b border-gold/10">').slice(1);
  for (const row of rows) {
    const cells = row.split(/<\/td>/);
    const text = (i: number) => clean(cells[i] || "");
    // cell layout: 0=company(ticker), 1=DPS "MWK 14.23", 2=USD, 3=Type, 4=FY, 5=ex-date, 6=record, 7=payment, 8=yield, 9=status
    const companyCell = text(0);
    const tickerMatch = companyCell.match(/([A-Z0-9]{2,10})\s*·/);
    const ticker = tickerMatch ? tickerMatch[1] : companyCell.slice(0, 20);
    const dps = text(1).replace(/^MWK\s*/i, "").trim();
    const type = text(3);
    const fy = text(4);
    const status = text(9);
    if (!ticker || !dps) continue;
    const title = `DIVIDEND | ${ticker} MK${dps} ${type} ${fy} (${status})`;
    items.push({
      dedup_key: `MANSA|${ticker}|${dps}|${type}|${fy}`,
      title,
      company: ticker,
      type: "dividend",
      source_site: "mansamarkets",
      source_url: "https://www.mansamarkets.com/dividends/malawi",
      announced_date: text(5) || "",
      raw_text: `DPS ${dps} | Type ${type} | FY ${fy} | Ex ${text(5)} | Payment ${text(7)} | Yield ${text(8)} | Status ${status}`,
    });
  }
  return items;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  let force = false;
  try {
    const body = await req.json();
    force = body && body.force === true;
  } catch {
    // no body is fine
  }

  const sourceErrors: string[] = [];
  let found: any[] = [];
  for (const fetcher of [fetchAfricanMarkets, fetchMansaDividends]) {
    try {
      found = found.concat(await fetcher());
    } catch (e) {
      sourceErrors.push(String(e).slice(0, 100));
    }
  }

  // dedupe within this run
  const byKey = new Map<string, any>();
  for (const item of found) byKey.set(item.dedup_key, item);
  found = [...byKey.values()];

  // diff against stored announcements
  const existing: any[] = await base44.asServiceRole.entities.MseAnnouncement.list();
  const seen = new Set(existing.map((r) => r.dedup_key));
  const fresh = found.filter((i) => !seen.has(i.dedup_key));

  let stored = 0;
  for (const item of fresh) {
    try {
      await base44.asServiceRole.entities.MseAnnouncement.create({
        ...item,
        alert_sent: true,
      });
      stored++;
    } catch {
      // rate limit or transient — next sweep will retry
    }
  }

  // Telegram alert if there are new items (or forced test run)
  let telegram = "not_sent";
  if ((fresh.length > 0 || force) && stored > 0) {
    try {
      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
      if (token && chatId) {
        const lines = fresh
          .slice(0, 12)
          .map((i) => `• ${i.title}${i.announced_date ? ` (${i.announced_date})` : ""}`)
          .join("\n");
        const text =
          `🔔 <b>MSE Announcement Sweep</b>\n` +
          `<b>${fresh.length}</b> new announcement${fresh.length === 1 ? "" : "s"} found:\n\n` +
          lines +
          (fresh.length > 12 ? `\n…and ${fresh.length - 12} more` : "");
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        telegram = res.ok ? "sent" : `error ${res.status}`;
      } else {
        telegram = "missing secrets";
      }
    } catch (e) {
      telegram = `error: ${String(e).slice(0, 80)}`;
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      sources_checked: 2,
      source_errors: sourceErrors,
      total_found: found.length,
      new_announcements: fresh.length,
      stored,
      telegram,
      new_items: fresh.map((i) => i.title),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
