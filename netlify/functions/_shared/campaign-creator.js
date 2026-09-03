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

const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));
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
async function duplicateForRow({ client, row, advertiserStatus, deadlineMs }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const target = Number(row.dupe_target) || 20;
  let created = Number(row.dupe_created) || 0;
  const now = () => new Date().toISOString();
  const advHealthy = ["", "STATUS_ENABLE"].includes(String(advertiserStatus || "").toUpperCase());

  if (created >= target) {
    return { status: "COMPLETE", patch: { dupe_status: "COMPLETE", completed_at: now(), updated_at: now() } };
  }

  // --- gate: initial ad group must be genuinely Active ---
  if (row.dupe_status === "WAITING_FOR_ACTIVE") {
    let detail;
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
  }

  // --- Active: create up to DUPES_PER_CYCLE copies, persisting after each ---
  const patch = { dupe_status: "DUPLICATING", updated_at: now() };
  if (!row.became_active_at) patch.became_active_at = now();
  patch.dupe_created = created;

  const agBase = cleanPayload(row.adgroup_payload, ADGROUP_STRIP);
  const adBase = row.ad_payload ? cleanPayload(row.ad_payload, AD_STRIP) : null;

  let madeThisCycle = 0;
  while (created < target && madeThisCycle < DUPES_PER_CYCLE) {
    if (Date.now() > deadlineMs) break;
    try {
      const agBody = {
        ...agBase,
        advertiser_id: advId,
        campaign_id: campaignId,
        adgroup_name: `AG${rand4()}`,
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
          creatives: [{ ...adBase, ad_name: `AD${rand4()}`, operation_status: "ENABLE" }],
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

module.exports = { duplicateForRow, DUPES_PER_CYCLE, DUPE_ATTEMPT_CAP };
