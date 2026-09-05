// Campaign Creator — auto-duplicate the initial ad group once it is Active.
//
// Reusable FOUNDATION. Rows come only from campaign-creator.js "register"
// (called by the future Campaign Creator tool). This processor never touches a
// campaign that isn't in campaign_creator_campaigns, so existing campaigns and
// WH Warmup campaigns are never duplicated.
//
// Idempotency: `dupe_created` is the source of truth and is persisted after
// EVERY successful copy. If the function crashes / times out mid-run, the next
// cycle resumes from `dupe_created` — it can never overshoot `dupe_target`.

const { mcpCall, loadCampaignDetail } = require("./tiktok-mcp");

const DUPES_PER_CYCLE = 5; // bounded work per 60s invocation (40 MCP calls for 20 would blow the timeout)
const DUPE_ATTEMPT_CAP = 5; // consecutive failed copy attempts before giving up
const GIVE_UP_AFTER_MS = 3 * 24 * 3600 * 1000; // never-Active after 3 days -> FAILED

const reqId = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const startMinus3h = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
const startNow = () => new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

// Read-only keys that must never be replayed into adgroup_create / ad_create.
const ADGROUP_STRIP = new Set([
  "adgroup_id", "adgroup_name", "request_id", "schedule_start_time", "schedule_end_time",
  "create_time", "secondary_status", "operation_status",
]);
const AD_STRIP = new Set(["ad_id", "ad_name", "create_time", "secondary_status", "operation_status"]);

function cleanPayload(obj, strip) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (!strip.has(k)) out[k] = v;
  return out;
}

