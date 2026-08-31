// Shared by the tiktok-* Netlify functions.
//
// This module is the "MCP client" tier of the intended architecture:
//
//   Chigla Ads frontend
//     -> our Netlify function
//       -> this module (@modelcontextprotocol/sdk client + OAuth)
//         -> official TikTok Ads MCP (https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat)
//           -> TikTok Ads
//
// Claude Code is NOT part of this path. The SDK's auth() + StreamableHTTPClient
// transport handle discovery, Dynamic Client Registration (RFC 7591), PKCE and
// token refresh; SupabaseOAuthProvider just persists everything to Supabase so
// the flow works statelessly across separate function invocations.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_MCP_SERVER_URL =
  "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat";

export const MCP_SCOPE = "mcp:tt4b";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function resolveConfig() {
  const serverUrl = process.env.TIKTOK_MCP_SERVER_URL || DEFAULT_MCP_SERVER_URL;

  const base = (
    process.env.APP_BASE_URL ||
    process.env.URL ||               // Netlify: site's primary URL
    process.env.DEPLOY_PRIME_URL ||  // Netlify: deploy-specific URL
    ""
  ).replace(/\/+$/, "");

  const redirectUrl =
    process.env.TIKTOK_OAUTH_REDIRECT_URL ||
    (base ? `${base}/.netlify/functions/tiktok-auth-callback` : null);

  if (!redirectUrl) {
    throw new Error(
      "Cannot resolve the OAuth redirect URL. Set APP_BASE_URL (or TIKTOK_OAUTH_REDIRECT_URL) in Netlify."
    );
  }
  return { serverUrl, redirectUrl, base };
}

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars in Netlify.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Reuses the New Day password unless a dedicated one is set.
export function checkPassword(supplied) {
  const want = process.env.TIKTOK_ADMIN_PASSWORD || process.env.NEW_DAY_PASSWORD || null;
  if (!want) {
    return {
      ok: false,
      code: 500,
      error: "No admin password configured. Set TIKTOK_ADMIN_PASSWORD or NEW_DAY_PASSWORD in Netlify.",
    };
  }
  if (supplied !== want) return { ok: false, code: 401, error: "Incorrect password." };
  return { ok: true };
}

export const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

// ---------------------------------------------------------------------------
// Token shape helpers
// ---------------------------------------------------------------------------

// SDK OAuthTokens use `expires_in` (relative). We persist `expires_at`
// (absolute ISO) so a later invocation can recompute remaining lifetime.
function toStoredTokens(sdkTokens, prev) {
  return {
    access_token: sdkTokens.access_token,
    refresh_token: sdkTokens.refresh_token || prev?.refresh_token || null,
    token_type: sdkTokens.token_type || "Bearer",
    scope: sdkTokens.scope || prev?.scope || null,
    expires_at: sdkTokens.expires_in
      ? new Date(Date.now() + Number(sdkTokens.expires_in) * 1000).toISOString()
      : prev?.expires_at || null,
  };
}

function toSdkTokens(stored) {
  if (!stored?.access_token) return undefined;
  const remaining = stored.expires_at
    ? Math.max(0, Math.floor((Date.parse(stored.expires_at) - Date.now()) / 1000))
    : undefined;
  return {
    access_token: stored.access_token,
    token_type: stored.token_type || "Bearer",
    ...(stored.refresh_token ? { refresh_token: stored.refresh_token } : {}),
    ...(stored.scope ? { scope: stored.scope } : {}),
    ...(remaining !== undefined ? { expires_in: remaining } : {}),
  };
}

// ---------------------------------------------------------------------------
// OAuthClientProvider implementation, backed by Supabase.
//
//   - fresh auth-start : new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl })
//   - OAuth callback   : ... ({ ..., transaction: { state, code_verifier } })
//   - API calls        : ... ({ ..., connection: <tiktok_connections row> })
// ---------------------------------------------------------------------------

export class SupabaseOAuthProvider {
  constructor({ supabase, serverUrl, redirectUrl, transaction = null, connection = null }) {
    this.supabase = supabase;
    this.serverUrl = serverUrl;
    this._redirectUrl = redirectUrl;
    this._transaction = transaction;
    this._connection = connection;

    this._state = transaction?.state || randomUUID();
    this._codeVerifier = transaction?.code_verifier || null;

    this._authorizationUrl = null; // captured from redirectToAuthorization()
    this._pendingTokens = null;    // raw SDK tokens from the current flow
    this._resolvedTokens = null;   // stored-shape tokens for the caller to persist
  }

