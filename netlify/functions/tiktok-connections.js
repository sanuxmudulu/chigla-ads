// GET  /.netlify/functions/tiktok-connections
//        -> { connections: [...], advertisers: [...] }   (never includes tokens)
//
// POST /.netlify/functions/tiktok-connections   { action, ... }
//        action "track"      : { selections: [{ connection_id, advertiser_id, tracked }] }  (no password)
//        action "refresh"    : { connection_id }   -> re-scan one connection's advertisers  (no password)
//        action "disconnect" : { password, connection_id }   -> forget the connection       (PASSWORD)
//
// Only "disconnect" needs the admin password. "track" / "refresh" work directly
// once a TikTok connection is authenticated.

const {
  getSupabase,
  resolveConfig,
  checkPassword,
  SupabaseOAuthProvider,
  connectMcp,
  discoverAndStoreAdvertisers,
  json,
} = require("./_shared/tiktok-mcp");

const CONNECTION_COLUMNS_BASE =
  "id, label, tiktok_email, tiktok_display_name, status, last_verified_at, created_at";
const CONNECTION_COLUMNS = `${CONNECTION_COLUMNS_BASE}, bc_id, bc_name, bc_count`;

// Reads connections, gracefully degrading if the bc_* columns haven't been
// added yet (migration supabase/tiktok_bc_columns.sql).
async function readConnections(supabase) {
  let res = await supabase.from("tiktok_connections").select(CONNECTION_COLUMNS).order("created_at", { ascending: true });
  if (res.error && /bc_(id|name|count)/.test(res.error.message || "")) {
    res = await supabase.from("tiktok_connections").select(CONNECTION_COLUMNS_BASE).order("created_at", { ascending: true });
    if (!res.error) res.data = (res.data || []).map((c) => ({ ...c, bc_id: null, bc_name: null, bc_count: 0 }));
  }
  return res;
}

const ADVERTISER_COLUMNS =
  "connection_id, advertiser_id, advertiser_name, bc_id, bc_name, currency, timezone, display_timezone, status, role, country, tracked, updated_at";

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    if (event.httpMethod === "GET") {
      const [connectionsRes, advertisersRes] = await Promise.all([
        readConnections(supabase),
        supabase.from("tiktok_advertisers").select(ADVERTISER_COLUMNS).order("advertiser_name", { ascending: true }),
      ]);
      if (connectionsRes.error) return json(500, { error: "Supabase read failed", details: connectionsRes.error.message });
      if (advertisersRes.error) return json(500, { error: "Supabase read failed", details: advertisersRes.error.message });
      return json(200, {
        connections: connectionsRes.data || [],
        advertisers: advertisersRes.data || [],
      });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    // Only disconnect is password-gated.
    if (body.action === "disconnect") {
      const pw = checkPassword(body.password);
      if (!pw.ok) return json(pw.code, { error: pw.error });
    }

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
          if (error) return json(500, { error: "Update failed", details: error.message });
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
        if (error) return json(500, { error: "Supabase read failed", details: error.message });
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
        if (error) return json(500, { error: "Delete failed", details: error.message });
        return json(200, { ok: true });
      }

      default:
        return json(400, { error: `Unknown action: ${body.action}` });
    }
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
