// POST /.netlify/functions/campaign-creator-run   { action, ... }   (Vercel: /api/campaign-creator-run)
//
//   "resources"  { connection_id, campaign_type, advertiser_ids: [...] }
//        -> per-advertiser preflight for the runtime wizard:
//           { identities:[{identity_id,identity_type,name}]  (usable across ALL selected),
//             forms:[{id,name}]        (Lead Gen — shared by ALL selected; else []),
//             sales_events:[string]    (Sales — Instant Page conversion events shared by ALL; else []),
//             advertisers:[{advertiser_id,advertiser_name,timezone,local_time,instant_page,notes[]}],
//             blockers:[string] }
//
//   "create"  { template_id?, campaign_type, config?, connection_id, advertiser_ids:[...],
//               base_name, schedule:{hour,minute}, spark_codes:[...], post_links:[...],
//               identity_id, identity_type, form_id?, sales_event? }
//        -> creates ONE campaign per advertiser, registers each successful one for
//           the existing duplication + auto-appeal lifecycle, stores its post URL.
//           Partial failure tolerant. -> { results:[{advertiser_id,advertiser_name,
//           campaign_name,status:'Created'|'Failed'|'Skipped',campaign_id?,error?,warnings?}] }
//
// No admin password (same posture as wh-warmup / the other tiktok-* write
// actions). All MCP calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  normalizeNetwork,
  json,
} = require("./_shared/tiktok-mcp");
const { registerForDuplication } = require("./_shared/campaign-creator.js");
const {
  TEMPLATE_TYPES,
  normalizeTemplateConfig,
  fmtLocal,
  resolveCardImageUrl,
  listBcForms,
  formLibraryMap,
  listInstantPages,
  newestInstantPage,
  listBcIdentities,
  instantPageConversion,
  createOneCampaign,
} = require("./_shared/campaign-creator-build");

const AUTO_IDENTITY = { identity_id: "__AUTO__", identity_type: "AUTO", name: "Auto — use each Spark code's own identity" };

const advApproved = (a) => String(a?.status || "").toUpperCase() === "STATUS_ENABLE";
const uniq = (a) => [...new Set(a)];

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
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }
    if (body.action === "resources") return resources(supabase, body);
    if (body.action === "create") return createBatch(supabase, body);
    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------

async function loadConnAndAdvertisers(supabase, connectionId, advertiserIds) {
  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return { error: json(404, { error: "Connection not found." }) };
  const { data: advRows } = await supabase
    .from("tiktok_advertisers")
    .select("advertiser_id, advertiser_name, status, currency, timezone, display_timezone, bc_id, bc_name")
    .eq("connection_id", connectionId)
    .in("advertiser_id", advertiserIds.map(String));
  const byId = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));
  return { conn, byId };
}

// ---------------------------------------------------------------------------
// resources — preflight
// ---------------------------------------------------------------------------

