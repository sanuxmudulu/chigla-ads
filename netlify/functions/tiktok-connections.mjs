// GET  /.netlify/functions/tiktok-connections
//        -> { connections: [...], advertisers: [...] }   (never includes tokens)
//
// POST /.netlify/functions/tiktok-connections   { password, action, ... }
//        action "track"      : { selections: [{ connection_id, advertiser_id, tracked }] }
//        action "refresh"    : { connection_id }   -> re-scan advertisers via MCP
//        action "disconnect" : { connection_id }   -> forget the connection

import {
  getSupabase,
  resolveConfig,
  checkPassword,
  SupabaseOAuthProvider,
  connectMcp,
  discoverAndStoreAdvertisers,
  json,
} from "./_shared/tiktok-mcp.mjs";

const CONNECTION_COLUMNS =
  "id, label, tiktok_email, tiktok_display_name, status, last_verified_at, created_at";

const ADVERTISER_COLUMNS =
  "connection_id, advertiser_id, advertiser_name, bc_id, bc_name, currency, timezone, display_timezone, status, role, country, tracked, updated_at";

export const handler = async (event) => {
  try {
    const supabase = getSupabase();

    if (event.httpMethod === "GET") {
      const [connectionsRes, advertisersRes] = await Promise.all([
        supabase.from("tiktok_connections").select(CONNECTION_COLUMNS).order("created_at", { ascending: true }),
        supabase.from("tiktok_advertisers").select(ADVERTISER_COLUMNS).order("advertiser_name", { ascending: true }),
      ]);
      if (connectionsRes.error) return json(500, { error: connectionsRes.error.message });
      if (advertisersRes.error) return json(500, { error: advertisersRes.error.message });
      return json(200, {
        connections: connectionsRes.data || [],
        advertisers: advertisersRes.data || [],
      });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const pw = checkPassword(body.password);
    if (!pw.ok) return json(pw.code, { error: pw.error });

    switch (body.action) {
      case "track": {
        const selections = Array.isArray(body.selections) ? body.selections : [];
        const now = new Date().toISOString();
        let updated = 0;
        for (const s of selections) {
          if (!s.connection_id || !s.advertiser_id) continue;
          const { error } = await supabase
            .from("tiktok_advertisers")
            .update({ tracked: !!s.tracked, updated_at: now })
            .eq("connection_id", s.connection_id)
            .eq("advertiser_id", String(s.advertiser_id));
          if (error) return json(500, { error: error.message });
          updated += 1;
        }
        return json(200, { ok: true, updated });
      }

      case "refresh": {
        if (!body.connection_id) return json(400, { error: "connection_id is required" });
        const { data: conn, error } = await supabase
          .from("tiktok_connections")
          .select("*")
          .eq("id", body.connection_id)
          .maybeSingle();
        if (error) return json(500, { error: error.message });
        if (!conn) return json(404, { error: "Connection not found" });

        const { serverUrl, redirectUrl } = resolveConfig();
        const provider = new SupabaseOAuthProvider({
          supabase,
          serverUrl,
          redirectUrl,
          connection: conn,
        });
        const { client } = await connectMcp({ provider, serverUrl });
        let discovery;
        try {
          discovery = await discoverAndStoreAdvertisers({
            supabase,
            client,
            connectionId: conn.id,
          });
        } finally {
          await client.close().catch(() => {});
        }
        await supabase
          .from("tiktok_connections")
          .update({ last_verified_at: new Date().toISOString(), status: "active" })
          .eq("id", conn.id);
        return json(200, { ok: true, ...discovery });
      }

      case "disconnect": {
        if (!body.connection_id) return json(400, { error: "connection_id is required" });
        await supabase.from("tiktok_advertisers").delete().eq("connection_id", body.connection_id);
        const { error } = await supabase
          .from("tiktok_connections")
          .delete()
          .eq("id", body.connection_id);
        if (error) return json(500, { error: error.message });
        return json(200, { ok: true });
      }

      default:
        return json(400, { error: `Unknown action: ${body.action}` });
    }
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
