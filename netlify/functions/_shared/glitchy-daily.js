// Shared by glitchy-stats.js and daily-totals.js.
//
// The dashboard day is simply the EST calendar date. There is no manual
// "New Day" / session concept any more: Glitchy is queried for today, summed
// by source, and today's row in `daily_totals` is kept current on every poll.
// When EST midnight passes, Glitchy returns the new date's data and a fresh
// `daily_totals` row is written automatically.
//
// (The old `reset_baselines` table and its session logic are gone. The table
// is left in place as historical storage but is never read or written.)

const { createClient } = require("@supabase/supabase-js");

let WebSocketImpl;
try {
  WebSocketImpl = require("ws");
} catch (_) {
  WebSocketImpl = undefined; // fall back to a global WebSocket if present
}

// EST calendar date (YYYY-MM-DD). Glitchy's `hour` field is EST-anchored, so
// everything the dashboard shows is keyed to this same clock.
function todayEst() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Glitchy's Stat.date is normalised to a bare YYYY-MM-DD (EST) so per-day
// filtering is safe regardless of the exact string Glitchy returns.
function normalizeDateKey(raw, fallback) {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  if (isNaN(d)) return fallback;
  const est = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}

// Supabase client with an explicit WebSocket for the Realtime constructor that
// @supabase/supabase-js builds inside createClient() (Netlify's Lambda Node
// runtime does not reliably expose a global WebSocket). Realtime is unused.
function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const opts = { auth: { persistSession: false } };
  if (WebSocketImpl) opts.realtime = { transport: WebSocketImpl };
  return createClient(url, key, opts);
}

// Fetch Glitchy for [startDate, endDate] and return the raw entries plus a
// plain per-source sum (no baseline correction).
async function fetchGlitchy(token, startDate, endDate) {
  const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${startDate}&endDate=${endDate}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, */*" },
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Glitchy responded with status ${response.status}`);
    err.status = response.status;
    err.details = text.slice(0, 500);
    throw err;
  }

  const data = await response.json();
  const entries = Array.isArray(data) ? data : data.data || data.results || [data];
  return { entries, bySource: summarizeBySource(entries) };
}

// Sum raw Glitchy entries by source.
function summarizeBySource(entries) {
  const result = {};
  const offerName = {};
  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const src = stat.source;
    result[src] = result[src] || { clicks: 0, conversions: 0, payout: 0, entries_count: 0 };
    result[src].clicks += Number(stat.clicks || 0);
    result[src].conversions += Number(stat.conversions || 0);
    result[src].payout += Number(stat.payout || 0);
    result[src].entries_count += 1;
    offerName[src] = entry.Offer?.name || entry.offer?.name || offerName[src] || null;
  }
  for (const src of Object.keys(result)) {
    result[src].payout = Math.round(result[src].payout * 100) / 100;
    result[src].offer_name = offerName[src];
  }
  return result;
}

// Sum only the entries dated `dateStr` (EST) — used for today's totals even
// when the fetch covered a wider range.
function sumEntriesForDate(entries, dateStr) {
  let payout = 0;
  let clicks = 0;
  let conversions = 0;
  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const dk = stat.date ? normalizeDateKey(stat.date, dateStr) : dateStr;
    if (dk !== dateStr) continue;
    payout += Number(stat.payout || 0);
    clicks += Number(stat.clicks || 0);
    conversions += Number(stat.conversions || 0);
  }
  return { payout: Math.round(payout * 100) / 100, clicks, conversions };
}

// Upsert today's row in `daily_totals`. `total_spend` stays 0 until TikTok
// metrics are merged into the daily history — same as the KPI cards.
async function upsertTodayTotals(supabase, entries) {
  const today = todayEst();
  const { payout, clicks, conversions } = sumEntriesForDate(entries, today);
  const { error } = await supabase.from("daily_totals").upsert(
    {
      date: today,
      total_spend: 0,
      total_earnings: payout,
      total_clicks: clicks,
      total_conversions: conversions,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "date" }
  );
  if (error) throw new Error(`daily_totals upsert failed: ${error.message}`);
  return { date: today, total_earnings: payout, total_clicks: clicks, total_conversions: conversions };
}

module.exports = {
  todayEst,
  normalizeDateKey,
  supabaseClient,
  fetchGlitchy,
  summarizeBySource,
  sumEntriesForDate,
  upsertTodayTotals,
};
