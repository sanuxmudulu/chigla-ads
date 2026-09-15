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
  earningsSnapshotToday,
  hourlyEarningsFromEntries,
  sumEntriesBySourceForDate,
  nyHourNow,
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
    let earningsToday = null;
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
          const totals = await upsertTodayTotals(supabase, entries, { mabacSources, networkByName });
          const currentHour = nyHourNow();

          // Live Performance graph ONLY. Prefer TRUE per-hour attribution,
          // recomputed fresh from this poll's own complete entry list (see
          // hourlyEarningsFromEntries) — same idea as tiktok-campaigns.js's
          // stat_time_hour fix for Spend, so the two lines stop disagreeing
          // by however long it's been since the dashboard was last open.
          // Falls back to the old polled-snapshot mechanism only when
          // Glitchy's entries carry no usable time-of-day this run.
          const mabacBySub1 = {};
          for (const s of mabacSources) if (s && s.sub1) mabacBySub1[s.sub1] = s;
          const glitchyBySourceDay = sumEntriesBySourceForDate(entries, today);
          const trueHourly = hourlyEarningsFromEntries({
            entries,
            dateStr: today,
            glitchyBySourceDay,
            mabacBySub1,
            networkByName,
            currentHour,
          });

          if (trueHourly) {
            earningsToday = {
              date: today,
              currentHour,
              cumulative: trueHourly[String(currentHour)] ?? 0,
              byHour: trueHourly,
            };
          } else {
            // Diagnostic (warn, not log — Vercel's Runtime Logs only surface
            // warn/error/fatal). Safe to remove once this stops appearing.
            console.warn(
              `[glitchy-stats] hourlyEarningsFromEntries found no per-entry time info (entries=${entries.length}) — using the polled-snapshot fallback this cycle`
            );
            earningsToday = await earningsSnapshotToday(supabase, today, totals.total_earnings);
          }
        } catch (err) {
          console.error(`[glitchy-stats] daily history / earnings snapshot failed: ${err.message}`);
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
        // The Live Performance hourly chart uses `earningsToday` (combined
        // Glitchy+Mabac, snapshotted per NY hour — see above), not raw
        // per-entry data, so the raw entries themselves aren't sent here.
        earningsToday,
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
