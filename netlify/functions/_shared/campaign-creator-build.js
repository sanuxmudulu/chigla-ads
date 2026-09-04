// Campaign Creator — template normalization + per-advertiser resource lookups +
// the full "create ONE campaign for ONE advertiser" sequence.
//
// Everything TikTok-facing goes through the shared MCP client (server-side only).
// The create sequence mirrors _shared/wh-warmup.js (campaign -> ad group -> Spark
// ad, rollback on failure) and produces the exact adgroup_create / ad_create
// payloads so the EXISTING duplication foundation (_shared/campaign-creator.js)
// can replay them for the 20 extra ad groups.
//
// Manual campaigns only (never smart_plus_*). Spark Ads Pull. Placement = TikTok
// only. Video sharing + downloading disabled. No interests/behaviours.

const { mcpCall, deleteCampaign } = require("./tiktok-mcp");
const { resolveSparkCode } = require("./wh-warmup");

// ---------------------------------------------------------------------------
// Enums / constants — TikTok's real values
// ---------------------------------------------------------------------------

const TEMPLATE_TYPES = ["LEAD_GENERATION", "SALES"];

// Adult age brackets (AGE_13_17 is deliberately never exposed).
const AGE_GROUPS = ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"];
const AGE_LABELS = {
  AGE_18_24: "18–24",
  AGE_25_34: "25–34",
  AGE_35_44: "35–44",
  AGE_45_54: "45–54",
  AGE_55_100: "55+",
};

const GENDERS = ["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"];
const GENDER_LABELS = { GENDER_UNLIMITED: "All", GENDER_MALE: "Male", GENDER_FEMALE: "Female" };

// Curated single-select CTA values (TikTok's exact enum tokens). `creative_cta_recommend_get`
// can return more, but these are the safe, always-valid ones for website / lead ads.
const CTA_VALUES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD_NOW",
  "INSTALL_NOW",
  "PLAY_GAME",
  "ORDER_NOW",
  "CONTACT_US",
  "BOOK_NOW",
  "APPLY_NOW",
  "GET_QUOTE",
  "READ_MORE",
  "VIEW_NOW",
  "SUBSCRIBE",
];
const DEFAULT_CTA = "LEARN_MORE";

// Interactive Card (TikTok "Display Card") image spec.
const CARD_IMAGE_W = 750;
const CARD_IMAGE_H = 421;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const reqId = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));

// ---------------------------------------------------------------------------
// Template config normalization (stored in campaign_creator_templates.config)
// ---------------------------------------------------------------------------

function normalizeTemplateConfig(raw) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};

  const cbo = c.cbo === undefined ? true : !!c.cbo;
  const daily = num(c.daily_budget);
  if (!(daily > 0)) errors.push("Enter a daily campaign budget greater than 0.");

  let locationIds = Array.isArray(c.location_ids) ? c.location_ids.map(String).filter(Boolean) : [];
  let locationLabels = Array.isArray(c.location_labels) ? c.location_labels.map(String) : [];
  locationIds = [...new Set(locationIds)];
  if (!locationIds.length) errors.push("Pick at least one target location.");

  let ages = Array.isArray(c.age_groups) ? c.age_groups.filter((a) => AGE_GROUPS.includes(a)) : [];
  ages = [...new Set(ages)];
  if (!ages.length) ages = AGE_GROUPS.slice(); // default: all adult brackets
  // canonical order
  ages.sort((a, b) => AGE_GROUPS.indexOf(a) - AGE_GROUPS.indexOf(b));

  const gender = GENDERS.includes(c.gender) ? c.gender : "GENDER_UNLIMITED";
  const cta = CTA_VALUES.includes(c.cta) ? c.cta : DEFAULT_CTA;
  const adText = typeof c.ad_text === "string" ? c.ad_text.trim().slice(0, 100) : "";

  const cardRaw = c.interactive_card && typeof c.interactive_card === "object" ? c.interactive_card : {};
  const card = {
    enabled: !!cardRaw.enabled,
    image_url: typeof cardRaw.image_url === "string" ? cardRaw.image_url.trim() : "",
  };
  if (card.enabled && !card.image_url) {
    errors.push("Interactive Card is on but no image link was provided.");
  }

  return {
    errors,
    config: {
      cbo,
      daily_budget: Math.round(daily * 100) / 100,
      location_ids: locationIds,
      location_labels: locationLabels.slice(0, locationIds.length),
      age_groups: ages,
      gender,
      cta,
      ad_text: adText,
      interactive_card: card,
    },
  };
}

