// GET  /.netlify/functions/tiktok-campaigns
//        -> { campaigns: [...] }   (campaigns inside tracked advertiser accounts)
//
// POST /.netlify/functions/tiktok-campaigns   { password, action: "sync" }
//        Re-discovers today's campaigns for every TRACKED advertiser account via
//        the TikTok MCP, derives an effective status per campaign, and stores
//        them. Only tracked accounts are ever queried.
//
// This step does NOT fetch spend/impression metrics — those stay 0 until the
// metric-merge step. It only establishes which campaign rows exist and their
// operating status.

const {
  getSupabase,
  resolveConfig,
  checkPassword,
  SupabaseOAuthProvider,
  connectMcp,
  discoverAndStoreCampaigns,
  json,
} = require("./_shared/tiktok-mcp");

const CAMPAIGN_COLUMNS =
  "campaign_id, connection_id, advertiser_id, advertiser_name, campaign_name, objective_type, budget, budget_mode, campaign_operation_status, campaign_secondary_status, effective_status, effective_tone, status_detail, ad_count, active_ad_count, create_time, updated_at";

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

    const pw = checkPassword(body.password);
    if (!pw.ok) return json(pw.code, { error: pw.error });
    if (body.action !== "sync") return json(400, { error: `Unknown action: ${body.action}` });

    // Which advertiser accounts did the user choose to track?
    const { data: tracked, error: trackedErr } = await supabase
      .from("tiktok_advertisers")
      .select("connection_id, advertiser_id, advertiser_name, status, tracked")
      .eq("tracked", true);
    if (trackedErr) return json(500, { error: "Supabase read failed", details: trackedErr.message });

    if (!tracked || !tracked.length) {
      // Nothing tracked -> clear any stale campaign rows and report.
      await supabase.from("tiktok_campaigns").delete().neq("campaign_id", "");
      return json(200, { ok: true, campaignCount: 0, connections: 0, note: "No advertiser accounts are tracked." });
    }

    // Group tracked advertisers by connection so we authenticate once per connection.
    const byConnection = {};
    for (const t of tracked) {
      (byConnection[t.connection_id] = byConnection[t.connection_id] || []).push(t);
    }

    const { serverUrl, redirectUrl } = resolveConfig();
    const summary = { ok: true, campaignCount: 0, connections: 0, perConnection: {} };

    // Also drop campaign rows whose advertiser is no longer tracked at all.
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
        const res = await discoverAndStoreCampaigns({
          supabase,
          client,
          connectionId,
          trackedAdvertisers: advertisers,
        });
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
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
