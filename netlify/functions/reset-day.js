const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Use POST" }) };
    }

    const token = process.env.GLITCHY_TOKEN;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const requiredPassword = process.env.NEW_DAY_PASSWORD;

    if (!token || !supabaseUrl || !supabaseKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Missing GLITCHY_TOKEN, SUPABASE_URL, or SUPABASE_SERVICE_KEY env vars in Netlify.",
        }),
      };
    }

    if (!requiredPassword) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "NEW_DAY_PASSWORD is missing. Add it in Netlify → Site settings → Environment variables." }),
      };
    }

    // The password check has to happen here, server-side — anything in the
    // frontend bundle is visible to anyone via view-source, so a client-side
    // check would be no protection at all.
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    if (body.password !== requiredPassword) {
      return { statusCode: 401, body: JSON.stringify({ error: "Incorrect password." }) };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Glitchy buckets its "hour" field in EST — our boundary has to use the
    // same clock or the hour comparison in glitchy-stats.js won't line up.
    const now = new Date();
    const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    const estDate = new Date(estString);
    const resetDate = `${estDate.getFullYear()}-${String(estDate.getMonth() + 1).padStart(2, "0")}-${String(estDate.getDate()).padStart(2, "0")}`;
    const resetHour = String(estDate.getHours()).padStart(2, "0");

    const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${resetDate}&endDate=${resetDate}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, */*" },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Glitchy responded ${response.status}`, details: text.slice(0, 500) }),
      };
    }

    const data = await response.json();
    const entries = Array.isArray(data) ? data : data.data || data.results || [data];

    // Sum per source, but ONLY for the current boundary hour — that's the
    // exact number we need to subtract later so hours before the reset don't
    // get double counted, and hours after it are fully fresh.
    const bucket = {};
    for (const entry of entries) {
      const stat = entry.Stat || entry.stat || entry;
      if (!stat || !stat.source || stat.hour !== resetHour) continue;
      const src = stat.source;
      bucket[src] = bucket[src] || { clicks: 0, conversions: 0, payout: 0 };
      bucket[src].clicks += Number(stat.clicks || 0);
      bucket[src].conversions += Number(stat.conversions || 0);
      bucket[src].payout += Number(stat.payout || 0);
    }

    // Also snapshot sources that exist today but have zero activity in the
    // boundary hour — baseline of 0 is still valid, means "everything from
    // here on counts."
    const allSourcesToday = new Set();
    for (const entry of entries) {
      const stat = entry.Stat || entry.stat || entry;
      if (stat && stat.source) allSourcesToday.add(stat.source);
    }

    const rows = [...allSourcesToday].map((src) => ({
      source_name: src,
      reset_date: resetDate,
      reset_hour: resetHour,
      clicks_at_reset: bucket[src]?.clicks || 0,
      conversions_at_reset: bucket[src]?.conversions || 0,
      payout_at_reset: bucket[src]?.payout || 0,
    }));

    if (rows.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No sources found today — nothing to reset.", reset_date: resetDate, reset_hour: resetHour }),
      };
    }

    const { error: upsertError } = await supabase
      .from("reset_baselines")
      .upsert(rows, { onConflict: "source_name,reset_date" });

    if (upsertError) {
      return { statusCode: 500, body: JSON.stringify({ error: "Supabase upsert failed", details: upsertError.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Reset saved for ${rows.length} sources — ${resetDate}, hour ${resetHour} EST.`,
        reset_date: resetDate,
        reset_hour: resetHour,
        rows,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }),
    };
  }
};
