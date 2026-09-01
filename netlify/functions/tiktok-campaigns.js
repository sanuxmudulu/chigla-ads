// GET  /.netlify/functions/tiktok-campaigns
//        -> { campaigns: [...] }   (campaigns inside tracked advertiser accounts)
//
// POST /.netlify/functions/tiktok-campaigns   { action, ... }
//        "sync"                : re-scan advertisers + re-discover campaigns for every
//                                TRACKED account ("Refresh TikTok Data")
//        "adgroups"            : { campaign_id } — lazy-load one campaign's ad groups +
//                                today's spend/CPA + status
//        "set_campaign_status" : { campaign_id, operation_status } — write
//        "set_adgroup_status"  : { campaign_id, adgroup_id, operation_status } — write
//
// None of these need the admin password. Every action is restricted server-side
// to campaigns/ad groups whose advertiser account is currently `tracked`. All
// MCP calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  discoverAndStoreAdvertisers,
  discoverAndStoreCampaigns,
  loadCampaignDetail,
  setCampaignStatus,
  setAdGroupStatus,
  json,
} = require("./_shared/tiktok-mcp");

const CAMPAIGN_COLUMNS =
  "campaign_id, connection_id, advertiser_id, advertiser_name, campaign_name, objective_type, budget, budget_mode, campaign_operation_status, campaign_secondary_status, effective_status, effective_tone, status_detail, ad_count, active_ad_count, create_time, updated_at";

// Loads a stored campaign row and confirms its advertiser account is tracked.
async function resolveTrackedCampaign(supabase, campaignId) {
  const { data: campaign } = await supabase
    .from("tiktok_campaigns")
    .select("*")
    .eq("campaign_id", String(campaignId))
    .maybeSingle();
  if (!campaign) return { error: json(404, { error: "Campaign not found. Run a campaign sync first." }) };

  const { data: adv } = await supabase
    .from("tiktok_advertisers")
    .select("tracked, status, timezone, display_timezone")
    .eq("connection_id", campaign.connection_id)
    .eq("advertiser_id", campaign.advertiser_id)
    .maybeSingle();
  if (!adv || !adv.tracked) {
    return { error: json(403, { error: "That advertiser account is not tracked." }) };
  }

  const { data: conn } = await supabase
    .from("tiktok_connections")
    .select("*")
    .eq("id", campaign.connection_id)
    .maybeSingle();
  if (!conn) return { error: json(404, { error: "Connection not found." }) };

  return { campaign, advertiser: adv, connection: conn };
}

// Connects one MCP client for a connection, runs fn(client), always closes.
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

    if (event.httpMethod === "GET") {
      const { data, error } = await supabase
        .from("tiktok_campaigns")
        .select(CAMPAIGN_COLUMNS)
        .order("campaign_name", { ascending: true });
      if (error) return json(500, { error: "Supabase read failed", details: error.message });
      return json(200, { campaigns: data || [] });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    const action = body.action;

    // ---- read-only: lazy ad-group load for one campaign ----
    if (action === "adgroups") {
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });
      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;
      const detail = await withClient(supabase, r.connection, (client) =>
        loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        })
      );
      await persistCampaignStatus(supabase, r.campaign.campaign_id, detail);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        campaign_operation_status: detail.campaign_operation_status,
        effective_status: detail.effective_status,
        effective_tone: detail.effective_tone,
        status_detail: detail.status_detail,
        adgroups: detail.adGroups,
      });
    }

    // Writes below are NOT password-gated (per product decision): the dashboard
    // is already behind whatever protects the site, and every write is still
    // restricted server-side to campaigns/ad groups under a TRACKED advertiser
    // account (resolveTrackedCampaign). Only connecting / disconnecting a TikTok
    // account still asks for the admin password.

    if (action === "set_campaign_status") {
      const op = normalizeOp(body.operation_status);
      if (!op) return json(400, { error: "operation_status must be ENABLE or DISABLE" });
      if (!body.campaign_id) return json(400, { error: "campaign_id is required" });

      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;

      const detail = await withClient(supabase, r.connection, async (client) => {
        await setCampaignStatus({
          client,
          advertiserId: r.campaign.advertiser_id,
          campaignId: r.campaign.campaign_id,
          operationStatus: op,
        });
        return loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        });
      });
      await persistCampaignStatus(supabase, r.campaign.campaign_id, detail);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        campaign_operation_status: detail.campaign_operation_status,
        effective_status: detail.effective_status,
        effective_tone: detail.effective_tone,
        status_detail: detail.status_detail,
        adgroups: detail.adGroups,
      });
    }

    if (action === "set_adgroup_status") {
      const op = normalizeOp(body.operation_status);
      if (!op) return json(400, { error: "operation_status must be ENABLE or DISABLE" });
      if (!body.campaign_id || !body.adgroup_id) return json(400, { error: "campaign_id and adgroup_id are required" });

      const r = await resolveTrackedCampaign(supabase, body.campaign_id);
      if (r.error) return r.error;
      const tz = r.advertiser.timezone || r.advertiser.display_timezone || null;

      const out = await withClient(supabase, r.connection, async (client) => {
        const updated = await setAdGroupStatus({
          client,
          advertiserId: r.campaign.advertiser_id,
          adGroupId: body.adgroup_id,
          operationStatus: op,
        });
        // Confirm the ad group actually belongs to this campaign.
        if (updated && String(updated.campaign_id) !== String(r.campaign.campaign_id)) {
          throw new Error("Ad group does not belong to that campaign.");
        }
        const detail = await loadCampaignDetail({
          client,
          advertiserId: r.campaign.advertiser_id,
          advertiserStatus: r.advertiser.status,
          campaignId: r.campaign.campaign_id,
          timezone: tz,
        });
        return { detail };
      });
      await persistCampaignStatus(supabase, r.campaign.campaign_id, out.detail);
      return json(200, {
        ok: true,
        campaign_id: String(r.campaign.campaign_id),
        adgroup_id: String(body.adgroup_id),
        campaign_operation_status: out.detail.campaign_operation_status,
        effective_status: out.detail.effective_status,
        effective_tone: out.detail.effective_tone,
        status_detail: out.detail.status_detail,
        adgroups: out.detail.adGroups,
      });
    }

    if (action === "sync") return syncAll(supabase);

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