  // -- interactive redirect target --
  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "Chigla Ads Dashboard",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
    };
  }

  state() {
    return this._state;
  }

  // -- dynamically-registered client, shared across all connections --
  async clientInformation() {
    const { data } = await this.supabase
      .from("tiktok_oauth_client")
      .select("client_id, client_secret")
      .eq("redirect_uri", this._redirectUrl)
      .maybeSingle();
    if (!data) return undefined;
    return {
      client_id: data.client_id,
      ...(data.client_secret ? { client_secret: data.client_secret } : {}),
    };
  }

  async saveClientInformation(info) {
    const now = new Date().toISOString();
    await this.supabase.from("tiktok_oauth_client").upsert(
      {
        redirect_uri: this._redirectUrl,
        server_url: this.serverUrl,
        client_id: info.client_id,
        client_secret: info.client_secret || null,
        client_id_issued_at: info.client_id_issued_at || null,
        registration: info,
        updated_at: now,
      },
      { onConflict: "redirect_uri" }
    );
  }

  // -- tokens --
  async tokens() {
    if (this._pendingTokens) return this._pendingTokens;
    if (this._connection?.tokens) return toSdkTokens(this._connection.tokens);
    return undefined;
  }

  async saveTokens(sdkTokens) {
    this._pendingTokens = sdkTokens;
    const stored = toStoredTokens(sdkTokens, this._connection?.tokens);
    this._resolvedTokens = stored;
    if (this._connection?.id) {
      await this.supabase
        .from("tiktok_connections")
        .update({ tokens: stored, status: "active", updated_at: new Date().toISOString() })
        .eq("id", this._connection.id);
      this._connection.tokens = stored;
    }
  }

  redirectToAuthorization(authorizationUrl) {
    this._authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(verifier) {
    this._codeVerifier = verifier;
  }

  codeVerifier() {
    if (!this._codeVerifier) throw new Error("Missing PKCE code verifier for this session.");
    return this._codeVerifier;
  }

  async invalidateCredentials(scope) {
    if ((scope === "tokens" || scope === "all") && this._connection?.id) {
      await this.supabase
        .from("tiktok_connections")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", this._connection.id);
    }
    if (scope === "client" || scope === "all") {
      await this.supabase
        .from("tiktok_oauth_client")
        .delete()
        .eq("redirect_uri", this._redirectUrl);
    }
  }

  // -- plain accessors for the handlers --
  get authorizationUrl() {
    return this._authorizationUrl;
  }
  getCodeVerifier() {
    return this._codeVerifier;
  }
  getResolvedTokens() {
    return this._resolvedTokens;
  }
}

// ---------------------------------------------------------------------------
// MCP client helpers
// ---------------------------------------------------------------------------

export async function connectMcp({ provider, serverUrl }) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider,
  });
  const client = new Client(
    { name: "chigla-ads-dashboard", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

// The TikTok MCP wraps every result as JSON text: { code, message, data, request_id }.
export async function mcpCall(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (res.isError || (payload && typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error(`TikTok MCP "${name}" failed: ${payload?.message || text || "unknown error"}`);
  }
  return payload?.data ?? payload;
}

const ADV_FIELDS = [
  "advertiser_id",
  "name",
  "currency",
  "timezone",
  "display_timezone",
  "status",
  "role",
  "country",
  "owner_bc_id",
];

// Walks the authenticated TikTok user's Business Centers + advertiser accounts
// and upserts them into tiktok_advertisers. Descriptive columns only — `tracked`
// and `discovered_at` are left untouched so a re-scan preserves the selection.
export async function discoverAndStoreAdvertisers({ supabase, client, connectionId }) {
  let bcs = [];
  try {
    const d = await mcpCall(client, "bc_get", {});
    bcs = d?.list || [];
  } catch {
    // A user with no Business Center still has directly-authorized advertisers.
  }

  const authList = (await mcpCall(client, "auth_advertiser_get", {}))?.list || [];
  const ids = [...new Set(authList.map((a) => String(a.advertiser_id)).filter(Boolean))];
  const nameFromAuth = new Map(
    authList.map((a) => [String(a.advertiser_id), a.advertiser_name || null])
  );

  const info = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const d = await mcpCall(client, "advertiser_info_get", {
      advertiser_ids: chunk,
      fields: ADV_FIELDS,
    });
    info.push(...(d?.list || []));
  }

  const bcName = new Map(bcs.map((b) => [String(b.bc_id), b.bc_name || b.name || null]));
  const now = new Date().toISOString();
  const seen = new Set();

  const rows = info.map((a) => {
    const id = String(a.advertiser_id);
    seen.add(id);
    return {
      connection_id: connectionId,
      advertiser_id: id,
      advertiser_name: a.name || nameFromAuth.get(id) || null,
      bc_id: a.owner_bc_id ? String(a.owner_bc_id) : null,
      bc_name: a.owner_bc_id ? bcName.get(String(a.owner_bc_id)) || null : null,
      currency: a.currency || null,
      timezone: a.timezone || null,
      display_timezone: a.display_timezone || null,
      status: a.status || null,
      role: a.role || null,
      country: a.country || null,
      updated_at: now,
    };
  });

  // Advertisers listed by auth_advertiser_get but absent from advertiser_info_get.
  for (const id of ids) {
    if (seen.has(id)) continue;
    rows.push({
      connection_id: connectionId,
      advertiser_id: id,
      advertiser_name: nameFromAuth.get(id) || null,
      updated_at: now,
    });
  }

  if (rows.length) {
    const { error } = await supabase
      .from("tiktok_advertisers")
      .upsert(rows, { onConflict: "connection_id,advertiser_id" });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return { advertiserCount: rows.length, businessCenterCount: bcs.length };
}
