// This runs on Netlify's server, not in the browser.
// Your Glitchy token stays here — never sent to the frontend.
//
// Fetches Glitchy for the EST calendar day (default today), sums by source,
// and keeps today's `daily_totals` history row current on every call. There is
// no session / "New Day" concept — the day rolls over automatically at EST
// midnight.

const { todayEst, supabaseClient, fetchGlitchy, upsertTodayTotals } = require("./_shared/glitchy-daily");

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

    // ?startDate=2026-07-04&endDate=2026-07-05 — both default to today (EST).
    const params = event.queryStringParameters || {};
    const today = todayEst();
    const startDate = params.startDate || today;
    const endDate = params.endDate || today;

    const { entries, bySource } = await fetchGlitchy(token, startDate, endDate);
    const sources = Object.keys(bySource).map((src) => ({ source: src, ...bySource[src] }));

    // Automatic daily history: refresh today's row whenever the requested range
    // reaches today (i.e. the normal dashboard poll). Non-fatal if it fails.
    if (endDate >= today) {
      const supabase = supabaseClient();
      if (supabase) {
        try {
          await upsertTodayTotals(supabase, entries);
        } catch (_) {
          /* history write is best-effort — never block the dashboard */
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate,
        endDate,
        raw_entry_count: entries.length,
        sources,
        // Raw entries power the Live Performance hourly chart on the frontend.
        raw: entries,
      }),
    };
  } catch (err) {
    if (err.status) {
      return {
        statusCode: err.status,
        body: JSON.stringify({ error: err.message, details: err.details }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }),
    };
  }
};
