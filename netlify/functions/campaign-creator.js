// POST /.netlify/functions/campaign-creator   { action, ... }   (Vercel: /api/campaign-creator)
//
//   "register"  { campaign_id, advertiser_id, connection_id, bc_id?, campaign_name?,
//                 initial_adgroup_id, initial_ad_id?, adgroup_payload, ad_payload?, dupe_target?:20 }
//        -> record a Campaign-Creator campaign so its initial ad group is
//           auto-duplicated once Active. No-op if campaign_id already registered.
//           (Called by the future Campaign Creator tool — nothing else writes here.)
//
//   "process_duplication"  (no body)
//        -> for every registered campaign still WAITING_FOR_ACTIVE / DUPLICATING:
//           if the initial ad group is genuinely Active, create up to
//           DUPES_PER_CYCLE more copies of it (default target 20). Idempotent.
//           Driven by the existing ~60s dashboard refresh AND by a scheduler
//           (see below) for when the dashboard is closed.
//
//   "retry"  { campaign_id }
//        -> un-stick a row stuck in dupe_status FAILED (dupe_created < dupe_target)
//           by resetting it back to DUPLICATING (if its initial ad group already
//           went Active) or WAITING_FOR_ACTIVE (if not), clearing dupe_attempts/
//           dupe_error so the NEXT process_duplication pass picks it back up.
//           dupe_created (progress so far) is never touched — a retry always
//           resumes, never restarts, so it can never exceed dupe_target.
//
//   "list"  -> registered campaigns + duplication state (monitoring)
//
// No admin password (same posture as the other tiktok-* write actions). All MCP
// calls run here; no tokens are ever returned to the browser.
//
// SCHEDULER: a bare GET to this route (no body) also runs process_duplication —
// this is what a Vercel Cron Job invokes (Vercel cron sends GET, never POST;
// see vercel.json "crons"). Netlify's own scheduled function invocation still
// arrives as a bodyless POST (see netlify.toml "schedule") and is handled
// exactly as before. If CRON_SECRET is set in the environment, a GET must carry
// `Authorization: Bearer <CRON_SECRET>` — Vercel adds that header automatically
// for its own cron invocations once CRON_SECRET is set (same convention as
// cleanup.js); a manual GET without it is rejected.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  json,
} = require("./_shared/tiktok-mcp");
const { duplicateForRow, registerForDuplication, DUPES_PER_CYCLE } = require("./_shared/campaign-creator.js");
const { handleAutoAppeal, isStaleSubmitting } = require("./_shared/appeals.js");