async function resources(supabase, body) {
  const connectionId = body.connection_id;
  const type = String(body.campaign_type || "").toUpperCase();
  const advertiserIds = uniq((body.advertiser_ids || []).map(String).filter(Boolean));
  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!TEMPLATE_TYPES.includes(type)) return json(400, { error: `campaign_type must be one of ${TEMPLATE_TYPES.join(", ")}` });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });

  const loaded = await loadConnAndAdvertisers(supabase, connectionId, advertiserIds);
  if (loaded.error) return loaded.error;
  const { conn, byId } = loaded;

  const out = {
    ok: true,
    identities: [],
    forms: [],
    sales_events: [],
    advertisers: [],
    blockers: [],
  };

  const deadline = Date.now() + 45000;
  let approvedSeen = 0;
  const idMeta = new Map(); // identity_id -> { identity_id, identity_type, name, count }
  const formById = new Map(); // page_id -> { id, name, source: 'bc' | 'account' }
  let eventSets = [];

  await withClient(supabase, conn, async (client) => {
    // BC-wide Instant Forms — the "BC -> Assets -> Forms" list. Forms linked to
    // ad accounts are NOT visible via page_get(advertiser_id); they live in a
    // form library and are only listable by sweeping page_get(library_id).
    if (type === "LEAD_GENERATION") {
      try {
        const { forms, diag } = await listBcForms(client, { deadlineMs: deadline });
        for (const f of forms) if (!formById.has(f.id)) formById.set(f.id, { id: f.id, name: f.name, source: "bc" });
        out.form_debug = diag;
        if (diag && diag.errors && diag.errors.length) {
          out.form_debug_note = `Form scan: ${diag.libraries} libraries, ${diag.withForms} with forms, ${diag.errors.length} error(s): ${diag.errors.slice(0, 3).join(" | ")}`;
        }
      } catch (err) {
        out.blockers.push(`Could not read Business Center forms: ${err.message}`);
      }
    }

    for (const advId of advertiserIds) {
      if (Date.now() > deadline) {
        out.blockers.push("Preflight stopped early (too many accounts) — reduce the batch or try again.");
        break;
      }
      const adv = byId.get(advId);
      const row = {
        advertiser_id: advId,
        advertiser_name: adv?.advertiser_name || advId,
        timezone: adv?.timezone || adv?.display_timezone || "America/New_York",
        local_time: null,
        instant_page: null,
        notes: [],
      };
      row.local_time = fmtLocal(new Date(), row.timezone);

      if (!adv) {
        row.notes.push("not under this Business Center");
        out.advertisers.push(row);
        continue;
      }
      if (!advApproved(adv)) {
        // Suspended accounts are shown for context but NEVER queried and NEVER
        // affect the form / identity lists.
        row.notes.push("Suspended — will be skipped");
        out.advertisers.push(row);
        continue;
      }
      approvedSeen += 1;

      const bcId = adv.bc_id || conn.bc_id || null;
      try {
        const ids = await listBcIdentities(client, advId, bcId);
        for (const x of ids) {
          const cur = idMeta.get(x.identity_id) || { ...x, count: 0 };
          cur.count += 1;
          idMeta.set(x.identity_id, cur);
        }
      } catch (err) {
        row.notes.push(`identities unavailable (${err.message})`);
      }

      if (type === "LEAD_GENERATION") {
        // Fallback: if the BC library sweep found nothing, also check this
        // selected account's own page_get(advertiser_id) route.
        if (!formById.size) {
          try {
            for (const f of await listInstantForms(client, advId, null)) {
              if (!formById.has(f.id)) formById.set(f.id, { id: f.id, name: f.name, source: "account" });
            }
          } catch (_) {
            /* optional */
          }
        }
      } else {
        try {
          const pages = await listInstantPages(client, advId);
          const newest = newestInstantPage(pages);
          if (newest.error) row.notes.push(`Instant Page: ${newest.error}`);
          else row.instant_page = newest.name || newest.page_id;
        } catch (err) {
          row.notes.push(`Instant Pages unavailable (${err.message})`);
        }
        try {
          const conv = await instantPageConversion(client, advId);
          if (conv.error) row.notes.push(conv.error);
          else eventSets.push(new Set(conv.events));
        } catch (err) {
          row.notes.push(`conversion events unavailable (${err.message})`);
        }
      }

      out.advertisers.push(row);
    }
  }).catch((err) => {
    out.blockers.push(`Preflight failed: ${err.message}`);
  });

  // Identity: "Auto" (each Spark code's own identity) is always available and is
  // the default; connected BC identities are offered as additional choices.
  out.identities = [
    { ...AUTO_IDENTITY, count: approvedSeen, total: approvedSeen },
    ...[...idMeta.values()].map((x) => ({ ...x, total: approvedSeen })),
  ];

  if (type === "LEAD_GENERATION") {
    // Every published Lead Gen Instant Form visible to this BC (Business Center
    // forms + any account-owned ones), by page_id. The operator picks one; that
    // exact page_id is used for every campaign (the form is linked to the
    // accounts). NOT an intersection; suspended accounts never affect it.
    // NEVER a hard blocker — the operator can always paste a Form ID.
    out.forms = [...formById.values()].map((f) => ({ id: f.id, name: f.name || f.id, source: f.source }));
    out.forms.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    out.form_notes = [];
    if (approvedSeen && !out.forms.length) {
      const d = out.form_debug || {};
      out.form_notes.push(
        `No Instant Form returned by the API (scanned ${d.libraries || 0} form libraries, ${d.withForms || 0} had forms` +
          (d.errors && d.errors.length ? `, errors: ${d.errors.slice(0, 3).join(" | ")}` : "") +
          `). Paste the Form ID from BC → Assets → Forms.`
      );
    } else if (out.form_debug_note) {
      out.form_notes.push(out.form_debug_note);
    }
  } else {
    out.sales_events = [...intersect(eventSets)];
    if (!out.sales_events.length && approvedSeen) {
      out.blockers.push("No single Instant Page conversion event is available across all selected advertiser accounts.");
    }
  }

  return json(200, out);
}

