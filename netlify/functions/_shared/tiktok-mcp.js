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
//
// CommonJS on purpose — matches the existing glitchy-* functions and avoids
// ESM/CJS interop hazards when Netlify's bundler inlines `ws` / the SDK.

const { createClient } = require("@supabase/supabase-js");
const WebSocketImpl = require("ws");
const { randomUUID } = require("node:crypto");
const { auth } = require("@modelcontextprotocol/sdk/client/auth.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const DEFAULT_MCP_SERVER_URL =
  "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat";

const MCP_SCOPE = "mcp:tt4b";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function resolveConfig() {
  const serverUrl = process.env.TIKTOK_MCP_SERVER_URL || DEFAULT_MCP_SERVER_URL;

  const base = (
    process.env.APP_BASE_URL ||
    process.env.URL || // Netlify: site's primary URL
    process.env.DEPLOY_PRIME_URL || // Netlify: deploy-specific URL
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

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars in Netlify.");
  }
  // @supabase/supabase-js builds a RealtimeClient inside createClient(), which
  // demands a WebSocket constructor at construction time. Netlify's Lambda Node
  // runtime does not reliably expose a global `WebSocket` (only Node >= 22.4
  // does, and the functions runtime may lag the build's NODE_VERSION), so we
  // hand it an explicit implementation. We never use Realtime — this just keeps
  // createClient() from throwing "native WebSocket not found".
  return createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: WebSocketImpl },
  });
}