async function withClient(supabase, connection, fn) {
  const { serverUrl, redirectUrl } = resolveConfig();
  const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection });
  const { client } = await connectMcp({ provider, serverUrl });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    // Scheduler entry point (Vercel Cron -> GET; see header comment).
    if (event.httpMethod === "GET") {
      if (process.env.CRON_SECRET) {
        const h = (event && event.headers) || {};
        const auth = h.authorization || h.Authorization || "";
        if (auth !== `Bearer ${process.env.CRON_SECRET}`) return json(401, { error: "unauthorized" });
      }
      return processDuplication(supabase);
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET (cron) or POST" });
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    if (body.action === "register") return register(supabase, body);
    if (body.action === "retry") return retryFailed(supabase, body);
    if (body.action === "list") return listRows(supabase);
    // "process_duplication" (dashboard 60s poll) OR a Netlify scheduled
    // invocation (no recognizable action, e.g. body {"next_run":"..."}) — both
    // just run the safe, idempotent duplication pass.
    if (body.action === "process_duplication" || !body.action) return processDuplication(supabase);

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------

async function register(supabase, body) {
  const r = await registerForDuplication(supabase, body);
  if (r.error) return json(r.code || 500, { error: r.error });
  return json(200, { ok: true, ...(r.already ? { already: true } : {}) });
}

async function retryFailed(supabase, body) {
  const campaignId = String(body.campaign_id || "");
  if (!campaignId) return json(400, { error: "campaign_id is required" });

  const { data: row, error } = await supabase
    .from("campaign_creator_campaigns")
    .select("campaign_id, dupe_status, dupe_created, dupe_target, became_active_at")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (error) return json(500, { error: "Supabase read failed", details: sbErr(error) });
  if (!row) return json(404, { error: "Campaign not found in campaign_creator_campaigns." });
  if (row.dupe_status !== "FAILED") {
    return json(400, { error: `Only a FAILED row can be retried (this one is ${row.dupe_status}).` });
  }
  if ((Number(row.dupe_created) || 0) >= (Number(row.dupe_target) || 20)) {
    return json(400, { error: "This row already reached its dupe_target — nothing to retry." });
  }

  const nextStatus = row.became_active_at ? "DUPLICATING" : "WAITING_FOR_ACTIVE";
  const patch = {
    dupe_status: nextStatus,
    dupe_attempts: 0,
    dupe_error: null,
    updated_at: new Date().toISOString(),
  };
  const upd = await supabase.from("campaign_creator_campaigns").update(patch).eq("campaign_id", campaignId);
  if (upd.error) return json(500, { error: "Retry failed", details: sbErr(upd.error) });
  return json(200, { ok: true, campaign_id: campaignId, dupe_status: nextStatus, dupe_created: row.dupe_created });
}

// ---------------------------------------------------------------------------

async function processDuplication(supabase) {
  const { data: rows, error } = await supabase
    .from("campaign_creator_campaigns")
    .select("*")
    .in("dupe_status", ["WAITING_FOR_ACTIVE", "DUPLICATING"]);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0, unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  if (!rows || !rows.length) return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0 });

  const byConnection = {};
  for (const r of rows) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);

  const tally = { checked: 0, created: 0, completed: 0, failed: 0, pending: 0 };
  const deadlineMs = Date.now() + 45000; // this endpoint gets maxDuration 60 on Vercel

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadlineMs) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      for (const r of list) {
        await patchRow(supabase, r.campaign_id, { dupe_status: "FAILED", dupe_error: "Connection removed.", updated_at: new Date().toISOString() });
        tally.failed += 1;
      }
      continue;
    }

    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advStatus = new Map((advRows || []).map((a) => [String(a.advertiser_id), a.status]));

    // Recover any row wedged in APPEAL_SUBMITTING by a crash between claim and
    // result — reset to REJECTED so the appeal can be retried. Never clears
    // appeal_attempted, so a successful appeal is still never repeated.
    for (const r of list) {
      if (isStaleSubmitting(r)) {
        await patchRow(supabase, r.campaign_id, {
          appeal_state: "REJECTED",
          appeal_updated_at: new Date().toISOString(),
        });
        r.appeal_state = "REJECTED";
        console.log(`[appeals] ${r.campaign_id} — stale APPEAL_SUBMITTING reset to REJECTED`);
      }
    }

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadlineMs) break;
          tally.checked += 1;
          const before = Number(r.dupe_created) || 0;
          r.__persist = (patch) => patchRow(supabase, r.campaign_id, patch);

          // ---- AUTO REJECTION APPEAL (initial review lifecycle only) ----
          // Runs before duplication so a rejected / appealing campaign is never
          // duplicated. Reuses its loadCampaignDetail result for the Active gate.
          let preloadedDetail = null;
          if (r.dupe_status === "WAITING_FOR_ACTIVE") {
            let appeal;
            try {
              appeal = await handleAutoAppeal({
                supabase,
                client,
                row: r,
                advertiserStatus: advStatus.get(String(r.advertiser_id)),
              });
            } catch (err) {
              console.error(`[appeals] ${r.campaign_id} — orchestrator failed: ${err.message}`);
              appeal = { blockDuplication: true, detail: null };
            }
            preloadedDetail = appeal.detail || null;
            // Keep the Detailed Metrics status current for creator campaigns
            // (the 60s "metrics" tick doesn't re-derive status).
            if (preloadedDetail) await persistTiktokCampaignStatus(supabase, r.campaign_id, preloadedDetail);
            if (appeal.blockDuplication) {
              await patchRow(supabase, r.campaign_id, { updated_at: new Date().toISOString() });
              tally.pending += 1;
              continue;
            }
          }

          const beforeStatus = r.dupe_status;
          let out;
          try {
            out = await duplicateForRow({
              client,
              row: r,
              advertiserStatus: advStatus.get(String(r.advertiser_id)),
              deadlineMs,
              preloadedDetail,
            });
          } catch (err) {
            console.error(`[campaign-creator] ${r.campaign_id} failed: ${err.message}`);
            continue;
          }
          await patchRow(supabase, r.campaign_id, out.patch);
          const createdNow = Math.max(0, (Number(out.patch.dupe_created) || before) - before);
          tally.created += createdNow;
          const afterStatus = out.patch.dupe_status || out.status;
          if (afterStatus !== beforeStatus) {
            console.log(`[campaign-creator] ${r.campaign_id} — ${beforeStatus} -> ${afterStatus}`);
          }
          if (out.status === "COMPLETE") {
            tally.completed += 1;
            console.log(`[campaign-creator] ${r.campaign_id} — COMPLETE (${out.patch.dupe_created || Number(r.dupe_target) || 20}/${Number(r.dupe_target) || 20} ad groups)`);
          } else if (out.status === "FAILED") {
            tally.failed += 1;
            console.log(`[campaign-creator] ${r.campaign_id} — FAILED: ${out.patch.dupe_error || "unknown"}`);
          } else {
            tally.pending += 1;
            if (createdNow > 0) {
              console.log(`[campaign-creator] ${r.campaign_id} — DUPLICATING (${out.patch.dupe_created}/${Number(r.dupe_target) || 20})`);
            }
          }
        }
      });
    } catch (err) {
      console.error(`[campaign-creator] connection ${connectionId} failed: ${err.message}`);
    }
  }

  return json(200, { ok: true, ...tally, dupes_per_cycle: DUPES_PER_CYCLE });
}