// ---------------------------------------------------------------------------
// Timezone: interpret a wall-clock HH:MM in an advertiser's IANA tz -> UTC.
// One-iteration offset solve (accurate outside the ~1h DST transition window,
// which never matters for "a few hours from now").  Returns a Date.
// ---------------------------------------------------------------------------

function tzParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== "literal") p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
  };
}

function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - date.getTime(); // ms the zone is ahead of UTC at this instant
}

// The next instant at which the wall clock in `timeZone` reads hour:minute and
// which is >= now. Returns { utc: Date, localLabel: "YYYY-MM-DD HH:MM" }.
function nextLocalClockUtc(hour, minute, timeZone) {
  const now = new Date();
  const nowLocal = tzParts(now, timeZone);
  for (let addDays = 0; addDays <= 2; addDays++) {
    // wall-clock target on day (today + addDays) in the zone
    const base = Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + addDays, hour, minute, 0);
    // solve for the UTC instant whose zone rendering equals that wall clock
    let guess = base - tzOffsetMs(new Date(base), timeZone);
    guess = base - tzOffsetMs(new Date(guess), timeZone); // second pass
    if (guess >= now.getTime() - 60 * 1000) {
      const d = new Date(guess);
      return { utc: d, localLabel: fmtLocal(d, timeZone) };
    }
  }
  const d = new Date(Date.now() + 3600 * 1000);
  return { utc: d, localLabel: fmtLocal(d, timeZone) };
}

function fmtLocal(date, timeZone) {
  const p = tzParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// "YYYY-MM-DD HH:MM:SS" UTC — the format adgroup_create wants.
function toApiUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------------
// Interactive Card image: normalize (Google Drive) -> fetch -> validate 750x421
// -> re-host on Supabase Storage so TikTok always gets a clean image URL.
// ---------------------------------------------------------------------------

const CARD_BUCKET = process.env.CAMPAIGN_ASSETS_BUCKET || "campaign-creator-assets";

function driveDirectUrl(url) {
  const s = String(url || "").trim();
  // https://drive.google.com/file/d/<ID>/view?...   or  ...open?id=<ID>  or  uc?id=<ID>
  let id = null;
  let m = s.match(/\/file\/d\/([-\w]{20,})/);
  if (m) id = m[1];
  if (!id) {
    m = s.match(/[?&]id=([-\w]{20,})/);
    if (m) id = m[1];
  }
  if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  return s; // not a Drive link — use as-is
}

// Minimal PNG / JPEG / GIF dimension reader (no dependencies).
function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: "png" };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: "gif" };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      const len = buf.readUInt16BE(off + 2);
      if (isSOF) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), type: "jpeg" };
      }
      off += 2 + len;
    }
  }
  return null;
}

async function fetchImage(url) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 ChiglaAds" } });
  } catch (err) {
    throw new Error(`could not download the image (${err.message})`);
  }
  if (!res.ok) throw new Error(`image link returned HTTP ${res.status}`);
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) throw new Error("image is larger than 12 MB");

  if (!ct.startsWith("image/")) {
    // Google Drive sometimes serves an HTML interstitial for larger files.
    const head = buf.slice(0, 400).toString("utf8").toLowerCase();
    if (/<html|<!doctype/.test(head)) {
      const m = head.match(/confirm=([0-9a-z_-]+)/i);
      if (m && /drive\.google/.test(url)) {
        return fetchImage(`${url}&confirm=${m[1]}`);
      }
    }
    // Fall through: still try to read dimensions from the bytes.
  }
  return { buf, contentType: ct.startsWith("image/") ? ct : null };
}

