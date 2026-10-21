import { neon } from "@neondatabase/serverless";

// ─── Phungu Insights ETL — Cloudflare Worker ─────────────
// Ports runMseEtl.ts off Base44: scrapes MSE live pages,
// recalculates change_percent, upserts straight into Neon,
// logs to mse_etl_log, and notifies Telegram.
// Cron: 09:00 / 13:00 / 15:30 Blantyre (UTC+2), Mon-Fri.
// Manual: POST /run with x-master-key header.

const BASE = "https://mse.co.mw";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseNumber(str) {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, "").replace(/[^0-9.\-]/g, "").trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}
function extractSymbol(rowHtml) {
  const m = rowHtml.match(/<a[^>]*>\s*(.*?)\s*<\/a>/s);
  return m ? m[1].trim() : null;
}
function extractRightCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\s+class="text-right[^"]*">(.*?)<\/td>/gs)]
    .map(m => m[1].replace(/<[^>]*>/g, "").trim());
}
function extractTradeDate(html, fallback) {
  const m = html.match(/Updated on:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${year}-${month}-${day}`;
  }
  return fallback;
}
function parseMarketRows(html, marketType) {
  const results = [];
  const rows = html.match(/<tr>\s*<td><i class="fa fa-sort">.*?<a[^>]*>.*?<\/a>.*?<\/tr>/gs) || [];
  for (const row of rows) {
    const symbol = extractSymbol(row);
    if (!symbol) continue;
    const cells = extractRightCells(row);
    if (marketType === "debt") {
      results.push({ symbol, market_type: "debt", open_price: 0,
        close_price: parseNumber(cells[1] || "0"), change_percent: parseNumber(cells[2] || "0"),
        volume: parseNumber(cells[3] || "0"), turnover: 0, interest: parseNumber(cells[0] || "0") });
    } else {
      results.push({ symbol, market_type: marketType,
        open_price: parseNumber(cells[0] || "0"), close_price: parseNumber(cells[1] || "0"),
        change_percent: parseNumber(cells[2] || "0"), volume: parseNumber(cells[3] || "0"),
        turnover: parseNumber(cells[4] || "0"), interest: 0 });
    }
  }
  return results;
}
async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

// change_percent recalculated from the latest PRIOR close in Neon
async function applyChangePercent(sql, records, tradeDate) {
  const prior = await sql`
    SELECT DISTINCT ON (symbol, market_type) symbol, market_type, close_price
    FROM mse_stock_prices WHERE trade_date < ${tradeDate}
    ORDER BY symbol, market_type, trade_date DESC`;
  const prevMap = new Map(prior.map(r => [`${r.symbol}_${r.market_type}`, Number(r.close_price)]));
  let recalculated = 0;
  for (const rec of records) {
    const prev = prevMap.get(`${rec.symbol}_${rec.market_type}`);
    if (prev && prev > 0) {
      rec.change_percent = Math.round(((rec.close_price - prev) / prev) * 100 * 100) / 100;
      rec.previous_close = prev;
      recalculated++;
    } else {
      rec.previous_close = 0;
    }
  }
  return recalculated;
}

async function upsertNeon(sql, records, tradeDate, source) {
  const payload = JSON.stringify(records.map(r => ({
    ...r, trade_date: tradeDate, previous_close: r.previous_close || 0, data_source: source,
  })));
  await sql`
    INSERT INTO mse_stock_prices
      (symbol, market_type, trade_date, open_price, close_price, change_percent,
       volume, turnover, interest, previous_close, data_source, etl_run_date)
    SELECT r->>'symbol', r->>'market_type', (r->>'trade_date')::date,
           (r->>'open_price')::numeric, (r->>'close_price')::numeric,
           (r->>'change_percent')::numeric, (r->>'volume')::numeric,
           (r->>'turnover')::numeric, (r->>'interest')::numeric,
           (r->>'previous_close')::numeric, r->>'data_source', NOW()
    FROM jsonb_array_elements(${payload}::jsonb) AS r
    ON CONFLICT (symbol, market_type, trade_date) DO UPDATE SET
      open_price = EXCLUDED.open_price, close_price = EXCLUDED.close_price,
      change_percent = EXCLUDED.change_percent, volume = EXCLUDED.volume,
      turnover = EXCLUDED.turnover, interest = EXCLUDED.interest,
      previous_close = EXCLUDED.previous_close, data_source = EXCLUDED.data_source,
      etl_run_date = NOW()`;
  return records.length;
}

async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("Telegram send failed:", e); }
}

async function runEtl(env, trigger) {
  const t0 = Date.now();
  const sql = neon(env.DATABASE_URL);
  let status = "success", errorMessage = "", total = 0, recalculated = 0;
  const summaries = [];
  const markets = [
    { url: `${BASE}/market/mainboard`, type: "mainboard" },
    { url: `${BASE}/market/debt`, type: "debt" },
    { url: `${BASE}/market/edgex`, type: "edgex" },
  ];
  try {
    const today = new Date().toISOString().split("T")[0];
    let actualTradeDate = today;
    const allRecords = [];
    for (const market of markets) {
      try {
        const html = await fetchPage(market.url);
        const pageDate = extractTradeDate(html, today);
        if (pageDate !== today) actualTradeDate = pageDate;
        const records = parseMarketRows(html, market.type);
        if (records.length === 0) {
          summaries.push(`${market.type}: 0 records (market closed or no data)`);
          continue;
        }
        recalculated += await applyChangePercent(sql, records, actualTradeDate);
        for (const r of records) { r.trade_date = actualTradeDate; r.data_source = "live_scrape"; }
        await upsertNeon(sql, records, actualTradeDate, "live_scrape");
        allRecords.push(...records);
        total += records.length;
        summaries.push(`${market.type}: ${records.length} records`);
      } catch (err) {
        summaries.push(`${market.type}: ERROR — ${err.message}`);
      }
    }
    if (total === 0) { status = "error"; errorMessage = "No records extracted from any market"; }
    const duration = Math.round((Date.now() - t0) / 1000);
    await sql`INSERT INTO mse_etl_log (run_date, status, records_processed, duration_seconds, error_message, trigger)
              VALUES (NOW(), ${status}, ${total}, ${duration}, ${errorMessage || null}, ${trigger})`;
    const emoji = status === "success" ? "✅" : "❌";
    const msg = `${emoji} <b>MSE ETL ${status.toUpperCase()}</b> (Worker)\n` +
      `⏱ ${duration}s\n📊 ${total} records | 🔁 ${recalculated} changes recalculated\n` +
      `🔑 Trigger: ${trigger}\n💾 Neon: ✅ direct upsert\n` +
      (errorMessage ? `⚠️ ${errorMessage}\n` : "") + `\n` +
      summaries.map(s => `  • ${s}`).join("\n");
    await sendTelegram(env, msg);
    return { status, records_processed: total, changes_recalculated: recalculated,
             duration_seconds: duration, market_summaries: summaries, trade_date: actualTradeDate,
             error: errorMessage || undefined };
  } catch (err) {
    try {
      await sql`INSERT INTO mse_etl_log (run_date, status, records_processed, duration_seconds, error_message, trigger)
                VALUES (NOW(), 'error', 0, ${Math.round((Date.now() - t0) / 1000)}, ${String(err)}, ${trigger})`;
    } catch {}
    await sendTelegram(env, `❌ <b>MSE ETL FAILED</b> (Worker)\n⚠️ ${err}`);
    return { status: "error", error: String(err) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const trigger = cron === "30 13 * * 1-5" ? "scheduled_final" : cron === "0 11 * * 1-5" ? "scheduled_midday" : "scheduled";
    ctx.waitUntil(runEtl(env, trigger));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      if (req.headers.get("x-master-key") !== env.MSE_API_KEY) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const r = await runEtl(env, "manual_worker");
      return Response.json(r);
    }
    return Response.json({ service: "mse-etl", endpoints: { "POST /run": "trigger ETL (x-master-key required)" } });
  },
};