async function patchRow(supabase, campaignId, patch) {
  try {
    await supabase.from("campaign_creator_campaigns").update(patch).eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[campaign-creator] patch ${campaignId} failed: ${err.message}`);
  }
}

// Refresh a campaign's derived status on its tiktok_campaigns row from a
// loadCampaignDetail result. Best-effort — the "metrics" 60s tick doesn't
// re-derive status, so this keeps a creator campaign's Detailed Metrics badge
// current while it moves through review / appeal / Active.
async function persistTiktokCampaignStatus(supabase, campaignId, detail) {
  if (!detail || !detail.effective_status) return;
  try {
    await supabase
      .from("tiktok_campaigns")
      .update({
        campaign_operation_status: detail.campaign_operation_status,
        campaign_secondary_status: detail.campaign_secondary_status,
        effective_status: detail.effective_status,
        effective_tone: detail.effective_tone,
        status_detail: detail.status_detail,
        ad_count: detail.ad_count,
        active_ad_count: detail.active_ad_count,
        updated_at: new Date().toISOString(),
      })
      .eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[campaign-creator] status persist ${campaignId} failed: ${err.message}`);
  }
}

async function listRows(supabase) {
  const BASE =
    "campaign_id, advertiser_id, campaign_name, initial_adgroup_id, dupe_target, dupe_created, dupe_status, dupe_attempts, dupe_error, became_active_at, completed_at, created_at";
  const APPEAL =
    ", appeal_state, appeal_attempted, appeal_attempts, appeal_raw_reasons, appeal_reasons, appeal_text, appeal_ad_id, appeal_adgroup_id, appeal_submitted_at, appeal_error, appeal_updated_at";

  let { data, error } = await supabase
    .from("campaign_creator_campaigns")
    .select(BASE + APPEAL)
    .order("created_at", { ascending: false })
    .limit(200);

  // Appeal columns not migrated yet — fall back to the base columns.
  if (error && /appeal_|column .* does not exist/i.test(error.message || "")) {
    ({ data, error } = await supabase
      .from("campaign_creator_campaigns")
      .select(BASE)
      .order("created_at", { ascending: false })
      .limit(200));
  }
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, campaigns: [], unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  return json(200, { ok: true, campaigns: data || [] });
}
