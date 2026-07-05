// Backs the profit calendar heatmap. Reads/writes a `daily_totals` table in
// Supabase (date, total_spend, total_earnings). TikTok spend isn't connected
// yet, so total_spend stays 0 rather than an invented number — but
// total_earnings for TODAY is always the real, session-aware Glitchy total
// (same logic as glitchy-stats.js), upserted here before being read back.

const { createClient } = require("@supabase/supabase-js");
const { todayEst, resolveSessionRange, summarizeWithBaseline } = require("./_shared/glitchy-session");

exports.handler = async function (event) {
  try {
    const token = process.env.GLITCHY_TOKEN;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars in Netlify." }),
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const params = event.queryStringParameters || {};
    const today = todayEst();
    const month = params.month || today.slice(0, 7); // YYYY-MM

    const [year, mon] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

    // If today falls inside the requested month, refresh today's row with a
    // real earnings figure before reading the month back.
    if (token && today >= monthStart && today <= monthEnd) {
      try {
        const totalEarnings = await fetchTodayEarnings(token, supabase);
        await supabase
          .from("daily_totals")
          .upsert({ date: today, total_spend: 0, total_earnings: totalEarnings }, { onConflict: "date" });
      } catch (_) {
        // Non-fatal — Glitchy hiccup shouldn't block the calendar from
        // rendering whatever is already stored.
      }
    }

    const { data: rows, error } = await supabase
      .from("daily_totals")
      .select("*")
      .gte("date", monthStart)
      .lte("date", monthEnd);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: "Supabase read failed", details: error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        month,
        days: (rows || []).map((r) => ({
          date: r.date,
          total_spend: Number(r.total_spend),
          total_earnings: Number(r.total_earnings),
        })),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }),
    };
  }
};

// Sums today's real payout across all sources, using the same session-aware
// range + baseline correction glitchy-stats.js uses, so this total agrees
// with the KPI strip on the main dashboard even mid-session.
async function fetchTodayEarnings(token, supabase) {
  const today = todayEst();
  const session = await resolveSessionRange(supabase, today, today);

  const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${session.effectiveStartDate}&endDate=${session.effectiveEndDate}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) throw new Error(`Glitchy responded ${response.status}`);

  const data = await response.json();
  const entries = Array.isArray(data) ? data : data.data || data.results || [data];

  const bySource = summarizeWithBaseline(entries, session.baselineBySource, session.effectiveEndDate);
  let total = 0;
  for (const src of Object.keys(bySource)) total += bySource[src].payout;
  return Math.round(total * 100) / 100;
}
