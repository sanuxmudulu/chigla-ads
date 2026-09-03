// WH Warmup — bulk Traffic-CBO warmup campaigns that auto-delete once Active.
//
// All TikTok writes go through the shared MCP client (server-side only). Reuses
// tiktok-mcp.js helpers; adds nothing to the normal campaign pipeline except a
// filter so WH campaign_ids never enter tiktok_campaigns.

const { mcpCall, loadCampaignDetail, deleteCampaign } = require("./tiktok-mcp");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// TikTok does NOT expose the minimum CBO daily budget through the MCP. USD $50/day
// is TikTok's documented Campaign Budget Optimization campaign daily minimum.
// Override per deployment with WH_WARMUP_DAILY_BUDGET if any Approved account is
// not USD and TikTok rejects $50 for its currency.
function whDailyBudget(_currency) {
  const v = Number(process.env.WH_WARMUP_DAILY_BUDGET);
  return Number.isFinite(v) && v > 0 ? v : 50;
}

// ---------------------------------------------------------------------------
// Random generators
// ---------------------------------------------------------------------------

const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));
function randSlug(n = 12) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
// Destination URL base. The path is a random slug; the URL only needs to be
// syntactically valid. Override with WH_WARMUP_URL_BASE (e.g. https://www.etsy.com)
// if TikTok rejects the bare host.
function whUrlBase() {
  return String(process.env.WH_WARMUP_URL_BASE || "https://etsy.com").replace(/\/+$/, "");
}
function whNames() {
  return {
    campaign: `Traffic${rand4()}`,
    adgroup: `AG${rand4()}`,
    ad: `AD${rand4()}`,
    url: `${whUrlBase()}/${randSlug()}/`,
  };
}
// 64-bit-ish integer string — campaign_create / adgroup_create idempotency + dup names.
const reqId = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");

