// Daily Tracker auto-populate. Runs once a day (Vercel "crons" in vercel.json,
// Netlify "schedule" in netlify.toml) shortly after America/New_York midnight
// — same slot pattern as cleanup.js. Also safe to hit manually:
// GET/POST /.netlify/functions/tracker-run  (Vercel: /api/tracker-run).
//
// Targets YESTERDAY's NY date by default (a day that's already fully over),
// pulling TikTok's and Glitchy/Mabac's own historical numbers for that exact
// date — see _shared/tracker.js for why this doesn't depend on the dashboard
// having been open.
//
// Optional: set CRON_SECRET in the environment to require
//   Authorization: Bearer <CRON_SECRET>  on every call (same convention as cleanup.js).

const { getSupabase } = require("./_shared/tiktok-mcp");
const { populateTrackerTests } = require("./_shared/tracker");

exports.handler = async function (event) {
  if (process.env.CRON_SECRET) {
    const h = (event && event.headers) || {};
    const auth = h.authorization || h.Authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
    }
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  // Optional manual override for backfilling a specific past date:
  // POST { date: "YYYY-MM-DD" }.
  let targetDate = null;
  try {
    const body = JSON.parse(event.body || "{}");
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) targetDate = body.date;
  } catch (_) {
    /* GET (the cron) has no body — use the default (yesterday) */
  }

  try {
    const out = await populateTrackerTests(supabase, targetDate);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, ...out }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }) };
  }
};