// Reuses the New Day password unless a dedicated one is set.
function checkPassword(supplied) {
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

const json = (statusCode, obj) => ({
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

class SupabaseOAuthProvider {
  constructor({ supabase, serverUrl, redirectUrl, transaction = null, connection = null }) {
    this.supabase = supabase;
    this.serverUrl = serverUrl;
    this._redirectUrl = redirectUrl;
    this._transaction = transaction;
    this._connection = connection;

    this._state = transaction?.state || randomUUID();
    this._codeVerifier = transaction?.code_verifier || null;

    this._authorizationUrl = null; // captured from redirectToAuthorization()
    this._pendingTokens = null; // raw SDK tokens from the current flow
    this._resolvedTokens = null; // stored-shape tokens for the caller to persist
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

async function connectMcp({ provider, serverUrl }) {
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
async function mcpCall(client, name, args = {}) {
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
async function discoverAndStoreAdvertisers({ supabase, client, connectionId }) {
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

// ---------------------------------------------------------------------------
// Effective campaign status
//
// The TikTok status vocabulary is large and can change, so this classifies by
// KEYWORD on the raw status strings rather than matching an exact enum. Real
// samples seen from the API: campaign `CAMPAIGN_STATUS_DISABLE`, ad
// `AD_STATUS_CAMPAIGN_DISABLE` / `AD_STATUS_DELIVERY_OK` / `AD_STATUS_AUDIT` /
// `AD_STATUS_AUDIT_DENY`, ad group `ADGROUP_STATUS_CAMPAIGN_DISABLE`, advertiser
// `STATUS_ENABLE` / `STATUS_LIMIT`. `ad/review_info` gives is_approved +
// review_status (`ALL_AVAILABLE` / `PART_AVAILABLE` / `UNAVAILABLE`).
// ---------------------------------------------------------------------------

function accountHealthy(raw) {
  return String(raw || "").toUpperCase() === "STATUS_ENABLE";
}

// Maps one ad's raw delivery status to a coarse bucket.
function classifyAdDelivery(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("DELIVERY_OK") || s.endsWith("_OK") || s.includes("DELIVERING")) return "active";
  if (s.includes("DENY") || s.includes("REJECT") || s.includes("DISAPPROV") || s.includes("NOT_APPROV"))
    return "rejected";
  if (s.includes("AUDIT") || s.includes("REVIEW") || s.includes("PENDING") || s.includes("CHECKING"))
    return "in_review";
  if (s.includes("NOT_START") || s.includes("NOT_YET") || s.includes("SCHEDULE")) return "scheduled";
  if (s.includes("BALANCE") || s.includes("BUDGET") || s.includes("EXCEED") || s.includes("NO_BUDGET"))
    return "budget";
  if (s.includes("DONE") || s.includes("FINISH") || s.includes("COMPLETE") || s.includes("EXPIR"))
    return "done";
  if (s.includes("CAMPAIGN_DISABLE") || s.includes("CAMPAIGN_PAUSE")) return "campaign_paused";
  if (s.includes("ADGROUP_DISABLE") || s.includes("AD_GROUP_DISABLE") || s.includes("ADGROUP_PAUSE"))
    return "adgroup_paused";
  if (s.includes("ADVERTISER") || s.includes("ACCOUNT") || s.includes("FROZEN") || s.includes("PUNISH") || s.includes("LIMIT"))
    return "account";
  if (s.includes("DELETE")) return "deleted";
  if (s.includes("DISABLE") || s.includes("PAUSE")) return "ad_paused";
  return "other";
}

function humanizeStatus(raw) {
  const s = String(raw || "").replace(/^(AD|ADGROUP|CAMPAIGN)_STATUS_/i, "").replace(/^STATUS_/i, "");
  if (!s) return null;
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Derives ONE display status for a campaign row from the advertiser status, the
// campaign status, and every ad's status/review. Follows the priority the
// dashboard owner asked for: account > rejected > in review > active > ...
// A few individually-paused ad groups do NOT make the row "Paused" as long as
// at least one copy of the ad is still delivering.
function deriveEffectiveStatus({ advertiserStatus, campaign, ads, reviewByAdId }) {
  if (!accountHealthy(advertiserStatus)) {
    const s = String(advertiserStatus || "").toUpperCase();
    if (s.includes("PENDING") || s.includes("AUDIT") || s.includes("CONFIRM") || s.includes("UNAUDITED") || s.includes("VERIF"))
      return { label: "Account Pending", tone: "warn", detail: advertiserStatus || null };
    return { label: "Account Suspended", tone: "bad", detail: advertiserStatus || null };
  }

  const list = ads || [];
  let rejectReason = null;

  const classes = list.map((ad) => {
    const rev = reviewByAdId ? reviewByAdId[String(ad.ad_id)] : null;
    if (rev) {
      const rs = String(rev.review_status || "").toUpperCase();
      if (rev.is_approved === false || rs.includes("UNAVAILABLE")) {
        if (!rejectReason) rejectReason = extractRejectReason(rev);
        return "rejected";
      }
      if (rs.includes("REVIEW") || rs.includes("AUDIT") || rs.includes("PENDING")) return "in_review";
    }
    return classifyAdDelivery(ad.secondary_status || ad.operation_status);
  });

  const n = (c) => classes.filter((x) => x === c).length;
  const total = classes.length;
  const activeAdCount = n("active");

  if (total > 0) {
    if (n("rejected") > 0)
      return { label: "Rejected", tone: "bad", detail: rejectReason || "One or more ads were not approved", activeAdCount };
    if (n("in_review") > 0)
      return { label: "In Review", tone: "warn", detail: null, activeAdCount };
    if (activeAdCount > 0)
      return { label: "Active", tone: "good", detail: null, activeAdCount };
    if (n("scheduled") > 0)
      return { label: "Scheduled", tone: "neutral", detail: null, activeAdCount };
    if (n("budget") > 0)
      return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
    if (n("campaign_paused") === total)
      return { label: "Paused", tone: "neutral", detail: "Campaign paused", activeAdCount };
    if (n("adgroup_paused") > 0 && n("campaign_paused") === 0)
      return { label: "Ad Groups Paused", tone: "warn", detail: "All ad groups are paused", activeAdCount };
    if (n("ad_paused") > 0 && n("campaign_paused") === 0)
      return { label: "Ads Paused", tone: "warn", detail: null, activeAdCount };
    if (n("done") > 0)
      return { label: "Completed", tone: "neutral", detail: null, activeAdCount };
    if (n("deleted") === total)
      return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  }

  const camp = String(campaign?.secondary_status || campaign?.operation_status || "").toUpperCase();
  if (camp.includes("DELETE")) return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  if (camp.includes("BUDGET") || camp.includes("EXCEED"))
    return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
  if (camp.includes("DISABLE") || camp.includes("PAUSE"))
    return { label: "Paused", tone: "neutral", detail: null, activeAdCount };
  if (camp.includes("ENABLE"))
    return { label: total ? "Inactive" : "No Ads", tone: "warn", detail: total ? null : "Campaign has no ads yet", activeAdCount };
  return { label: humanizeStatus(camp) || "Unknown", tone: "neutral", detail: null, activeAdCount };
}

function extractRejectReason(rev) {
  const infos = rev.reject_info || rev.audit_result || [];
  const arr = Array.isArray(infos) ? infos : [infos];
  for (const it of arr) {
    if (!it) continue;
    const r = it.reason || it.description || it.reject_reason || it.message || it.suggestion;
    if (r) return String(r).slice(0, 240);
  }
  return null;
}

const CAMPAIGN_FIELDS = [
  "campaign_id",
  "campaign_name",
  "operation_status",
  "secondary_status",
  "objective_type",
  "budget",
  "budget_mode",
  "create_time",
];

// Discovers TODAY's live campaigns (all non-deleted campaigns) inside the
// tracked advertiser accounts under one connection, derives an effective
// status for each, and upserts them into tiktok_campaigns. Reuses a single
// MCP client for every advertiser in the connection.
async function discoverAndStoreCampaigns({ supabase, client, connectionId, trackedAdvertisers }) {
  const now = new Date().toISOString();
  const rows = [];
  const seenCampaignIds = [];
  const perAdvertiser = {};

  for (const adv of trackedAdvertisers) {
    const advId = String(adv.advertiser_id);
    try {
      const campRes = await mcpCall(client, "campaign_get", {
        advertiser_id: advId,
        fields: CAMPAIGN_FIELDS,
        page_size: 200,
      });
      const campaigns = campRes?.list || [];

      let ads = [];
      try {
        const adRes = await mcpCall(client, "ad_get", {
          advertiser_id: advId,
          fields: ["ad_id", "ad_name", "adgroup_id", "campaign_id", "operation_status", "secondary_status"],
          page_size: 1000,
        });
        ads = adRes?.list || [];
      } catch {
        ads = [];
      }

      const adIds = ads.map((a) => String(a.ad_id)).filter(Boolean);
      const reviewByAdId = {};
      for (let i = 0; i < adIds.length; i += 100) {
        try {
          const rev = await mcpCall(client, "ad_review_info_get", {
            advertiser_id: advId,
            ad_ids: adIds.slice(i, i + 100),
          });
          Object.assign(reviewByAdId, rev?.ad_review_map || {});
        } catch {
          /* review lookup is best-effort */
        }
      }

      const adsByCampaign = {};
      for (const ad of ads) {
        const cid = String(ad.campaign_id);
        (adsByCampaign[cid] = adsByCampaign[cid] || []).push(ad);
      }

      for (const campaign of campaigns) {
        const cid = String(campaign.campaign_id);
        const campAds = adsByCampaign[cid] || [];
        const eff = deriveEffectiveStatus({
          advertiserStatus: adv.status,
          campaign,
          ads: campAds,
          reviewByAdId,
        });
        seenCampaignIds.push(cid);
        rows.push({
          campaign_id: cid,
          connection_id: connectionId,
          advertiser_id: advId,
          advertiser_name: adv.advertiser_name || null,
          campaign_name: campaign.campaign_name || cid,
          objective_type: campaign.objective_type || null,
          budget: campaign.budget != null ? Number(campaign.budget) : null,
          budget_mode: campaign.budget_mode || null,
          campaign_operation_status: campaign.operation_status || null,
          campaign_secondary_status: campaign.secondary_status || null,
          effective_status: eff.label,
          effective_tone: eff.tone,
          status_detail: eff.detail || null,
          ad_count: campAds.length,
          active_ad_count: eff.activeAdCount || 0,
          create_time: parseTikTokTime(campaign.create_time),
          updated_at: now,
        });
      }
      perAdvertiser[advId] = campaigns.length;
    } catch (err) {
      perAdvertiser[advId] = `error: ${err.message}`;
    }
  }

  if (rows.length) {
    const { error } = await supabase
      .from("tiktok_campaigns")
      .upsert(rows, { onConflict: "campaign_id" });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Drop rows for campaigns that no longer exist under these tracked advertisers.
  const advIds = trackedAdvertisers.map((a) => String(a.advertiser_id));
  if (advIds.length) {
    let q = supabase.from("tiktok_campaigns").delete().in("advertiser_id", advIds);
    if (seenCampaignIds.length) q = q.not("campaign_id", "in", `(${seenCampaignIds.join(",")})`);
    await q;
  }

  return { campaignCount: rows.length, perAdvertiser };
}

function parseTikTokTime(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(raw)) ? "" : "Z"));
  return isNaN(d) ? null : d.toISOString();
}

module.exports = {
  DEFAULT_MCP_SERVER_URL,
  MCP_SCOPE,
  auth,
  resolveConfig,
  getSupabase,
  checkPassword,
  json,
  SupabaseOAuthProvider,
  connectMcp,
  mcpCall,
  discoverAndStoreAdvertisers,
  discoverAndStoreCampaigns,
  deriveEffectiveStatus,
};