// "now - 3h" as a UTC "YYYY-MM-DD HH:MM:SS" string. "3 hours ago" is the same
// instant in every timezone, and TikTok documents that schedule_start_time may
// be up to 12h in the past — so the ad group is immediately in-schedule and
// starts delivering right away, which is the intended warmup behaviour.
function startTimeMinus3h() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}
function startTimeNow() {
  return new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

const norm = (s) => String(s || "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Country -> TikTok location_id  (Traffic / Website / TikTok placement)
// ---------------------------------------------------------------------------

async function resolveCountryLocationId(client, advertiserId, countryName) {
  const q = norm(countryName);
  if (!q) throw new Error("No target country provided.");

  const d = await mcpCall(client, "tool_region_get", {
    advertiser_id: String(advertiserId),
    placements: ["PLACEMENT_TIKTOK"],
    objective_type: "TRAFFIC",
    promotion_type: "WEBSITE",
    level_range: "TO_COUNTRY",
  });

  const list = d?.region_info || d?.list || d?.locations || d?.region || [];
  const level = (r) => norm(r.level || r.location_level || "country");
  const countries = list.filter((r) => !r.level || /country|nation/.test(level(r)));
  const pool = countries.length ? countries : list;

  const code = (r) => norm(r.region_code || r.location_code || r.country_code || "");
  const nm = (r) => norm(r.name || r.location_name || r.region_name || "");

  const hit =
    pool.find((r) => nm(r) === q || code(r) === q) ||
    pool.find((r) => nm(r).includes(q) || q.includes(nm(r)));
  if (!hit) throw new Error(`Could not resolve a TikTok location for "${countryName}".`);

  const id = String(hit.location_id ?? hit.region_id ?? hit.id ?? "");
  if (!id) throw new Error(`TikTok location for "${countryName}" has no id.`);
  return { location_id: id, name: hit.name || countryName };
}

// ---------------------------------------------------------------------------
// Spark auth code -> { item_id, identity_id } for this advertiser
// ---------------------------------------------------------------------------

async function resolveSparkCode(client, advertiserId, rawCode) {
  const code = String(rawCode || "").trim().replace(/\+/g, "%2B");
  if (!code) throw new Error("No Spark code provided.");

  // 1. Put the creator's authorization into effect for this ad account.
  await mcpCall(client, "tt_video_authorize_apply", { advertiser_id: String(advertiserId), auth_code: code });

  // 2. Read the authorized post -> item_id.
  const info = await mcpCall(client, "tt_video_info_get", { advertiser_id: String(advertiserId), auth_code: code });
  const itemId = String(
    info?.item_id ?? info?.tiktok_item_id ?? info?.video_info?.item_id ?? info?.video?.item_id ?? ""
  );
  if (!itemId) throw new Error("Spark code did not resolve to a post.");

  // 3. Find the AUTH_CODE identity created/associated by the authorization.
  let identityId = String(info?.identity_id ?? info?.identity?.identity_id ?? "");
  if (!identityId) {
    const creator = norm(
      info?.username || info?.unique_id || info?.display_name || info?.nickname || info?.author_name
    );
    const ids = await mcpCall(client, "identity_get", {
      advertiser_id: String(advertiserId),
      identity_type: "AUTH_CODE",
      page_size: 100,
    });
    const idList = ids?.identity_list || ids?.list || [];
    const match = creator
      ? idList.find((x) => norm(x.display_name) === creator || norm(x.identity_id) === creator || norm(x.profile_name) === creator)
      : null;
    identityId = String((match || idList[idList.length - 1] || {}).identity_id || "");
  }
  if (!identityId) throw new Error("Spark code authorized but no AUTH_CODE identity was found for the ad account.");

  return { item_id: itemId, identity_id: identityId };
}

// ---------------------------------------------------------------------------
// Full create sequence for ONE advertiser. Throws on any failure; if a campaign
// was already created it is rolled back (best-effort) and the id is attached to
// the error as `.rolledBackCampaignId`.
// ---------------------------------------------------------------------------

async function createWarmupForAdvertiser({ client, advertiserId, currency, targetCountry, sparkCode }) {
  const names = whNames();
  const budget = whDailyBudget(currency);

  // Read-only resolutions FIRST — a bad country/Spark code creates nothing.
  const loc = await resolveCountryLocationId(client, advertiserId, targetCountry);
  const spark = await resolveSparkCode(client, advertiserId, sparkCode);

  let campaignId = null;
  try {
    // 1. Campaign — Traffic, CBO ON, daily budget.
    const camp = await mcpCall(client, "campaign_create", {
      advertiser_id: String(advertiserId),
      objective_type: "TRAFFIC",
      campaign_name: names.campaign,
      budget_optimize_on: true,
      budget_mode: "BUDGET_MODE_DAY",
      budget,
      operation_status: "ENABLE",
      request_id: reqId(),
    });
    campaignId = String(camp?.campaign_id || "");
    if (!campaignId) throw new Error("campaign_create returned no campaign_id.");

    // 2. Ad group — TikTok only, Website, Click optimization, no-bid, starts 3h ago.
    const agBody = {
      advertiser_id: String(advertiserId),
      campaign_id: campaignId,
      adgroup_name: names.adgroup,
      promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      location_ids: [loc.location_id],
      optimization_goal: "CLICK",
      billing_event: "CPC",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      budget_mode: "BUDGET_MODE_DAY", // ignored under CBO, still required by the endpoint
      budget, // ignored under CBO, still required
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: startTimeMinus3h(),
      operation_status: "ENABLE",
      request_id: reqId(),
    };
    let ag;
    let usedStart = agBody.schedule_start_time;
    try {
      ag = await mcpCall(client, "adgroup_create", agBody);
    } catch (err) {
      if (/schedul|start.?time|past|time.*earlier/i.test(err.message || "")) {
        agBody.schedule_start_time = startTimeNow();
        usedStart = agBody.schedule_start_time;
        ag = await mcpCall(client, "adgroup_create", agBody);
      } else {
        throw err;
      }
    }
    const adgroupId = String(ag?.adgroup_id || "");
    if (!adgroupId) throw new Error("adgroup_create returned no adgroup_id.");

    // 3. Spark ad — Learn More CTA, generated Etsy destination.
    const ad = await mcpCall(client, "ad_create", {
      advertiser_id: String(advertiserId),
      adgroup_id: adgroupId,
      creatives: [
        {
          ad_name: names.ad,
          ad_format: "SINGLE_VIDEO",
          identity_type: "AUTH_CODE",
          identity_id: spark.identity_id,
          tiktok_item_id: spark.item_id,
          call_to_action: "LEARN_MORE",
          landing_page_url: names.url,
          operation_status: "ENABLE",
        },
      ],
    });
    const adId = String((ad?.ad_ids || [])[0] || (ad?.creatives || [])[0]?.ad_id || "");

    return {
      campaign_id: campaignId,
      adgroup_id: adgroupId,
      ad_id: adId || null,
      campaign_name: names.campaign,
      destination_url: names.url,
      location_id: loc.location_id,
      target_country: targetCountry,
      spark_item_id: spark.item_id,
      daily_budget: budget,
      currency: currency || null,
      schedule_start_time: usedStart,
    };
  } catch (err) {
    if (campaignId) {
      try {
        await deleteCampaign({ client, advertiserId: String(advertiserId), campaignId });
      } catch (_) {
        /* leave the empty campaign; it has no ads so it will not spend */
      }
      err.rolledBackCampaignId = campaignId;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup — check one WH campaign's live status, delete it once genuinely Active.
// Idempotent: DELETED / FAILED rows are terminal and never passed here.
// Returns { status, patch } — patch is the fields to write back on the row.
// ---------------------------------------------------------------------------

const CLEANUP_ATTEMPT_CAP = 5;

async function cleanupOneWarmup({ client, row, advertiserStatus, timezone }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const now = new Date().toISOString();
  const deletedPatch = { cleanup_status: "DELETED", deleted_at: now, cleanup_error: null, updated_at: now };

  // 1. Does the campaign still exist, and is it already deleted on TikTok's side?
  try {
    const cr = await mcpCall(client, "campaign_get", {
      advertiser_id: advId,
      fields: ["campaign_id", "operation_status", "secondary_status"],
      filtering: { campaign_ids: [campaignId] },
    });
    const c = (cr?.list || []).find((x) => String(x.campaign_id) === campaignId);
    if (!c) return { status: "DELETED", patch: deletedPatch }; // gone
    if (/DELETE/i.test(String(c.secondary_status || c.operation_status || ""))) {
      return { status: "DELETED", patch: deletedPatch };
    }
  } catch (err) {
    if (/not exist|not found|no such|deleted/i.test(err.message || "")) {
      return { status: "DELETED", patch: deletedPatch };
    }
    return { status: row.cleanup_status, patch: { cleanup_error: err.message, updated_at: now } };
  }

  // 2. Derive the effective status to check for genuine "Active".
  let detail;
  try {
    detail = await loadCampaignDetail({
      client,
      advertiserId: advId,
      advertiserStatus,
      campaignId,
      timezone: timezone || null,
    });
  } catch (err) {
    if (/not exist|not found|no such|deleted/i.test(err.message || "")) {
      return { status: "DELETED", patch: deletedPatch };
    }
    return { status: row.cleanup_status, patch: { cleanup_error: err.message, updated_at: now } };
  }

  const label = String(detail.effective_status || "").toLowerCase();
  const advHealthyEarly = ["", "STATUS_ENABLE"].includes(String(advertiserStatus || "").toUpperCase());

  if (label === "deleted") return { status: "DELETED", patch: deletedPatch };

  if (label !== "active") {
    // The account is suspended/limited: the campaign can never go Active and we
    // can't delete it either — stop polling it.
    if (!advHealthyEarly || label.includes("suspend") || label.includes("punish")) {
      return {
        status: "FAILED",
        patch: {
          cleanup_status: "FAILED",
          cleanup_error: "Advertiser account is suspended — warmup campaign can neither go Active nor be deleted.",
          updated_at: now,
        },
      };
    }
    // In Review / Pending / Out of Budget … keep waiting, but give up after 3 days.
    const ageMs = Date.now() - Date.parse(row.created_at || now);
    if (ageMs > 3 * 24 * 3600 * 1000) {
      return {
        status: "FAILED",
        patch: {
          cleanup_status: "FAILED",
          cleanup_error: `Never reached Active after 3 days (last status: ${detail.effective_status}). Delete it manually in TikTok if needed.`,
          updated_at: now,
        },
      };
    }
    return { status: "WAITING_FOR_ACTIVE", patch: { updated_at: now } };
  }

  // It is genuinely Active — delete it.
  const patch = {
    cleanup_status: "DELETE_PENDING",
    updated_at: now,
  };
  if (!row.became_active_at) patch.became_active_at = now;

  const advHealthy = advHealthyEarly;

  try {
    await deleteCampaign({ client, advertiserId: advId, campaignId });
    return { status: "DELETED", patch: { ...patch, cleanup_status: "DELETED", deleted_at: now, cleanup_error: null } };
  } catch (err) {
    const msg = err.message || "delete failed";
    // Already gone -> success.
    if (/not exist|not found|no such|already.*delet/i.test(msg)) {
      return { status: "DELETED", patch: { ...patch, cleanup_status: "DELETED", deleted_at: now, cleanup_error: null } };
    }
    const attempts = Number(row.cleanup_attempts || 0) + 1;
    const giveUp = !advHealthy || attempts >= CLEANUP_ATTEMPT_CAP;
    return {
      status: giveUp ? "FAILED" : "DELETE_PENDING",
      patch: {
        ...patch,
        cleanup_status: giveUp ? "FAILED" : "DELETE_PENDING",
        cleanup_attempts: attempts,
        cleanup_error: giveUp
          ? `${msg} — giving up (${advHealthy ? `${attempts} attempts` : "advertiser account suspended"}).`
          : msg,
      },
    };
  }
}

module.exports = {
  whDailyBudget,
  whNames,
  resolveCountryLocationId,
  resolveSparkCode,
  createWarmupForAdvertiser,
  cleanupOneWarmup,
  CLEANUP_ATTEMPT_CAP,
};
