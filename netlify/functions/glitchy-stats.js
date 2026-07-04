// This runs on Netlify's server, not in the browser.
// Your Glitchy token stays here — never sent to the frontend.

exports.handler = async function (event) {
  try {
    const token = process.env.GLITCHY_TOKEN;

    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "GLITCHY_TOKEN is missing. Add it in Netlify → Site settings → Environment variables.",
        }),
      };
    }

    // Read startDate/endDate from the URL query, e.g. ?startDate=2026-07-04&endDate=2026-07-05
    // Defaults to today if not provided.
    const params = event.queryStringParameters || {};
    const today = new Date().toISOString().split("T")[0];
    const startDate = params.startDate || today;
    const endDate = params.endDate || today;

    const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${startDate}&endDate=${endDate}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/plain, */*",
      },
    });

    // If Glitchy rejects the token (expired, revoked, etc), this catches it
    // instead of silently returning garbage.
    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Glitchy responded with status ${response.status}`,
          details: text.slice(0, 500), // trim in case it's a huge HTML error page
        }),
      };
    }

    const data = await response.json();

    // The raw response is a list of entries, each with its own Stat + Offer block.
    // We don't know the exact top-level shape yet (list vs single object) —
    // this handles both so we don't crash either way.
    const entries = Array.isArray(data) ? data : data.data || data.results || [data];

    // Group by source AND hour first — we need per-hour totals to apply
    // the reset baseline correctly (see reset-day.js for why).
    const bySourceHour = {};
    const offerNameBySource = {};

    for (const entry of entries) {
      const stat = entry.Stat || entry.stat || entry;
      if (!stat || !stat.source) continue;

      const src = stat.source;
      const hr = stat.hour;
      bySourceHour[src] = bySourceHour[src] || {};
      bySourceHour[src][hr] = bySourceHour[src][hr] || { clicks: 0, conversions: 0, payout: 0, entries: 0 };
      bySourceHour[src][hr].clicks += Number(stat.clicks || 0);
      bySourceHour[src][hr].conversions += Number(stat.conversions || 0);
      bySourceHour[src][hr].payout += Number(stat.payout || 0);
      bySourceHour[src][hr].entries += 1;
      offerNameBySource[src] = entry.Offer?.name || entry.offer?.name || offerNameBySource[src] || null;
    }

    // Pull any saved reset baselines for this date range from Supabase.
    // If Supabase env vars aren't set yet, just skip this and return raw
    // totals — don't crash the whole function over it.
    let baselineBySource = {};
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey) {
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data: baselines, error: baselineError } = await supabase
        .from("reset_baselines")
        .select("*")
        .gte("reset_date", startDate)
        .lte("reset_date", endDate);

      if (baselineError) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: "Supabase read failed", details: baselineError.message }),
        };
      }

      for (const b of baselines || []) {
        // If a source has resets on multiple days in range, use the most recent one.
        if (!baselineBySource[b.source_name] || b.reset_date > baselineBySource[b.source_name].reset_date) {
          baselineBySource[b.source_name] = b;
        }
      }
    }

    // Now compute final numbers per source, applying the baseline where one exists.
    const sources = [];
    for (const src of Object.keys(bySourceHour)) {
      const hours = bySourceHour[src];
      const baseline = baselineBySource[src];

      let clicks = 0, conversions = 0, payout = 0, entryCount = 0;

      for (const hr of Object.keys(hours)) {
        entryCount += hours[hr].entries;

        if (baseline && hr === baseline.reset_hour) {
          // This is the boundary hour — subtract what already existed at reset time.
          clicks += Math.max(0, hours[hr].clicks - baseline.clicks_at_reset);
          conversions += Math.max(0, hours[hr].conversions - baseline.conversions_at_reset);
          payout += Math.max(0, hours[hr].payout - baseline.payout_at_reset);
        } else if (baseline && hr < baseline.reset_hour) {
          // Before the reset point today — already counted in the previous
          // tracking session, ignore it now.
          continue;
        } else {
          // Either no baseline at all (count everything), or this hour is
          // fully after the reset point (also count everything).
          clicks += hours[hr].clicks;
          conversions += hours[hr].conversions;
          payout += hours[hr].payout;
        }
      }

      sources.push({
        source: src,
        offer_name: offerNameBySource[src],
        clicks,
        conversions,
        payout,
        entries_count: entryCount,
        reset_applied: !!baseline,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate,
        endDate,
        raw_entry_count: entries.length,
        sources,
        // Keep the raw data in the response too, for now — helps us debug
        // if grouping looks wrong. We'll remove this once it's stable.
        raw: entries,
      }),
    };
  } catch (err) {
    // Catches network failures, JSON parse errors, anything unexpected.
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Function crashed",
        message: err.message,
        stack: err.stack,
      }),
    };
  }
};