function intersect(sets) {
  const nonEmpty = sets.filter((s) => s && s.size);
  if (!nonEmpty.length) return new Set();
  let acc = new Set(nonEmpty[0]);
  for (let i = 1; i < nonEmpty.length; i++) acc = new Set([...acc].filter((x) => nonEmpty[i].has(x)));
  return acc;
}

// ---------------------------------------------------------------------------
// create — one campaign per advertiser
// ---------------------------------------------------------------------------

function splitLines(v) {
  return String(v || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createBatch(supabase, body) {
  const connectionId = body.connection_id;
  const type = String(body.campaign_type || "").toUpperCase();
  const advertiserIds = uniq((body.advertiser_ids || []).map(String).filter(Boolean));
  const base = String(body.base_name || "").trim();
  const hour = Number(body.schedule?.hour);
  const minute = Number(body.schedule?.minute);
  const sparkCodes = Array.isArray(body.spark_codes) ? body.spark_codes.map((s) => String(s)) : splitLines(body.spark_codes);
  const postLinks = Array.isArray(body.post_links) ? body.post_links.map((s) => String(s).trim()) : splitLines(body.post_links);
  const identityId = String(body.identity_id || "__AUTO__");
  const identityType = String(body.identity_type || "AUTO");
  const identityAuto = identityId === "__AUTO__" || identityType === "AUTO";
  const formId = body.form_id ? String(body.form_id).trim() : "";      // BC / account form page_id (primary)
  const formName = body.form_name ? String(body.form_name).trim() : ""; // name fallback (account-owned forms)
  const salesEvent = body.sales_event ? String(body.sales_event) : null;

  // ---- static validation ----
  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!TEMPLATE_TYPES.includes(type)) return json(400, { error: `campaign_type must be one of ${TEMPLATE_TYPES.join(", ")}` });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });
  if (!base) return json(400, { error: "Enter a campaign name base." });
  if (!(Number.isInteger(hour) && hour >= 0 && hour <= 23)) return json(400, { error: "Pick a valid schedule hour (0–23)." });
  if (!(Number.isInteger(minute) && minute >= 0 && minute <= 59)) return json(400, { error: "Pick a valid schedule minute (0–59)." });
  if (!identityAuto && !identityId) return json(400, { error: "Select a TikTok identity, or choose Auto." });
  if (sparkCodes.length !== advertiserIds.length) {
    return json(400, { error: `Spark codes (${sparkCodes.length}) must match selected accounts (${advertiserIds.length}).` });
  }
  if (postLinks.length !== advertiserIds.length) {
    return json(400, { error: `Post links (${postLinks.length}) must match selected accounts (${advertiserIds.length}).` });
  }
  for (const l of postLinks) {
    let u;
    try {
      u = new URL(l);
    } catch (_) {
      return json(400, { error: `Not a valid TikTok post URL: "${l.slice(0, 60)}"` });
    }
    if (u.protocol !== "https:" || !/(^|\.)tiktok\.com$/i.test(u.hostname)) {
      return json(400, { error: `Post links must be https tiktok.com URLs: "${l.slice(0, 60)}"` });
    }
  }
  if (type === "LEAD_GENERATION" && !formId && !formName) return json(400, { error: "Select an Instant Form (or paste a Form ID)." });

  // ---- template config ----
  let config, campaignType;
  if (body.template_id) {
    const { data: tpl, error } = await supabase
      .from("campaign_creator_templates")
      .select("campaign_type, config")
      .eq("id", String(body.template_id))
      .maybeSingle();
    if (error || !tpl) return json(404, { error: "Template not found." });
    campaignType = String(tpl.campaign_type).toUpperCase();
    ({ config } = normalizeTemplateConfig(tpl.config || {}));
  } else {
    campaignType = type;
    const n = normalizeTemplateConfig(body.config || {});
    if (n.errors.length) return json(400, { error: n.errors[0] });
    config = n.config;
  }
  if (campaignType !== type) return json(400, { error: "Template type does not match the selected campaign type." });

  const loaded = await loadConnAndAdvertisers(supabase, connectionId, advertiserIds);
  if (loaded.error) return loaded.error;
  const { conn, byId } = loaded;
  const network = normalizeNetwork(conn.affiliate_network);

  // Campaign names (deterministic: base + 1-based index).
  const names = advertiserIds.map((_, i) => `${base}${i + 1}`);
  for (const nm of names) {
    if (nm.length > 512) return json(400, { error: `Campaign name too long: "${nm}"` });
  }

  // Interactive card image -> one clean public URL for the whole batch.
  let cardImageUrl = null;
  const cardWarnings = [];
  if (config.interactive_card?.enabled && config.interactive_card.image_url) {
    try {
      const r = await resolveCardImageUrl(config.interactive_card.image_url, { supabase });
      cardImageUrl = r.url;
      if (r.warning) cardWarnings.push(r.warning);
    } catch (err) {
      return json(400, { error: `Interactive Card image: ${err.message}` });
    }
  }

  const results = [];
  const deadline = Date.now() + 52000;
  const identityArg = identityAuto ? { auto: true } : { identity_id: identityId, identity_type: identityType };

  await withClient(supabase, conn, async (client) => {
    // One lookup of the BC form-library map for the whole Lead Gen batch.
    const libMap = type === "LEAD_GENERATION" ? await formLibraryMap(client) : new Map();

    for (let i = 0; i < advertiserIds.length; i++) {
      const advId = advertiserIds[i];
      const adv = byId.get(advId);
      const name = names[i];
      const advName = adv?.advertiser_name || advId;

      if (Date.now() > deadline) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Skipped", error: "Batch too large for one run — create the rest with fewer accounts." });
        continue;
      }
      if (!adv) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Failed", error: "Account is not under this Business Center." });
        continue;
      }
      if (!advApproved(adv)) {
        results.push({ advertiser_id: advId, advertiser_name: advName, campaign_name: name, status: "Skipped", error: "Account is Suspended." });
        continue;
      }

      const bcId = adv.bc_id || conn.bc_id || null;
      try {
        const created = await createOneCampaign({
          client,
          supabase,
          advertiser: adv,
          connectionId,
          bcId,
          type,
          config,
          campaignName: name,
          scheduleHour: hour,
          scheduleMinute: minute,
          sparkCode: sparkCodes[i],
          postUrl: postLinks[i],
          identity: identityArg,
          form: type === "LEAD_GENERATION" ? { id: formId || null, name: formName || null } : null,
          libraryId: libMap.get(advId) || null,
          salesEvent,
          cardImageUrl,
        });

        // Store a minimal Detailed-Metrics row NOW carrying the post URL, so the
        // existing engagement / Add-comments flow can use it before the next
        // discovery sync. A re-sync preserves tiktok_post_url (engagement cols
        // are never overwritten by discoverAndStoreCampaigns).
        await upsertCampaignRow(supabase, {
          campaign_id: created.campaign_id,
          connection_id: connectionId,
          advertiser_id: advId,
          advertiser_name: advName,
          bc_id: bcId,
          bc_name: adv.bc_name || conn.bc_name || null,
          affiliate_network: network,
          campaign_name: name,
          objective_type: type === "SALES" ? "WEB_CONVERSIONS" : "LEAD_GENERATION",
          budget: config.daily_budget,
          budget_mode: "BUDGET_MODE_DAY",
          tiktok_post_url: created.post_url,
        });

        // Enroll into the existing duplication + auto-appeal lifecycle.
        const reg = await registerForDuplication(supabase, {
          campaign_id: created.campaign_id,
          advertiser_id: advId,
          connection_id: connectionId,
          bc_id: bcId,
          campaign_name: name,
          initial_adgroup_id: created.adgroup_id,
          initial_ad_id: created.ad_id,
          adgroup_payload: created.adgroup_payload,
          ad_payload: created.ad_payload,
          dupe_target: 20,
        });

        const warnings = [...(created.warnings || []), ...cardWarnings];
        if (reg.error) warnings.push(`Created, but NOT enrolled for auto-duplication: ${reg.error}`);

        results.push({
          advertiser_id: advId,
          advertiser_name: advName,
          campaign_name: name,
          status: "Created",
          campaign_id: created.campaign_id,
          instant_page_name: created.instant_page_name || null,
          instant_form_id: created.instant_form_id || null,
          identity_used: created.identity_used || null,
          schedule_local: created.schedule_local,
          schedule_tz: created.schedule_tz,
          warnings: warnings.length ? warnings : undefined,
        });
      } catch (err) {
        console.error(`[campaign-creator-run] ${advId} failed: ${err.message}`);
        results.push({
          advertiser_id: advId,
          advertiser_name: advName,
          campaign_name: name,
          status: "Failed",
          error: err.message,
        });
      }
    }
  }).catch((err) => {
    for (let i = 0; i < advertiserIds.length; i++) {
      if (!results.some((r) => r.advertiser_id === advertiserIds[i])) {
        results.push({
          advertiser_id: advertiserIds[i],
          advertiser_name: byId.get(advertiserIds[i])?.advertiser_name || advertiserIds[i],
          campaign_name: names[i],
          status: "Failed",
          error: err.message,
        });
      }
    }
  });

  const createdCount = results.filter((r) => r.status === "Created").length;
  return json(200, { ok: true, created: createdCount, total: advertiserIds.length, results });
}

