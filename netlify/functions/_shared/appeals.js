// Automatic TikTok ad-rejection appeals.
//
// Scope: Campaign Creator campaigns ONLY (rows in campaign_creator_campaigns),
// during their initial review lifecycle (dupe_status WAITING_FOR_ACTIVE). Driven
// by the existing ~60s campaign-creator.js "process_duplication" cycle — no new
// polling system. WH Warmup campaigns are a separate table and are never
// registered here, so they can never be auto-appealed.
//
// Lifecycle (appeal_state on the row):
//   NONE -> REJECTED -> APPEAL_SUBMITTING -> APPEAL_UNDER_REVIEW -> APPEAL_APPROVED
//                                                               \-> APPEAL_REJECTED
//   REJECTED -> UNSUPPORTED   (rejected for a reason we have no template for)
//
// CRITICAL: a rejection is auto-appealed AT MOST ONCE. `appeal_attempted` is a
// one-way latch set only after adgroup_appeal succeeds; once true no second
// automatic appeal is ever sent. A technical MCP/HTTP failure keeps the row in
// REJECTED (retried up to APPEAL_TECH_RETRY_CAP) and never marks it
// APPEAL_REJECTED — only TikTok's own decision does that.

const { mcpCall, loadCampaignDetail } = require("./tiktok-mcp");

const APPEAL_TECH_RETRY_CAP = 4; // consecutive technical failures of adgroup_appeal before giving up
const GIVE_UP_AFTER_MS = 3 * 24 * 3600 * 1000; // never appeal a row older than the duplication give-up

// ---------------------------------------------------------------------------
// Appeal-text construction
// ---------------------------------------------------------------------------

const COMMON_INTRO =
  "Hi my ad was wrongly disapproved, I follow all guidelines and TOS and make sure all content is compliant with TikTok and safe for the platform, please fix this.";
const COMMON_ENDING = "This ad follows all the TOS.";

// canonical reason id -> its unique middle section (null => intro + ending only)
const REASON_MIDDLE = {
  sensitive_personal_information: "My ad doesn't request any sensitive personal information.",
  adult_content_services:
    "My ads don't promote any adult content or services. The images, hooks, and audio used in this ad follows all TikTok TOS.",
  financial_misrepresentation:
    "My ads dont make any financial misrepresentation. The method implied is clearly explained in the website. The images, hooks, and audio used in this ad follows all TikTok TOS. It is just written in a tiktok-style slang so users resonate to it. Nothing wrong or deceptive has been promoted.",
  misleading_opportunities:
    "My ad doesnt make any misleading opportunity. The method implied is clearly explained in the website. The images, hooks, and audio used in this ad follows all TikTok TOS. It is just written in a tiktok-style slang so users resonate to it. Nothing wrong or deceptive has been promoted.",
  gambling_and_games: null,
};

// Deterministic ordering — the canonical numbered list from the spec.
const REASON_ORDER = [
  "sensitive_personal_information",
  "adult_content_services",
  "financial_misrepresentation",
  "misleading_opportunities",
  "gambling_and_games",
];

// Build ONE clean appeal string: common intro once, each matched reason's unique
// middle at most once in canonical order, common ending once. No double spaces.
function buildAppealText(categories) {
  const set = new Set(categories || []);
  const parts = [COMMON_INTRO];
  for (const id of REASON_ORDER) {
    if (set.has(id) && REASON_MIDDLE[id]) parts.push(REASON_MIDDLE[id]);
  }
  parts.push(COMMON_ENDING);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Reason normalization — conservative. A wrong match sends the wrong appeal, so
// we require the distinctive phrase and tolerate only casing / punctuation /
// singular-plural. Anything else is "unknown" and blocks the auto appeal.
// ---------------------------------------------------------------------------

function matchReason(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;

  if (/sensitive personal information/.test(s)) return "sensitive_personal_information";
  if (/personal information/.test(s) && /(photo|post|image|sensitive)/.test(s))
    return "sensitive_personal_information";

  if (/adult content/.test(s) || /adult services?/.test(s)) return "adult_content_services";

  if (/financial misrepresentation/.test(s)) return "financial_misrepresentation";

  if (/misleading opportunit(y|ies)/.test(s)) return "misleading_opportunities";

  if (/gambling and games/.test(s) || /\bgambling\b/.test(s)) return "gambling_and_games";

  return null;
}

// raw reason strings -> { categories: [canonical ids], unknown: [raw strings] }
// deduped; categories in canonical order.
function classifyReasons(rawReasons) {
  const seen = new Set();
  const categories = [];
  const unknown = [];
  const unknownSeen = new Set();
  for (const raw of rawReasons || []) {
    const id = matchReason(raw);
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        categories.push(id);
      }
    } else {
      const key = String(raw || "").trim().toLowerCase();
      if (key && !unknownSeen.has(key)) {
        unknownSeen.add(key);
        unknown.push(String(raw).trim());
      }
    }
  }
  categories.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
  return { categories, unknown };
}

