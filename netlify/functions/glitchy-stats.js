// This runs on Netlify's server, not in the browser.
// Your Glitchy token stays here — never sent to the frontend.
//
// Fetches Glitchy for the EST calendar day (default today), sums by source,
// and keeps today's `daily_totals` history row current on every call. There is
// no session / "New Day" concept — the day rolls over automatically at EST
// midnight.

const {
  todayEst,
  supabaseClient,
  fetchGlitchy,
  upsertTodayTotals,
  networkByCampaignName,
} = require("./_shared/glitchy-daily");
const { fetchMabacSubIdReport } = require("./_shared/mabac");

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
    // reaches today (the normal dashboard poll). Combined Glitchy + Mabac
    // earnings by network ownership. Every part here is best-effort — a Mabac
    // or Supabase hiccup never blocks the Glitchy response.
    if (endDate >= today) {
      const supabase = supabaseClient();
      if (supabase) {
        let mabacSources = [];
        try {
          const mb = await fetchMabacSubIdReport({ startDate: today, endDate: today });
          mabacSources = mb.sources || [];
        } catch (_) {
          /* Mabac optional */
        }
        try {
          const networkByName = await networkByCampaignName(supabase);
          await upsertTodayTotals(supabase, entries, { mabacSources, networkByName });
        } catch (_) {
          /* history write is best-effort */
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