// Resolves a template's interactive-card image link to a clean public URL TikTok
// can fetch. -> { url, rehosted, warning }. Throws only on hard validation
// failures (wrong dimensions / not an image) so nothing is created.
async function resolveCardImageUrl(rawUrl, { supabase }) {
  const direct = driveDirectUrl(rawUrl);
  const { buf, contentType } = await fetchImage(direct);

  const dim = imageDimensions(buf);
  if (!dim) throw new Error("that link is not a PNG or JPEG image");
  if (dim.width !== CARD_IMAGE_W || dim.height !== CARD_IMAGE_H) {
    throw new Error(
      `Interactive Card image must be exactly ${CARD_IMAGE_W}×${CARD_IMAGE_H} px (got ${dim.width}×${dim.height}).`
    );
  }

  const ext = dim.type === "jpeg" ? "jpg" : dim.type;
  const mime = contentType || `image/${dim.type === "jpg" ? "jpeg" : dim.type}`;

  // Stable path from the source URL so re-using the same link across launches
  // reuses the same stored object.
  const crypto = require("node:crypto");
  const key = crypto.createHash("sha1").update(String(rawUrl)).digest("hex").slice(0, 20);
  const path = `interactive-cards/${key}.${ext}`;

  try {
    const up = await supabase.storage.from(CARD_BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: true,
      cacheControl: "31536000",
    });
    if (up.error) throw up.error;
    const pub = supabase.storage.from(CARD_BUCKET).getPublicUrl(path);
    const publicUrl = pub?.data?.publicUrl;
    if (!publicUrl) throw new Error("no public URL");
    return { url: publicUrl, rehosted: true, warning: null };
  } catch (err) {
    // Bucket missing / storage disabled — fall back to the direct link.
    return {
      url: direct,
      rehosted: false,
      warning: `Could not re-host the card image (${err.message || "storage unavailable"}); using the direct link. Create a public Storage bucket named "${CARD_BUCKET}" for reliability.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-advertiser resource lookups (used by the run function's "resources" action)
// ---------------------------------------------------------------------------

function pagesFrom(resp) {
  const list = resp?.list || resp?.page_list || resp?.pages || (Array.isArray(resp) ? resp : []);
  return (list || [])
    .map((p) => {
      const id = String(p.page_id ?? p.id ?? p.instant_page_id ?? "");
      if (!id) return null;
      const name = String(p.title || p.name || p.page_name || p.instant_page_name || id).trim();
      const t = p.create_time || p.created_time || p.create_at || p.created_at || null;
      const mt = p.modify_time || p.update_time || p.modified_time || null;
      return { page_id: id, name, create_time: t, modify_time: mt };
    })
    .filter(Boolean);
}

async function listInstantForms(client, advertiserId) {
  const d = await mcpCall(client, "page_get", {
    advertiser_id: String(advertiserId),
    business_type: "LEAD_GEN",
    status: "PUBLISHED",
    page_size: 100,
  });
  return pagesFrom(d).map((p) => ({ id: p.page_id, name: p.name }));
}

async function listInstantPages(client, advertiserId) {
  const d = await mcpCall(client, "page_get", {
    advertiser_id: String(advertiserId),
    business_type: "TIKTOK_INSTANT_PAGE",
    status: "PUBLISHED",
    page_size: 100,
  });
  return pagesFrom(d);
}

// Most-recently-created published Instant Page for an advertiser.
// -> { page_id, name } | { error }
function newestInstantPage(pages) {
  if (!pages || !pages.length) return { error: "no published TikTok Instant Page in this account" };
  const withTime = pages.filter((p) => p.create_time || p.modify_time);
  if (!withTime.length) {
    return { error: "TikTok returned no creation time for the Instant Pages, so the newest one can't be picked automatically" };
  }
  const ts = (p) => {
    const raw = p.create_time || p.modify_time;
    const n = Date.parse(String(raw).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(raw)) ? "" : "Z"));
    return Number.isFinite(n) ? n : 0;
  };
  const best = withTime.slice().sort((a, b) => ts(b) - ts(a))[0];
  return { page_id: best.page_id, name: best.name };
}

async function listBcIdentities(client, advertiserId, bcId) {
  const args = { advertiser_id: String(advertiserId), page_size: 100 };
  if (bcId) {
    args.identity_type = "BC_AUTH_TT";
    args.identity_authorized_bc_id = String(bcId);
  }
  let d;
  try {
    d = await mcpCall(client, "identity_get", args);
  } catch (_) {
    // Retry without the BC filter (account may not have a BC-authorized identity).
    d = await mcpCall(client, "identity_get", { advertiser_id: String(advertiserId), page_size: 100 });
  }
  const list = d?.identity_list || d?.list || [];
  return list
    .map((x) => ({
      identity_id: String(x.identity_id || ""),
      identity_type: x.identity_type || (bcId ? "BC_AUTH_TT" : "TT_USER"),
      name: String(x.display_name || x.profile_name || x.nickname || x.identity_id || "").trim(),
    }))
    .filter((x) => x.identity_id);
}

// Instant Page conversion events for the Sales objective. -> { goal, events } | { error }
async function instantPageConversion(client, advertiserId) {
  try {
    const d = await mcpCall(client, "pixel_instant_page_event_get", {
      advertiser_id: String(advertiserId),
      objective_type: "CONVERSIONS",
      optimization_goal: "CONVERT",
    });
    const goals = d?.optimization_goals || d?.optimize_goals || [];
    const eventsRaw = d?.optimization_events || d?.external_actions || d?.events || [];
    const events = (eventsRaw || [])
      .map((e) => (typeof e === "string" ? e : e.optimization_event || e.external_action || e.event || e.value))
      .filter(Boolean)
      .map(String);
    if (!events.length) return { error: "no Instant Page conversion events are available for this account" };
    const goal = Array.isArray(goals) && goals.length && !goals.includes("CONVERT") ? String(goals[0]) : "CONVERT";
    return { goal, events };
  } catch (err) {
    return { error: `Instant Page conversion events unavailable (${err.message})` };
  }
}

async function ensureLeadAdsTerm(client, advertiserId) {
  try {
    const chk = await mcpCall(client, "term_check", { advertiser_id: String(advertiserId), term_type: "LeadAds" });
    const signed = chk?.is_signed ?? chk?.signed ?? chk?.has_signed ?? chk?.confirmed;
    if (signed === true) return { ok: true };
  } catch (_) {
    /* fall through to confirm */
  }
  try {
    await mcpCall(client, "term_confirm", { advertiser_id: String(advertiserId), term_type: "LeadAds" });
    return { ok: true, justSigned: true };
  } catch (err) {
    // Already signed / concurrently signed — not an error for our purposes.
    if (/already|signed|confirmed|exist/i.test(err.message || "")) return { ok: true };
    throw new Error(`Could not accept TikTok's Lead Ads terms for this account: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildCampaignPayload({ advertiserId, campaignName, type, config }) {
  const p = {
    advertiser_id: String(advertiserId),
    campaign_name: campaignName,
    objective_type: type === "SALES" ? "WEB_CONVERSIONS" : "LEAD_GENERATION",
    budget_mode: "BUDGET_MODE_DAY",
    budget: num(config.daily_budget),
    operation_status: "ENABLE",
    request_id: reqId(),
  };
  if (config.cbo !== false) p.budget_optimize_on = true;
  if (type === "SALES") {
    p.virtual_objective_type = "SALES";
    p.sales_destination = "WEBSITE";
  }
  return p;
}

function buildAdgroupPayload({ advertiserId, campaignId, type, config, scheduleUtc, sales }) {
  const p = {
    advertiser_id: String(advertiserId),
    campaign_id: String(campaignId),
    adgroup_name: `AG${rand4()}`,
    placement_type: "PLACEMENT_TYPE_NORMAL",
    placements: ["PLACEMENT_TIKTOK"],
    location_ids: config.location_ids.slice(),
    age_groups: config.age_groups.slice(),
    gender: config.gender,
    // no interests / behaviours — broad targeting
    budget_mode: "BUDGET_MODE_DAY",
    budget: num(config.daily_budget), // ignored under CBO, still required by the endpoint
    schedule_type: "SCHEDULE_FROM_NOW",
    schedule_start_time: toApiUtc(scheduleUtc),
    billing_event: "OCPM",
    bid_type: "BID_TYPE_NO_BID", // Highest Volume / Lowest Cost
    pacing: "PACING_MODE_SMOOTH",
    operation_status: "ENABLE",
    // sharing + downloading OFF
    share_disabled: true,
    video_download_disabled: true,
    comment_disabled: false,
    request_id: reqId(),
  };

  if (type === "SALES") {
    p.promotion_type = "WEBSITE";
    p.promotion_website_type = "TIKTOK_NATIVE_PAGE"; // TikTok Instant Page
    p.optimization_goal = sales?.goal || "CONVERT";
    if (sales?.event) p.optimization_event = sales.event;
  } else {
    p.promotion_type = "LEAD_GENERATION";
    p.promotion_target_type = "INSTANT_PAGE"; // TikTok Instant Form
    p.optimization_goal = "LEAD_GENERATION";
  }
  return p;
}

function buildAdCreative({ type, config, identity, sparkItemId, pageId, cardId, adFormat }) {
  const creative = {
    ad_name: `AD${rand4()}`,
    ad_format: adFormat, // SINGLE_VIDEO | CAROUSEL_ADS
    identity_type: identity.identity_type,
    identity_id: identity.identity_id,
    tiktok_item_id: String(sparkItemId), // Spark Ads Pull
    call_to_action: config.cta || DEFAULT_CTA,
    operation_status: "ENABLE",
  };
  if (identity.identity_type === "BC_AUTH_TT" && identity.identity_authorized_bc_id) {
    creative.identity_authorized_bc_id = String(identity.identity_authorized_bc_id);
  }
  if (config.ad_text) creative.ad_text = config.ad_text;
  if (pageId != null && pageId !== "") {
    // page_id is a numeric id in TikTok's schema; keep it a string unless it is
    // safely representable, so very large ids never lose precision.
    const n = Number(pageId);
    creative.page_id = Number.isSafeInteger(n) ? n : String(pageId);
  }
  if (cardId) creative.card_id = String(cardId);
  return creative;
}

// ---------------------------------------------------------------------------
// Create ONE campaign for ONE advertiser. Throws on any failure (campaign rolled
// back best-effort, id attached as err.rolledBackCampaignId).
//
// Returns everything the caller needs to register the campaign for duplication
// + to store its post URL.
// ---------------------------------------------------------------------------

const SCHEDULE_ERR = /schedul|start.?time|past|time.*earlier|future/i;
const FORMAT_MISMATCH = /photo post|carousel ad|can be delivered|ad_format|single[_ ]video|video post|not a (photo|video)|must be a (photo|video)/i;
const CARD_REJECT = /card|portfolio|display card|add[- ]?on|interactive/i;

async function createOneCampaign({
  client,
  supabase,
  advertiser, // { advertiser_id, advertiser_name, bc_id, timezone }
  connectionId,
  bcId,
  type, // 'LEAD_GENERATION' | 'SALES'
  config, // normalized template config
  campaignName,
  scheduleHour,
  scheduleMinute,
  sparkCode,
  postUrl,
  identity, // { identity_id, identity_type }
  formId, // Lead Gen: chosen Instant Form id
  salesEvent, // Sales: chosen Instant Page conversion event
  cardImageUrl, // resolved public URL when interactive card enabled, else null
}) {
  const advId = String(advertiser.advertiser_id);
  const tz = advertiser.timezone || advertiser.display_timezone || "America/New_York";
  const warnings = [];

  // ---- read-only resolutions FIRST (nothing is created until these pass) ----
  if (type === "LEAD_GENERATION") {
    await ensureLeadAdsTerm(client, advId);
  }

  const spark = await resolveSparkCode(client, advId, sparkCode); // { item_id, identity_id, post_type }

  let pageId = null;
  let pageName = null;
  let sales = null;
  if (type === "SALES") {
    const pages = await listInstantPages(client, advId);
    const newest = newestInstantPage(pages);
    if (newest.error) throw new Error(`Instant Page: ${newest.error}`);
    pageId = newest.page_id;
    pageName = newest.name;
    const conv = await instantPageConversion(client, advId);
    if (conv.error) throw new Error(`Sales optimization: ${conv.error}`);
    const event = salesEvent && conv.events.includes(salesEvent) ? salesEvent : conv.events[0];
    sales = { goal: conv.goal, event };
  } else {
    // Lead Gen — the caller validated the form exists for this advertiser.
    pageId = String(formId);
    pageName = null;
  }

  const identityWithBc = {
    ...identity,
    identity_authorized_bc_id: identity.identity_type === "BC_AUTH_TT" ? String(bcId || advertiser.bc_id || "") : undefined,
  };

  // ---- interactive card (best-effort — never blocks the campaign) ----
  let cardId = null;
  if (config.interactive_card && config.interactive_card.enabled && cardImageUrl) {
    try {
      const img = await mcpCall(client, "file_image_ad_upload", {
        advertiser_id: advId,
        upload_type: "UPLOAD_BY_URL",
        image_url: cardImageUrl,
        file_name: `cc_card_${rand4()}_${Date.now()}`,
      });
      const imageId = String(img?.image_id || img?.id || "");
      if (!imageId) throw new Error("no image_id returned");
      const portfolio = await mcpCall(client, "creative_portfolio_create", {
        advertiser_id: advId,
        creative_portfolio_type: "CARD",
        portfolio_content: [{ card_type: "IMAGE", image_id: imageId }],
      });
      cardId = String(
        portfolio?.creative_portfolio_id || portfolio?.card_id || portfolio?.portfolio_id || portfolio?.id || ""
      );
      if (!cardId) throw new Error("no portfolio id returned");
    } catch (err) {
      cardId = null;
      warnings.push(`Interactive Card not attached (${err.message}).`);
    }
  }

  const scheduleLocal = nextLocalClockUtc(scheduleHour, scheduleMinute, tz);

  let campaignId = null;
  try {
    // 1. campaign
    const campPayload = buildCampaignPayload({ advertiserId: advId, campaignName, type, config });
    const camp = await mcpCall(client, "campaign_create", campPayload);
    campaignId = String(camp?.campaign_id || "");
    if (!campaignId) throw new Error("campaign_create returned no campaign_id");

    // 2. ad group
    const agPayload = buildAdgroupPayload({
      advertiserId: advId,
      campaignId,
      type,
      config,
      scheduleUtc: scheduleLocal.utc,
      sales,
    });
    let ag;
    try {
      ag = await mcpCall(client, "adgroup_create", agPayload);
    } catch (err) {
      if (SCHEDULE_ERR.test(err.message || "")) {
        const soon = new Date(Date.now() + 5 * 60 * 1000);
        agPayload.schedule_start_time = toApiUtc(soon);
        scheduleLocal.localLabel = fmtLocal(soon, tz) + " (adjusted — chosen time was in the past)";
        ag = await mcpCall(client, "adgroup_create", agPayload);
      } else {
        throw err;
      }
    }
    const adgroupId = String(ag?.adgroup_id || "");
    if (!adgroupId) throw new Error("adgroup_create returned no adgroup_id");

    // 3. Spark ad (photo posts -> CAROUSEL_ADS, video -> SINGLE_VIDEO; retry the
    //    other format, and retry without the card if TikTok rejects it).
    const firstFormat = spark.post_type === "CAROUSEL" ? "CAROUSEL_ADS" : "SINGLE_VIDEO";
    const otherFormat = firstFormat === "CAROUSEL_ADS" ? "SINGLE_VIDEO" : "CAROUSEL_ADS";
    const makeCreative = (fmt, withCard) =>
      buildAdCreative({
        type,
        config,
        identity: identityWithBc,
        sparkItemId: spark.item_id,
        pageId,
        cardId: withCard ? cardId : null,
        adFormat: fmt,
      });

    const tryAd = async (fmt, withCard) =>
      mcpCall(client, "ad_create", { advertiser_id: advId, adgroup_id: adgroupId, creatives: [makeCreative(fmt, withCard)] });

    let ad;
    let usedCard = !!cardId;
    try {
      ad = await tryAd(firstFormat, usedCard);
    } catch (err) {
      const msg = err.message || "";
      if (usedCard && CARD_REJECT.test(msg)) {
        usedCard = false;
        warnings.push(`Interactive Card rejected by TikTok (${msg}) — ad created without it.`);
        try {
          ad = await tryAd(firstFormat, false);
        } catch (err2) {
          if (!FORMAT_MISMATCH.test(err2.message || "")) throw err2;
          ad = await tryAd(otherFormat, false);
        }
      } else if (FORMAT_MISMATCH.test(msg)) {
        try {
          ad = await tryAd(otherFormat, usedCard);
        } catch (err2) {
          if (usedCard && CARD_REJECT.test(err2.message || "")) {
            usedCard = false;
            warnings.push(`Interactive Card rejected by TikTok — ad created without it.`);
            ad = await tryAd(otherFormat, false);
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
    const adId = String((ad?.ad_ids || [])[0] || (ad?.creatives || [])[0]?.ad_id || "");
    if (!adId) throw new Error("ad_create returned no ad_id");

    const adFormatUsed = firstFormat; // recorded on the payload below
    const adgroupPayloadStored = { ...agPayload };
    const adPayloadStored = makeCreative(adFormatUsed, usedCard);
    adPayloadStored.ad_name = ""; // duplication regenerates this

    return {
      campaign_id: campaignId,
      adgroup_id: adgroupId,
      ad_id: adId,
      campaign_name: campaignName,
      adgroup_payload: adgroupPayloadStored,
      ad_payload: adPayloadStored,
      post_url: postUrl,
      instant_page_name: pageName,
      instant_form_id: type === "LEAD_GENERATION" ? String(formId) : null,
      schedule_local: scheduleLocal.localLabel,
      schedule_tz: tz,
      warnings,
    };
  } catch (err) {
    if (campaignId) {
      try {
        await deleteCampaign({ client, advertiserId: advId, campaignId });
      } catch (_) {
        /* an empty campaign with no ads never spends */
      }
      err.rolledBackCampaignId = campaignId;
    }
    throw err;
  }
}

module.exports = {
  TEMPLATE_TYPES,
  AGE_GROUPS,
  AGE_LABELS,
  GENDERS,
  GENDER_LABELS,
  CTA_VALUES,
  DEFAULT_CTA,
  CARD_IMAGE_W,
  CARD_IMAGE_H,
  CARD_BUCKET,
  normalizeTemplateConfig,
  nextLocalClockUtc,
  fmtLocal,
  resolveCardImageUrl,
  driveDirectUrl,
  imageDimensions,
  listInstantForms,
  listInstantPages,
  newestInstantPage,
  listBcIdentities,
  instantPageConversion,
  ensureLeadAdsTerm,
  buildCampaignPayload,
  buildAdgroupPayload,
  buildAdCreative,
  createOneCampaign,
};
