// Backs the profit calendar heatmap. Reads/writes a `daily_totals` table in
// Supabase (date, total_spend, total_earnings). TikTok spend isn't real yet,
// so total_spend is a deterministic mock — but total_earnings for TODAY is
// always the real, baseline-corrected Glitchy total, upserted here before
// being read back, so the calendar stays in sync with the live dashboard.
//
// This file is self-contained and does not modify glitchy-stats.js or
// reset-day.js — it duplicates the small amount of grouping/baseline logic
// it needs so those two functions stay untouched.

const { createClient } = require("@supabase/supabase-js");

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
    const today = new Date().toISOString().split("T")[0];
    const month = params.month || today.slice(0, 7); // YYYY-MM

    const [year, mon] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

    // If today falls inside the requested month, refresh today's row with a
    // real earnings figure before reading the month back.
    if (token && today >= monthStart && today <= monthEnd) {
      try {
        const totalEarnings = await fetchTodayEarnings(token, today, supabase);
        const mockSpend = seededMockSpend(today);
        await supabase
          .from("daily_totals")
          .upsert({ date: today, total_spend: mockSpend, total_earnings: totalEarnings }, { onConflict: "date" });
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

// Sums today's real payout across all sources, applying the same reset-day
// baseline correction glitchy-stats.js uses, so this total agrees with the
// KPI strip on the main dashboard.
async function fetchTodayEarnings(token, dateStr, supabase) {
  const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${dateStr}&endDate=${dateStr}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) throw new Error(`Glitchy responded ${response.status}`);

  const data = await response.json();
  const entries = Array.isArray(data) ? data : data.data || data.results || [data];

  const bySourceHour = {};
  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const src = stat.source;
    const hr = stat.hour;
    bySourceHour[src] = bySourceHour[src] || {};
    bySourceHour[src][hr] = (bySourceHour[src][hr] || 0) + Number(stat.payout || 0);
  }

  const { data: baselines } = await supabase.from("reset_baselines").select("*").eq("reset_date", dateStr);
  const baselineBySource = {};
  for (const b of baselines || []) baselineBySource[b.source_name] = b;

  let total = 0;
  for (const src of Object.keys(bySourceHour)) {
    const hours = bySourceHour[src];
    const baseline = baselineBySource[src];
    for (const hr of Object.keys(hours)) {
      if (baseline && hr === baseline.reset_hour) {
        total += Math.max(0, hours[hr] - baseline.payout_at_reset);
      } else if (baseline && hr < baseline.reset_hour) {
        continue;
      } else {
        total += hours[hr];
      }
    }
  }
  return Math.round(total * 100) / 100;
}

// Deterministic mock spend for a date — uses the same seed key/algorithm as
// js/mock.js's mockDayTotals so values would line up if ever compared.
function seededMockSpend(dateStr) {
  const rng = mulberry32(hashString(`daytotal::${dateStr}`));
  return Math.round((80 + rng() * 540) * 100) / 100;
}

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