// ---------------------------------------------------------------------------
// MCP reads — ad-level rejection info is the source of truth
// ---------------------------------------------------------------------------

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

// Extract human rejection strings from one ad/review_info list item. `reject_info`
// is an object[] in v1.3 (was a single object in v1.2); shapes vary, so probe
// the common text keys and any nested reason lists.
function rejectStringsFromAdItem(item) {
  const out = [];
  for (const r of asArray(item && item.reject_info)) {
    if (typeof r === "string") {
      out.push(r);
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const t =
      r.reject_reason || r.reason || r.message || r.reject_reason_text || r.desc || r.reject_description;
    if (t) out.push(String(t));
    for (const sub of asArray(r.reject_reasons || r.reasons || r.sub_reasons)) {
      if (typeof sub === "string") out.push(sub);
      else if (sub && (sub.reason || sub.reject_reason)) out.push(String(sub.reason || sub.reject_reason));
    }
  }
  return out;
}

async function fetchInitialAdgroupReview(client, advertiserId, adgroupId) {
  try {
    const r = await mcpCall(client, "adgroup_review_info_get", {
      advertiser_id: String(advertiserId),
      adgroup_ids: [String(adgroupId)],
    });
    const map = (r && r.ad_group_review_map) || {};
    return map[String(adgroupId)] || null;
  } catch (_) {
    return null;
  }
}

// Real ad ids for the campaign's initial ad group. Prefer the id we recorded at
// creation, then ad_get, then the review map as a last resort.
async function resolveInitialAdIds(client, advertiserId, adgroupId, knownAdId, review) {
  const ids = new Set();
  if (knownAdId) ids.add(String(knownAdId));
  if (!ids.size) {
    try {
      const g = await mcpCall(client, "ad_get", {
        advertiser_id: String(advertiserId),
        filtering: { adgroup_ids: [String(adgroupId)] },
        fields: ["ad_id", "operation_status", "secondary_status"],
        page_size: 100,
      });
      for (const a of (g && g.list) || []) if (a && a.ad_id) ids.add(String(a.ad_id));
    } catch (_) {
      /* fall through to the review map */
    }
  }
  if (!ids.size) {
    for (const k of Object.keys((review && review.ad_review_map) || {})) ids.add(String(k));
  }
  return [...ids];
}

// Ad-level rejection reasons for the initial ad group.
// -> { raw: [strings], rejectedAdIds: [ids], error: string|null }
async function fetchAdLevelReasons(client, advertiserId, adIds) {
  if (!adIds.length) return { raw: [], rejectedAdIds: [], error: null };
  let list;
  try {
    const ri = await mcpCall(client, "ad_review_info_get", {
      advertiser_id: String(advertiserId),
      ad_ids: adIds.slice(0, 100),
    });
    list = (ri && ri.list) || [];
  } catch (err) {
    return { raw: [], rejectedAdIds: [], error: err.message };
  }
  const raw = [];
  const rejectedAdIds = [];
  for (const item of list) {
    if (!item || item.is_approved === true) continue;
    const strings = rejectStringsFromAdItem(item);
    if (strings.length) {
      raw.push(...strings);
      if (item.ad_id) rejectedAdIds.push(String(item.ad_id));
    } else if (item.is_approved === false && item.ad_id) {
      rejectedAdIds.push(String(item.ad_id));
    }
  }
  return { raw, rejectedAdIds, error: null };
}

// ---------------------------------------------------------------------------
// Appeal-status interpretation
// ---------------------------------------------------------------------------

function appealStatusApproved(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return /(APPROVE|APPROVED|PASS|PASSED|SUCCEED|SUCCESS)/.test(s) && !/(NOT|UN|NO_)/.test(s);
}
function appealStatusRejected(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return /(REJECT|FAIL|DENY|DENIED|DECLIN|NOT_APPROVE|NOT_PASS)/.test(s);
}
function appealStatusIsSomeAppeal(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return false;
  return !/(NO_APPEAL|NOT_APPEALED|NONE|NOT_APPEAL)/.test(s);
}

// ---------------------------------------------------------------------------
// Orchestrator — called once per WAITING_FOR_ACTIVE row per ~60s cycle.
//
// Returns { blockDuplication, detail }:
//   blockDuplication true  -> caller must NOT run the 20x duplication this tick
//                             (rejected / appeal under review / appeal rejected)
//   detail                 -> the loadCampaignDetail result (reused by the
//                             caller for status persistence + duplicateForRow)
// ---------------------------------------------------------------------------

async function handleAutoAppeal({ supabase, client, row, advertiserStatus }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const adgroupId = String(row.initial_adgroup_id || "");
  const state = row.appeal_state || "NONE";
  const now = () => new Date().toISOString();
  const log = (msg) => console.log(`[appeals] ${campaignId} — ${msg}`);
  const persist = (patch) => patchAppeal(supabase, campaignId, { ...patch, appeal_updated_at: now() });

  // Terminal appeal states — no more MCP work, just tell the caller whether to
  // hold duplication.
  if (state === "APPEAL_APPROVED") return { blockDuplication: false, detail: null };
  if (state === "APPEAL_REJECTED") return { blockDuplication: true, detail: null };
  if (state === "UNSUPPORTED") return { blockDuplication: true, detail: null };
  if (!adgroupId) return { blockDuplication: false, detail: null };

  // Current live state of the campaign / initial ad group.
  let detail;
  try {
    detail = await loadCampaignDetail({
      client,
      advertiserId: advId,
      advertiserStatus,
      campaignId,
      timezone: null,
    });
  } catch (_) {
    return { blockDuplication: false, detail: null }; // let duplicateForRow surface it
  }
  const ag = (detail.adGroups || []).find((g) => String(g.adgroup_id) === adgroupId);
  const label = String((ag ? ag.status_label : detail.effective_status) || "").toLowerCase();

  // ---- recovered / approved ----
  if (label === "active") {
    if (state === "APPEAL_UNDER_REVIEW" || state === "APPEAL_SUBMITTING") {
      await persist({ appeal_state: "APPEAL_APPROVED" });
      log("appeal approved / campaign active");
    }
    return { blockDuplication: false, detail };
  }

  // ---- advertiser suspended / punished — not an appeal case ----
  if (label.includes("suspend") || label.includes("punish") || label.includes("account")) {
    return { blockDuplication: false, detail };
  }

  // ---- an appeal is already in flight: poll TikTok's decision ----
  if (state === "APPEAL_UNDER_REVIEW" || state === "APPEAL_SUBMITTING") {
    const review = await fetchInitialAdgroupReview(client, advId, adgroupId);
    const appealStatus = (review && review.appeal_status) || "";
    if (appealStatusApproved(appealStatus)) {
      await persist({ appeal_state: "APPEAL_APPROVED" });
      log(`appeal approved (appeal_status=${appealStatus})`);
      return { blockDuplication: false, detail };
    }
    if (appealStatusRejected(appealStatus)) {
      await persist({ appeal_state: "APPEAL_REJECTED" });
      log(`appeal rejected by TikTok (appeal_status=${appealStatus})`);
      return { blockDuplication: true, detail };
    }
    return { blockDuplication: true, detail }; // still pending
  }

  // ---- state is NONE or REJECTED ----
  const rejectedNow = label === "rejected" || detail.effective_status === "Rejected";
  if (!rejectedNow) {
    return { blockDuplication: true, detail }; // pending / in review — wait, don't appeal
  }

  // Hard idempotency latch — one successful automatic appeal per lifecycle, ever.
  if (row.appeal_attempted) return { blockDuplication: true, detail };

  // Belt for the duplication processor's 3-day give-up: never appeal an old row.
  if (row.created_at && Date.now() - Date.parse(row.created_at) > GIVE_UP_AFTER_MS) {
    return { blockDuplication: true, detail };
  }

  // Technical-retry cap already hit — stay Rejected, stop calling adgroup_appeal.
  if (Number(row.appeal_attempts || 0) >= APPEAL_TECH_RETRY_CAP) {
    return { blockDuplication: true, detail };
  }

  // ---- fetch AD-LEVEL rejection reasons (source of truth) ----
  const review = await fetchInitialAdgroupReview(client, advId, adgroupId);
  const adIds = await resolveInitialAdIds(client, advId, adgroupId, row.initial_ad_id, review);
  const adLevel = await fetchAdLevelReasons(client, advId, adIds);
  log(`ad review info fetched — adIds=${adIds.length} rawReasons=${adLevel.raw.length}`);

  let rawReasons = adLevel.raw.slice();
  let source = "ad";
  if (!rawReasons.length && review) {
    // Last resort — ad-group-level reject_info (still review data, never campaign
    // status). Logged distinctly so we know the ad-level read came back empty.
    for (const r of asArray(review.reject_info)) {
      if (typeof r === "string") rawReasons.push(r);
      else if (r && (r.reject_reason || r.reason)) rawReasons.push(String(r.reject_reason || r.reason));
    }
    if (rawReasons.length) source = "adgroup";
  }
  rawReasons = [...new Set(rawReasons.map((s) => String(s).trim()).filter(Boolean))];

  if (!rawReasons.length) {
    // No ad rejection information obtained — never appeal on campaign status alone.
    log(
      `rejection detected but NO ad-level reason available yet` +
        (adLevel.error ? ` (ad_review_info_get: ${adLevel.error})` : "") +
        ` — not appealing`
    );
    await persist({
      appeal_state: "REJECTED",
      appeal_adgroup_id: adgroupId,
      appeal_error: adLevel.error
        ? `ad_review_info_get failed: ${adLevel.error}`
        : "No ad-level rejection reason returned yet",
    });
    return { blockDuplication: true, detail };
  }

  const { categories, unknown } = classifyReasons(rawReasons);
  log(
    `rejection detected — raw=${JSON.stringify(rawReasons)} ` +
      `normalized=${JSON.stringify(categories)} source=${source}`
  );

  const appealAdId =
    (adLevel.rejectedAdIds && adLevel.rejectedAdIds[0]) ||
    (row.initial_ad_id ? String(row.initial_ad_id) : null) ||
    adIds[0] ||
    null;

  // Unknown reason (or a mix where some are unknown) — conservative: do NOT
  // auto-appeal; record it so a template can be added later.
  if (unknown.length || !categories.length) {
    log(
      `unsupported rejection reason(s): ${JSON.stringify(unknown.length ? unknown : rawReasons)} ` +
        `— leaving rejected, NOT appealing`
    );
    await persist({
      appeal_state: "UNSUPPORTED",
      appeal_raw_reasons: rawReasons,
      appeal_reasons: categories,
      appeal_adgroup_id: adgroupId,
      appeal_ad_id: appealAdId,
      appeal_error: `Unsupported rejection reason: ${(unknown.length ? unknown : rawReasons).join(" | ")}`,
    });
    return { blockDuplication: true, detail };
  }

  // ---- claim the appeal (idempotent) then submit exactly ONE ----
  // Conditional UPDATE: succeeds for at most one concurrent invocation and only
  // while appeal_attempted is still false. A row wedged in APPEAL_SUBMITTING by a
  // crash is recovered by isStaleSubmitting() in the caller (reset to REJECTED).
  const claim = await supabase
    .from("campaign_creator_campaigns")
    .update({ appeal_state: "APPEAL_SUBMITTING", appeal_updated_at: now() })
    .eq("campaign_id", campaignId)
    .eq("appeal_attempted", false)
    .neq("appeal_state", "APPEAL_SUBMITTING")
    .select("campaign_id");
  if (claim.error || !(claim.data && claim.data.length)) {
    return { blockDuplication: true, detail }; // another invocation owns it this tick
  }

  const appealText = buildAppealText(categories);
  await persist({
    appeal_raw_reasons: rawReasons,
    appeal_reasons: categories,
    appeal_text: appealText,
    appeal_adgroup_id: adgroupId,
    appeal_ad_id: appealAdId,
  });
  log(`appeal submission started — ad_id=${appealAdId || "-"} text="${appealText}"`);

  const appealArgs = { advertiser_id: advId, adgroup_id: adgroupId, appeal_reason: appealText };
  if (appealAdId) appealArgs.ad_id = appealAdId;

  try {
    await mcpCall(client, "adgroup_appeal", appealArgs);
  } catch (err) {
    // Did the appeal actually land despite the error (e.g. "already appealed")?
    const after = await fetchInitialAdgroupReview(client, advId, adgroupId);
    const as = (after && after.appeal_status) || "";
    if (appealStatusIsSomeAppeal(as)) {
      await persist({
        appeal_attempted: true,
        appeal_state: appealStatusRejected(as) ? "APPEAL_REJECTED" : "APPEAL_UNDER_REVIEW",
        appeal_submitted_at: now(),
        appeal_error: null,
      });
      log(`adgroup_appeal errored but appeal_status=${as} — treating as submitted`);
      return { blockDuplication: true, detail };
    }
    // Genuine technical failure — DO NOT mark Appeal Rejected. Retry next tick.
    const attempts = Number(row.appeal_attempts || 0) + 1;
    await persist({
      appeal_state: "REJECTED",
      appeal_attempts: attempts,
      appeal_error: `Appeal request failed (attempt ${attempts}/${APPEAL_TECH_RETRY_CAP}): ${err.message}`,
    });
    log(`appeal technical failure (attempt ${attempts}/${APPEAL_TECH_RETRY_CAP}): ${err.message}`);
    return { blockDuplication: true, detail };
  }

  await persist({
    appeal_attempted: true,
    appeal_state: "APPEAL_UNDER_REVIEW",
    appeal_submitted_at: now(),
    appeal_error: null,
  });
  log("appeal accepted / submitted — now Appeal Under Review");
  return { blockDuplication: true, detail };
}

// Best-effort persist. A missing column just means the migration
// (supabase/campaign_creator_appeals.sql) hasn't been run yet — logged once, not
// fatal (the feature simply stays dormant).
async function patchAppeal(supabase, campaignId, patch) {
  try {
    const { error } = await supabase
      .from("campaign_creator_campaigns")
      .update(patch)
      .eq("campaign_id", String(campaignId));
    if (error) {
      if (/appeal_|column .* does not exist|schema cache/i.test(error.message || "")) {
        console.error(
          `[appeals] ${campaignId} — appeal columns not migrated; run supabase/campaign_creator_appeals.sql (${error.message})`
        );
      } else {
        console.error(`[appeals] ${campaignId} — persist failed: ${error.message}`);
      }
    }
  } catch (err) {
    console.error(`[appeals] ${campaignId} — persist crashed: ${err.message}`);
  }
}

// A row stuck in APPEAL_SUBMITTING (crash between claim and result) older than
// this is reset to REJECTED so the appeal can be retried. Called by the caller
// before the per-row loop.
const STALE_SUBMITTING_MS = 5 * 60 * 1000;
function isStaleSubmitting(row) {
  return (
    row &&
    row.appeal_state === "APPEAL_SUBMITTING" &&
    !row.appeal_attempted &&
    (!row.appeal_updated_at || Date.now() - Date.parse(row.appeal_updated_at) > STALE_SUBMITTING_MS)
  );
}

module.exports = {
  handleAutoAppeal,
  isStaleSubmitting,
  buildAppealText,
  matchReason,
  classifyReasons,
  COMMON_INTRO,
  COMMON_ENDING,
  REASON_MIDDLE,
  REASON_ORDER,
  APPEAL_TECH_RETRY_CAP,
};