// Process ONE campaign_creator_campaigns row. Returns { status, patch } — patch
// is the fields to write back. Bounded: creates at most DUPES_PER_CYCLE copies.
// `preloadedDetail` (optional): a loadCampaignDetail result the caller already
// fetched this cycle (the auto-appeal check does) — reused for the Active gate
// so we don't pull the same campaign detail twice per tick.
//
// Duplication is MANUAL (2026-09-05): reaching Active no longer auto-starts
// creating copies. WAITING_FOR_ACTIVE only ever advances to READY (ad group
// confirmed Active, sitting idle) — actual ad-group creation only happens for
// a row already in DUPLICATING, which is entered exclusively via the "Dupe"
// button's manual_dupe action (campaign-creator.js). This function still does
// ALL the actual TikTok work either way — the manual trigger just decides
// WHEN a row is allowed to reach the creation loop below, reusing this exact
// engine rather than a separate one.
async function duplicateForRow({ client, row, advertiserStatus, deadlineMs, preloadedDetail = null }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const target = Number(row.dupe_target) || 20;
  let created = Number(row.dupe_created) || 0;
  const now = () => new Date().toISOString();
  const advHealthy = ["", "STATUS_ENABLE"].includes(String(advertiserStatus || "").toUpperCase());

  if (created >= target && row.dupe_status !== "WAITING_FOR_ACTIVE" && row.dupe_status !== "READY") {
    return { status: "COMPLETE", patch: { dupe_status: "COMPLETE", completed_at: now(), updated_at: now() } };
  }

  // --- gate: initial ad group must be genuinely Active ---
  if (row.dupe_status === "WAITING_FOR_ACTIVE") {
    let detail = preloadedDetail;
    if (!detail) {
      try {
        detail = await loadCampaignDetail({
          client,
          advertiserId: advId,
          advertiserStatus,
          campaignId,
          timezone: null,
        });
      } catch (err) {
        return { status: "WAITING_FOR_ACTIVE", patch: { dupe_error: err.message, updated_at: now() } };
      }
    }
    const ag = (detail.adGroups || []).find((g) => String(g.adgroup_id) === String(row.initial_adgroup_id));
    const label = String(ag?.status_label || detail.effective_status || "").toLowerCase();

    if (label !== "active") {
      if (!advHealthy || label.includes("suspend") || label.includes("punish")) {
        return {
          status: "FAILED",
          patch: { dupe_status: "FAILED", dupe_error: "Advertiser account suspended — initial ad group can't go Active.", updated_at: now() },
        };
      }
      if (Date.now() - Date.parse(row.created_at || now()) > GIVE_UP_AFTER_MS) {
        return {
          status: "FAILED",
          patch: { dupe_status: "FAILED", dupe_error: `Initial ad group never reached Active after 3 days (last: ${ag?.status_label || detail.effective_status}).`, updated_at: now() },
        };
      }
      return { status: "WAITING_FOR_ACTIVE", patch: { updated_at: now() } };
    }

    // Genuinely Active — stop here. No automatic duplicate creation; sit at
    // READY until the user explicitly triggers "Dupe" (manual_dupe action).
    return {
      status: "READY",
      patch: { dupe_status: "READY", became_active_at: row.became_active_at || now(), updated_at: now(), dupe_error: null },
    };
  }

  // READY = Active, waiting for a manual trigger. Nothing to do on our own —
  // the periodic tick's own query normally excludes READY rows entirely, this
  // is just a safe no-op if it's ever called directly on one anyway.
  if (row.dupe_status === "READY") {
    return { status: "READY", patch: {} };
  }

  // --- DUPLICATING (manually triggered): create up to DUPES_PER_CYCLE copies,
  // persisting after each ---
  const patch = { dupe_status: "DUPLICATING", updated_at: now() };
  if (!row.became_active_at) patch.became_active_at = now();
  patch.dupe_created = created;

  const agBase = cleanPayload(row.adgroup_payload, ADGROUP_STRIP);
  const adBase = row.ad_payload ? cleanPayload(row.ad_payload, AD_STRIP) : null;

  // TikTok requires every ad group under the same CBO campaign to send the
  // EXACT optimization_event of the first ad group, even for objectives (like
  // LEAD_GENERATION/INSTANT_PAGE) where it's never required at create time —
  // TikTok just auto-assigns one internally (e.g. "FORM") and then enforces it
  // on every later ad group: "Please follow the same 'optimization_event' of
  // the first adgroup...". buildAdgroupPayload() now sets this explicitly for
  // new campaigns, but a row registered before that fix has no such key in its
  // stored adgroup_payload — self-heal by reading the LIVE value straight off
  // the real initial ad group (the authority) once per cycle, never guessed.
  if (!agBase.optimization_event) {
    try {
      const live = await mcpCall(client, "adgroup_get", {
        advertiser_id: advId,
        filtering: { adgroup_ids: [row.initial_adgroup_id] },
        fields: ["optimization_event"],
      });
      const ev = live?.list?.[0]?.optimization_event;
      if (ev) agBase.optimization_event = ev;
    } catch (_) {
      // best-effort — if this fails, adgroup_create's own rejection (if any)
      // still drives the normal per-copy retry/give-up path below.
    }
  }

  let madeThisCycle = 0;
  while (created < target && madeThisCycle < DUPES_PER_CYCLE) {
    if (Date.now() > deadlineMs) break;
    try {
      // Sequential naming: the original ad group is always "adg1"/"ad1"
      // (buildAdgroupPayload/buildAdCreative), so the Nth duplicate — the
      // (created)th one made so far, 0-indexed — is ad group/ad number
      // created+2 overall.
      const seq = created + 2;
      const agBody = {
        ...agBase,
        advertiser_id: advId,
        campaign_id: campaignId,
        adgroup_name: `adg${seq}`,
        schedule_type: "SCHEDULE_FROM_NOW",
        schedule_start_time: startMinus3h(),
        operation_status: "ENABLE",
        request_id: reqId(),
      };
      let ag;
      try {
        ag = await mcpCall(client, "adgroup_create", agBody);
      } catch (e) {
        if (/schedul|start.?time|past|time.*earlier/i.test(e.message || "")) {
          agBody.schedule_start_time = startNow();
          ag = await mcpCall(client, "adgroup_create", agBody);
        } else {
          throw e;
        }
      }
      const newAdgroupId = String(ag?.adgroup_id || "");
      if (!newAdgroupId) throw new Error("adgroup_create returned no adgroup_id");

      if (adBase) {
        await mcpCall(client, "ad_create", {
          advertiser_id: advId,
          adgroup_id: newAdgroupId,
          creatives: [{ ...adBase, ad_name: `ad${seq}`, operation_status: "ENABLE" }],
        });
      }

      created += 1;
      madeThisCycle += 1;
      patch.dupe_created = created;
      patch.dupe_error = null;
      patch.dupe_attempts = 0;
      // Persist the counter NOW so a later crash can't cause a re-do.
      await row.__persist(patch);
    } catch (err) {
      const attempts = Number(row.dupe_attempts || 0) + 1;
      const giveUp = !advHealthy || attempts >= DUPE_ATTEMPT_CAP;
      const out = {
        status: giveUp ? "FAILED" : "DUPLICATING",
        patch: {
          ...patch,
          dupe_status: giveUp ? "FAILED" : "DUPLICATING",
          dupe_attempts: attempts,
          dupe_error: `Copy ${created + 1}/${target} failed: ${err.message}${giveUp ? " — giving up." : ""}`,
        },
      };
      await row.__persist(out.patch);
      return out;
    }
  }

  if (created >= target) {
    const done = { ...patch, dupe_status: "COMPLETE", dupe_created: target, completed_at: now(), dupe_error: null };
    return { status: "COMPLETE", patch: done };
  }
  return { status: "DUPLICATING", patch };
}

