// Mabac affiliate network reporting — Mabac runs on Everflow, so this uses the
// Everflow Affiliate API. Runs SERVER-SIDE ONLY.
//
// Verified against the live Everflow API:
//   POST https://api.eflow.team/v1/affiliates/reporting/entity/table
//   header:  X-Eflow-API-Key: <MABAC_API_KEY>   (header names are case-insensitive)
//   body:    { from, to (YYYY-MM-DD), timezone_id, currency_id, columns:[{column:"sub1"}], query:{filters:[]} }
//   resp:    { table: [ { columns:[{column_type:"sub1", id:"<value>", label}], reporting:{ total_click, cv, revenue } } ] }
//   GET https://api.eflow.team/v1/meta/timezones -> America/New_York is timezone_id 80
//
// The API key is read ONLY from process.env.MABAC_API_KEY and is never returned
// to the browser, logged, or committed. Until MABAC_API_KEY is set this returns
// { configured: false } and the dashboard runs Glitchy-only.
//
// Env:
//   MABAC_API_KEY   (required) — Everflow affiliate API key from the Mabac portal
//   MABAC_API_BASE  (optional) — override the API host. Default https://api.eflow.team;
//                                set to https://api-eu.eflow.team for an EU-hosted Everflow.

const DEFAULT_BASE = "https://api.eflow.team";
const NY_TIMEZONE_ID = 80; // America/New_York (Eastern), from GET /v1/meta/timezones

function mabacConfig() {
  const key = process.env.MABAC_API_KEY;
  if (!key) return null;
  return {
    key,
    base: (process.env.MABAC_API_BASE || DEFAULT_BASE).replace(/\/+$/, ""),
  };
}

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Pull the sub1 value out of an Everflow table row's `columns` array.
function rowSub1(row) {
  const cols = Array.isArray(row.columns) ? row.columns : [];
  const c = cols.find((x) => String(x.column_type || "").toLowerCase() === "sub1");
  const v = c ? c.id : null;
  return v == null ? "" : String(v).trim();
}

// Fetch the Everflow affiliate sub1 report for [startDate, endDate] (YYYY-MM-DD,
// America/New_York). Groups/aggregates by sub1.
// Returns { configured, sources: [{ sub1, clicks, conversions, revenue }], ... }.
async function fetchMabacSubIdReport({ startDate, endDate }) {
  const cfg = mabacConfig();
  if (!cfg) return { configured: false, sources: [] };

  const res = await fetch(`${cfg.base}/v1/affiliates/reporting/entity/table`, {
    method: "POST",
    headers: {
      "X-Eflow-API-Key": cfg.key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: startDate,
      to: endDate,
      timezone_id: NY_TIMEZONE_ID,
      currency_id: "USD",
      columns: [{ column: "sub1" }],
      query: { filters: [] },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let hint = "";
    if (res.status === 401 || res.status === 403 || /authenticat/i.test(text)) {
      hint =
        " — check MABAC_API_KEY, and if the Mabac Everflow account is EU-hosted set MABAC_API_BASE=https://api-eu.eflow.team";
    }
    const err = new Error(`Mabac (Everflow) responded with status ${res.status}${hint}`);
    err.status = res.status;
    err.details = text.slice(0, 400);
    throw err;
  }

  const data = await res.json();
  const table = Array.isArray(data.table) ? data.table : [];

  // Aggregate rows sharing the same sub1 (defensive — /table already groups).
  const bySub1 = {};
  for (const row of table) {
    const sub1 = rowSub1(row);
    if (!sub1) continue;
    const r = row.reporting || {};
    bySub1[sub1] = bySub1[sub1] || { sub1, clicks: 0, conversions: 0, revenue: 0 };
    bySub1[sub1].clicks += toNum(r.total_click);
    bySub1[sub1].conversions += toNum(r.cv);
    bySub1[sub1].revenue += toNum(r.revenue);
  }

  const sources = Object.values(bySub1).map((s) => ({
    ...s,
    revenue: Math.round(s.revenue * 100) / 100,
  }));

  return { configured: true, sources, raw_row_count: table.length };
}

module.exports = { fetchMabacSubIdReport, mabacConfig };
