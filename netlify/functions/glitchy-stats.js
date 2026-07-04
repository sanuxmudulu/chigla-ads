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

    const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Custom&startDate=${startDate}&endDate=${endDate}`;

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

    // Group and sum everything by "source" (your ad name or campaign name).
    const grouped = {};

    for (const entry of entries) {
      const stat = entry.Stat || entry.stat || entry;
      if (!stat || !stat.source) continue;

      const key = stat.source;
      if (!grouped[key]) {
        grouped[key] = {
          source: key,
          clicks: 0,
          conversions: 0,
          payout: 0,
          offer_name: entry.Offer?.name || entry.offer?.name || null,
          entries_count: 0,
        };
      }

      grouped[key].clicks += Number(stat.clicks || 0);
      grouped[key].conversions += Number(stat.conversions || 0);
      grouped[key].payout += Number(stat.payout || 0);
      grouped[key].entries_count += 1;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate,
        endDate,
        raw_entry_count: entries.length,
        sources: Object.values(grouped),
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
