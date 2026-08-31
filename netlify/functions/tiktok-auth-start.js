// POST /.netlify/functions/tiktok-auth-start   { password, label? }
//
// Password-gated. Runs OAuth discovery + Dynamic Client Registration against the
// official TikTok Ads MCP server, builds the authorization URL, stores the PKCE
// verifier + state, and returns { authorizeUrl } for the browser to redirect to.
//
// No advertiser IDs, tokens or credentials are hard-coded anywhere.

const {
  auth,
  getSupabase,
  resolveConfig,
  checkPassword,
  SupabaseOAuthProvider,
  json,
} = require("./_shared/tiktok-mcp");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const pw = checkPassword(body.password);
  if (!pw.ok) return json(pw.code, { error: pw.error });

  try {
    const { serverUrl, redirectUrl } = resolveConfig();
    const supabase = getSupabase();

    const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl });

    // Discovery -> DCR (persisted via provider.saveClientInformation) ->
    // startAuthorization (persists the PKCE verifier via provider.saveCodeVerifier
    // and captures the URL via provider.redirectToAuthorization).
    const result = await auth(provider, { serverUrl });

    if (result !== "REDIRECT" || !provider.authorizationUrl) {
      return json(500, {
        error: "OAuth flow did not produce an authorization URL.",
        details: `auth() returned "${result}"`,
      });
    }

    const { error } = await supabase.from("tiktok_oauth_transactions").insert({
      state: provider.state(),
      code_verifier: provider.getCodeVerifier(),
      label: (body.label || "").trim() || null,
      redirect_uri: redirectUrl,
    });
    if (error) {
      return json(500, {
        error: "Could not persist the auth transaction.",
        details: error.message,
      });
    }

    // Sweep abandoned transactions (>20 min old).
    await supabase
      .from("tiktok_oauth_transactions")
      .delete()
      .lt("created_at", new Date(Date.now() - 20 * 60 * 1000).toISOString());

    return json(200, { authorizeUrl: provider.authorizationUrl.toString() });
  } catch (err) {
    return json(500, { error: "Auth start failed.", details: err.message });
  }
};
