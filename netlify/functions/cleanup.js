// Daily Supabase retention job.
//
// Runs once per day (Vercel "crons" in vercel.json, Netlify "schedule" in
// netlify.toml) shortly after America/New_York midnight. Also safe to hit
// manually: GET /.netlify/functions/cleanup  (Vercel: /api/cleanup).
//
// It ONLY deletes provably-stale TEMPORARY rows. It never touches:
//   - daily_totals            (permanent Profit Calendar history)
//   - tiktok_oauth_client      (kept indefinitely, incl. the old Netlify row)
//   - any campaign/connection identity row
//
// Optional: set CRON_SECRET in the environment to require
//   Authorization: Bearer <CRON_SECRET>  on every call.

const { supabaseClient, todayEst } = require("./_shared/glitchy-daily");

// Retention windows (single, simple rules).
const WH_TERMINAL_DAYS = 7; // wh_warmup_campaigns rows in DELETED / FAILED
const ENGAGEMENT_DONE_DAYS = 30; // engagement_orders in COMPLETED / FAILED
const SNAPSHOT_DAYS = 14; // tiktok_spend_snapshots (Live Performance graph)
const OAUTH_TX_MINUTES = 20; // abandoned PKCE auth transactions

exports.handler = async function (event) {
  if (process.env.CRON_SECRET) {
    const h = (event && event.headers) || {};
    const auth = h.authorization || h.Authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
    }
  }

  const supabase = supabaseClient();
  if (!supabase) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" }) };
  }

  const nyToday = todayEst();
  const day = 86400000;
  const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
  const dateAgo = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 10);
  const out = { ok: true, ny_date: nyToday, purged: {}, errors: {} };

  // 1. WH Warmup — terminal rows only. WAITING_FOR_ACTIVE / DELETE_PENDING are
  //    never eligible (they're still being monitored).
  await run(out, "wh_warmup_terminal", () =>
    supabase
      .from("wh_warmup_campaigns")
      .delete({ count: "exact" })
      .in("cleanup_status", ["DELETED", "FAILED"])
      .lt("updated_at", isoAgo(WH_TERMINAL_DAYS * day))
  );

  // 2. engagement_orders — finished operational records. READY / SUBMITTED
  //    (pending) are kept. A future comment-TEMPLATE feature is a separate
  //    table and is unaffected by this.
  await run(out, "engagement_orders_done", () =>
    supabase
      .from("engagement_orders")
      .delete({ count: "exact" })
      .in("status", ["COMPLETED", "FAILED"])
      .lt("updated_at", isoAgo(ENGAGEMENT_DONE_DAYS * day))
  );

  // 3. OAuth transactions — abandoned PKCE rows (belt for tiktok-auth-start's
  //    sweep, which only runs on a new connect).
  await run(out, "oauth_transactions", () =>
    supabase
      .from("tiktok_oauth_transactions")
      .delete({ count: "exact" })
      .lt("created_at", isoAgo(OAUTH_TX_MINUTES * 60000))
  );

  // 4. Hourly spend snapshots — belt for recordSpendSnapshot's own purge.
  await run(out, "spend_snapshots", () =>
    supabase.from("tiktok_spend_snapshots").delete({ count: "exact" }).lt("date", dateAgo(SNAPSHOT_DAYS * day))
  );

  // 5. Stale campaign day-metrics — a campaign whose today_* belongs to a past
  //    NY date must read $0 today until its TikTok report reloads. Never deletes
  //    the campaign row; just resets the reporting fields and re-dates them.
  await run(out, "stale_today_metrics", () =>
    supabase
      .from("tiktok_campaigns")
      .update(
        {
          today_date: nyToday,
          today_spend: 0,
          today_impressions: 0,
          today_clicks: 0,
          today_conversions: 0,
          today_cpm: 0,
          today_cpa: 0,
        },
        { count: "exact" }
      )
      .not("today_date", "is", null)
      .neq("today_date", nyToday)
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out),
  };
};

async function run(out, name, build) {
  try {
    const { error, count } = await build();
    if (error) {
      // "table/column does not exist" just means a migration hasn't been run —
      // not a failure for a best-effort cleanup.
      if (/does not exist|schema cache|could not find/i.test(error.message || "")) return;
      out.errors[name] = error.message;
      return;
    }
    out.purged[name] = typeof count === "number" ? count : null;
  } catch (err) {
    out.errors[name] = err.message;
  }
}
