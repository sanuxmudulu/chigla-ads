// GET /.netlify/functions/tiktok-auth-callback?code=...&state=...
//
// TikTok redirects the browser here after the user authorizes. We:
//   1. look up the pending transaction by `state`
//   2. exchange the code for tokens (PKCE, public client) via the MCP SDK
//   3. identify the TikTok user (user_info_get) and upsert tiktok_connections
//   4. discover the Business Centers + advertiser accounts and store them
//   5. 302-redirect the browser back to the dashboard
//
// Tokens are written to Supabase server-side only and never put in the redirect.

const {
  auth,
  getSupabase,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  mcpCall,
  discoverAndStoreAdvertisers,
} = require("./_shared/tiktok-mcp");

function safeBase() {
  try {
    return resolveConfig().base || "";
  } catch (_) {
    return "";
  }
}

const redirectTo = (base, params) => ({
  statusCode: 302,
  headers: { Location: `${base || ""}/?${new URLSearchParams(params).toString()}` },
  body: "",
});

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const base = safeBase();

  if (q.error) {
    return redirectTo(base, { tiktok: "error", reason: q.error_description || q.error });
  }
  if (!q.code || !q.state) {
    return redirectTo(base, { tiktok: "error", reason: "missing_code_or_state" });
  }

  try {
    const { serverUrl } = resolveConfig();
    const supabase = getSupabase();

    const { data: tx } = await supabase
      .from("tiktok_oauth_transactions")
      .select("*")
      .eq("state", q.state)
      .maybeSingle();

    if (!tx) return redirectTo(base, { tiktok: "error", reason: "unknown_or_expired_state" });

    const provider = new SupabaseOAuthProvider({
      supabase,
      serverUrl,
      redirectUrl: tx.redirect_uri,
      transaction: { state: tx.state, code_verifier: tx.code_verifier },
    });

    // Exchange the authorization code -> tokens (provider.saveTokens stashes them).
    const result = await auth(provider, { serverUrl, authorizationCode: q.code });
    if (result !== "AUTHORIZED") {
      return redirectTo(base, { tiktok: "error", reason: "token_exchange_failed" });
    }
    const tokenRecord = provider.getResolvedTokens();
    if (!tokenRecord || !tokenRecord.access_token) {
      return redirectTo(base, { tiktok: "error", reason: "no_access_token" });
    }

    // Connect to the MCP server with the fresh tokens to identify + discover.
    const { client } = await connectMcp({ provider, serverUrl });

    let me = {};
    try {
      me = await mcpCall(client, "user_info_get", {});
    } catch (_) {
      me = {};
    }
    const coreId = String(me.core_user_id || me.id || `pending_${tx.state.slice(0, 12)}`);
    const now = new Date().toISOString();

    const { data: conn, error: connErr } = await supabase
      .from("tiktok_connections")
      .upsert(
        {
          tiktok_core_user_id: coreId,
          tiktok_email: me.email || null,
          tiktok_display_name: me.display_name || null,
          label: tx.label || me.email || me.display_name || "TikTok connection",
          tokens: tokenRecord,
          scope: tokenRecord.scope || null,
          status: "active",
          last_verified_at: now,
          updated_at: now,
        },
        { onConflict: "tiktok_core_user_id" }
      )
      .select()
      .single();

    if (connErr) {
      await client.close().catch(() => {});
      return redirectTo(base, { tiktok: "error", reason: `db: ${connErr.message}` });
    }

    let discovery = {};
    try {
      discovery = await discoverAndStoreAdvertisers({
        supabase,
        client,
        connectionId: conn.id,
      });
    } catch (err) {
      discovery = { warn: err.message };
    }

    await client.close().catch(() => {});
    await supabase.from("tiktok_oauth_transactions").delete().eq("state", tx.state);

    const params = { tiktok: "connected", connection: conn.id };
    if (discovery.advertiserCount != null) params.accounts = String(discovery.advertiserCount);
    if (discovery.warn) params.warn = discovery.warn;
    return redirectTo(base, params);
  } catch (err) {
    return redirectTo(base, { tiktok: "error", reason: err.message });
  }
};