// ---------------------------------------------------------------------------
// Registration — the ONE place a campaign is enrolled into the duplication +
// auto-appeal lifecycle. Used by campaign-creator.js "register" AND by the
// Campaign Creator tool (campaign-creator-run.js) right after it creates each
// campaign. Idempotent on campaign_id; refuses WH Warmup campaigns.
//
//   payload: { campaign_id, advertiser_id, connection_id, bc_id?, campaign_name?,
//              initial_adgroup_id, initial_ad_id?, adgroup_payload, ad_payload?,
//              dupe_target?:20 }
//   -> { ok:true } | { ok:true, already:true } | { error, code }
// ---------------------------------------------------------------------------
async function registerForDuplication(supabase, payload) {
  const campaignId = String(payload.campaign_id || "");
  const advertiserId = String(payload.advertiser_id || "");
  const connectionId = payload.connection_id;
  const initialAdgroupId = String(payload.initial_adgroup_id || "");
  if (!campaignId || !advertiserId || !connectionId || !initialAdgroupId) {
    return { error: "campaign_id, advertiser_id, connection_id and initial_adgroup_id are required", code: 400 };
  }
  if (!payload.adgroup_payload || typeof payload.adgroup_payload !== "object") {
    return { error: "adgroup_payload (the exact adgroup_create args) is required", code: 400 };
  }

  try {
    const { data: wh } = await supabase
      .from("wh_warmup_campaigns")
      .select("campaign_id")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (wh) return { error: "That campaign is a WH Warmup campaign and cannot be duplicated.", code: 400 };
  } catch (_) {
    /* table missing — fine */
  }

  const { data: existing } = await supabase
    .from("campaign_creator_campaigns")
    .select("campaign_id")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (existing) return { ok: true, already: true };

  const target =
    Number.isFinite(Number(payload.dupe_target)) && Number(payload.dupe_target) > 0 ? Number(payload.dupe_target) : 20;

  const { error } = await supabase.from("campaign_creator_campaigns").insert({
    campaign_id: campaignId,
    advertiser_id: advertiserId,
    connection_id: connectionId,
    bc_id: payload.bc_id || null,
    campaign_name: payload.campaign_name || null,
    initial_adgroup_id: initialAdgroupId,
    initial_ad_id: payload.initial_ad_id ? String(payload.initial_ad_id) : null,
    adgroup_payload: payload.adgroup_payload,
    ad_payload: payload.ad_payload || null,
    dupe_target: target,
    dupe_status: "WAITING_FOR_ACTIVE",
    updated_at: new Date().toISOString(),
  });
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return { error: "campaign_creator_campaigns isn't migrated yet. Run supabase/campaign_creator.sql.", code: 500 };
    }
    return { error: `Could not register the campaign: ${error.message}`, code: 500 };
  }
  return { ok: true };
}

module.exports = { duplicateForRow, registerForDuplication, DUPES_PER_CYCLE, DUPE_ATTEMPT_CAP };