function normalizeOp(v) {
  const s = String(v || "").toUpperCase();
  return s === "ENABLE" || s === "DISABLE" ? s : null;
}

async function persistCampaignStatus(supabase, campaignId, detail) {
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
}

// ---- full re-discovery for every tracked advertiser ----
async function syncAll(supabase) {
  const { data: tracked, error: trackedErr } = await supabase
    .from("tiktok_advertisers")
    .select("connection_id, advertiser_id, advertiser_name, status, tracked")
    .eq("tracked", true);
  if (trackedErr) return json(500, { error: "Supabase read failed", details: trackedErr.message });

  if (!tracked || !tracked.length) {
    await supabase.from("tiktok_campaigns").delete().neq("campaign_id", "");
    return json(200, { ok: true, campaignCount: 0, connections: 0, note: "No advertiser accounts are tracked." });
  }

  const byConnection = {};
  for (const t of tracked) {
    (byConnection[t.connection_id] = byConnection[t.connection_id] || []).push(t);
  }

  const { serverUrl, redirectUrl } = resolveConfig();
  const summary = { ok: true, campaignCount: 0, connections: 0, perConnection: {} };

  const trackedAdvIds = tracked.map((t) => String(t.advertiser_id));
  await supabase.from("tiktok_campaigns").delete().not("advertiser_id", "in", `(${trackedAdvIds.join(",")})`);

  for (const [connectionId, advertisers] of Object.entries(byConnection)) {
    const { data: conn, error: connErr } = await supabase
      .from("tiktok_connections")
      .select("*")
      .eq("id", connectionId)
      .maybeSingle();
    if (connErr || !conn) {
      summary.perConnection[connectionId] = "connection not found";
      continue;
    }

    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn });
    let client;
    try {
      ({ client } = await connectMcp({ provider, serverUrl }));
      // Refresh the account list / statuses / BC identity for this connection too.
      try {
        await discoverAndStoreAdvertisers({ supabase, client, connectionId });
      } catch (_) {
        /* campaign discovery is the priority — don't fail the whole sync on this */
      }
      const res = await discoverAndStoreCampaigns({ supabase, client, connectionId, trackedAdvertisers: advertisers });
      summary.campaignCount += res.campaignCount;
      summary.connections += 1;
      summary.perConnection[connectionId] = res.perAdvertiser;
      await supabase
        .from("tiktok_connections")
        .update({ last_verified_at: new Date().toISOString(), status: "active" })
        .eq("id", connectionId);
    } catch (err) {
      summary.perConnection[connectionId] = `error: ${err.message}`;
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  return json(200, summary);
}
