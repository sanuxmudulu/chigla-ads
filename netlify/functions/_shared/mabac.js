// Mabac affiliate network — "Sub ID Report" fetch. Runs server-side only.
//
// The Mabac API key is read ONLY from process.env.MABAC_API_KEY and is never
// returned to the browser or logged.
//
// The exact Mabac endpoint / auth style / query params / response field names
// are NOT hard-coded to guesses. Everything is driven by env vars so the real
// values can be filled in without a code change once the Mabac API docs are
// known. Until MABAC_API_KEY *and* MABAC_API_BASE are both set, this returns
// { configured: false, sources: [] } and the dashboard simply runs Glitchy-only.
//
// Env vars (server-side, Netlify):
//   MABAC_API_KEY            (required)  — the API key
//   MABAC_API_BASE           (required)  — e.g. https://api.mabac.com
//   MABAC_REPORT_PATH        (optional)  — e.g. /v1/reports/sub-id   [default below]
//   MABAC_AUTH_HEADER        (optional)  — header name for the key   [default: Authorization]
//   MABAC_AUTH_PREFIX        (optional)  — value prefix              [default: "Bearer "]
//   MABAC_QUERY_KEY_PARAM    (optional)  — if set, key goes in the query string under this name
//                                          instead of a header
//   MABAC_DATE_PARAM_START   (optional)  — [default: start_date]
//   MABAC_DATE_PARAM_END     (optional)  — [default: end_date]
//   MABAC_DATE_FORMAT        (optional)  — "iso" (YYYY-MM-DD, default) — reserved for future formats
//   MABAC_GROUP_PARAM        (optional)  — param that requests grouping (e.g. group_by / dimension)
//   MABAC_GROUP_VALUE        (optional)  — [default: sub1]
//   MABAC_TZ_PARAM           (optional)  — param name for timezone; when set, "America/New_York" is sent
//   MABAC_EXTRA_QUERY        (optional)  — extra "k=v&k2=v2" appended verbatim

// Candidate field names — the summariser tries each in order. Adjust once the
// real response shape is known (or just set the exact ones you see).
const SUB1_KEYS = ["sub1", "sub_1", "subid1", "sub_id_1", "aff_sub1", "aff_sub", "s1"];
const CLICK_KEYS = ["clicks", "click", "network_clicks", "networkClicks", "total_clicks", "totalClicks", "hits"];
const CONV_KEYS = ["conversions", "conversion", "cv", "leads", "sales", "total_conversions", "totalConversions", "count"];
const REVENUE_KEYS = ["revenue", "payout", "earnings", "earning", "amount", "total_revenue", "totalRevenue", "commission", "sum"];

function mabacConfig() {
  const key = process.env.MABAC_API_KEY;
  const base = process.env.MABAC_API_BASE;
  if (!key || !base) return null;
  return {
    key,
    base: base.replace(/\/+$/, ""),
    reportPath: process.env.MABAC_REPORT_PATH || "/v1/reports/sub-id",
    authHeader: process.env.MABAC_AUTH_HEADER || "Authorization",
    authPrefix: process.env.MABAC_AUTH_PREFIX != null ? process.env.MABAC_AUTH_PREFIX : "Bearer ",
    queryKeyParam: process.env.MABAC_QUERY_KEY_PARAM || "",
    startParam: process.env.MABAC_DATE_PARAM_START || "start_date",
    endParam: process.env.MABAC_DATE_PARAM_END || "end_date",
    groupParam: process.env.MABAC_GROUP_PARAM || "",
    groupValue: process.env.MABAC_GROUP_VALUE || "sub1",
    tzParam: process.env.MABAC_TZ_PARAM || "",
    extraQuery: process.env.MABAC_EXTRA_QUERY || "",
  };
}

const pick = (row, keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== "") return row[k];
  }
  return null;
};
const toNum = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Returns { configured, sources: [{ sub1, clicks, conversions, revenue }], ... }.
// Dates are YYYY-MM-DD in America/New_York (same dashboard day as Glitchy).
async function fetchMabacSubIdReport({ startDate, endDate }) {
  const cfg = mabacConfig();
  if (!cfg) return { configured: false, sources: [] };

  const url = new URL(cfg.base + cfg.reportPath);
  url.searchParams.set(cfg.startParam, startDate);
  url.searchParams.set(cfg.endParam, endDate);
  if (cfg.groupParam) url.searchParams.set(cfg.groupParam, cfg.groupValue);
  if (cfg.tzParam) url.searchParams.set(cfg.tzParam, "America/New_York");
  if (cfg.queryKeyParam) url.searchParams.set(cfg.queryKeyParam, cfg.key);
  if (cfg.extraQuery) {
    for (const pair of cfg.extraQuery.split("&")) {
      const i = pair.indexOf("=");
      if (i > 0) url.searchParams.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }

  const headers = { Accept: "application/json" };
  if (!cfg.queryKeyParam) headers[cfg.authHeader] = `${cfg.authPrefix}${cfg.key}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Mabac responded with status ${res.status}`);
    err.status = res.status;
    err.details = text.slice(0, 400);
    throw err;
  }

  const data = await res.json();
  const rows = Array.isArray(data)
    ? data
    : data.data || data.results || data.rows || data.report || data.items || [];

  const bySub1 = {};
  for (const row of rows) {
    const sub1 = String(pick(row, SUB1_KEYS) ?? "").trim();
    if (!sub1) continue;
    bySub1[sub1] = bySub1[sub1] || { sub1, clicks: 0, conversions: 0, revenue: 0 };
    bySub1[sub1].clicks += toNum(pick(row, CLICK_KEYS));
    bySub1[sub1].conversions += toNum(pick(row, CONV_KEYS));
    bySub1[sub1].revenue += toNum(pick(row, REVENUE_KEYS));
  }

  const sources = Object.values(bySub1).map((s) => ({
    ...s,
    revenue: Math.round(s.revenue * 100) / 100,
  }));

  return {
    configured: true,
    sources,
    raw_row_count: rows.length,
    // Non-sensitive: the keys of the first row so the field mapping can be
    // confirmed/adjusted without exposing values.
    sample_keys: rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : [],
  };
}

module.exports = { fetchMabacSubIdReport, mabacConfig };