// Upsert a tiktok_campaigns row, degrading gracefully when optional columns
// (bc_*, affiliate_network, tiktok_post_url, engagement_added_at) aren't migrated.
async function upsertCampaignRow(supabase, r) {
  const now = new Date().toISOString();
  const full = {
    campaign_id: String(r.campaign_id),
    connection_id: r.connection_id,
    advertiser_id: String(r.advertiser_id),
    advertiser_name: r.advertiser_name || null,
    campaign_name: r.campaign_name,
    objective_type: r.objective_type || null,
    budget: r.budget != null ? Number(r.budget) : null,
    budget_mode: r.budget_mode || null,
    campaign_operation_status: "ENABLE",
    campaign_secondary_status: null,
    effective_status: "In Review",
    effective_tone: "warn",
    status_detail: "Campaign just created — awaiting TikTok review",
    ad_count: 1,
    active_ad_count: 0,
    create_time: now,
    updated_at: now,
    bc_id: r.bc_id || null,
    bc_name: r.bc_name || null,
    affiliate_network: r.affiliate_network || "GLITCHY",
    tiktok_post_url: r.tiktok_post_url || null,
    engagement_added_at: r.tiktok_post_url ? now : null,
  };
  let { error } = await supabase.from("tiktok_campaigns").upsert(full, { onConflict: "campaign_id" });
  if (error && /bc_(id|name)|affiliate_network|tiktok_post_url|engagement_added_at/.test(error.message || "")) {
    const { bc_id, bc_name, affiliate_network, tiktok_post_url, engagement_added_at, ...bare } = full;
    ({ error } = await supabase.from("tiktok_campaigns").upsert(bare, { onConflict: "campaign_id" }));
  }
  if (error) console.error(`[campaign-creator-run] tiktok_campaigns upsert failed for ${r.campaign_id}: ${error.message}`);
}
