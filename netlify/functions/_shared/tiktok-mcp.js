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

// Dashboard admin password for TikTok write operations. Uses TIKTOK_ADMIN_PASSWORD
// if set, otherwise falls back to the existing NEW_DAY_PASSWORD env var so no
// Netlify config change is needed (the "New Day" feature itself is gone).
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

// bc_get returns `data.list[]` where the Business Center fields live under
// `item.bc_info` ({ bc_id, name, company, status, timezone, currency, ... }).
function extractBusinessCenters(bcListRaw) {
  return (bcListRaw || [])
    .map((item) => {
      const info = item.bc_info || item;
      const id = info.bc_id != null ? String(info.bc_id) : null;
      if (!id) return null;
      return { bc_id: id, bc_name: info.name || info.bc_name || info.company || null };
    })
    .filter(Boolean);
}

// Walks the authenticated TikTok user's Business Centers + advertiser accounts
// and upserts them into tiktok_advertisers. Descriptive columns only — `tracked`
// and `discovered_at` are left untouched so a re-scan preserves the selection.
// Also records the connection's Business Center identity on tiktok_connections.
async function discoverAndStoreAdvertisers({ supabase, client, connectionId }) {
  let bcs = [];
  try {
    const d = await mcpCall(client, "bc_get", {});
    bcs = extractBusinessCenters(d?.list);
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

  const bcName = new Map(bcs.map((b) => [b.bc_id, b.bc_name]));
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

  // Record the connection's Business Center identity. If bc_get returned exactly
  // one BC, use its name/id; otherwise fall back to a count so the UI label can
  // degrade gracefully (never invented from advertiser names).
  const bcSeenFromAdvertisers = new Map();
  for (const a of info) {
    if (a.owner_bc_id) {
      const bid = String(a.owner_bc_id);
      bcSeenFromAdvertisers.set(bid, bcName.get(bid) || bcSeenFromAdvertisers.get(bid) || null);
    }
  }
  // Prefer bc_get's list; supplement with any BC ids only seen via advertisers.
  const bcMerged = new Map(bcs.map((b) => [b.bc_id, b.bc_name]));
  for (const [bid, bname] of bcSeenFromAdvertisers) if (!bcMerged.has(bid)) bcMerged.set(bid, bname);

  const bcList = [...bcMerged.entries()].map(([bc_id, bc_name]) => ({ bc_id, bc_name }));
  const connPatch = { updated_at: now };
  if (bcList.length === 1) {
    connPatch.bc_id = bcList[0].bc_id;
    connPatch.bc_name = bcList[0].bc_name || null;
    connPatch.bc_count = 1;
  } else {
    connPatch.bc_id = null;
    connPatch.bc_name = bcList.map((b) => b.bc_name).filter(Boolean).join(", ") || null;
    connPatch.bc_count = bcList.length;
  }

  // affiliate_network is user-controlled (modal toggle) — never touched here.
  // Non-fatal: if the bc_* columns aren't added yet, the UI label just falls
  // back to the authenticated email until the migration is run.
  const up = await supabase.from("tiktok_connections").update(connPatch).eq("id", connectionId);
  if (up.error && /bc_(id|name|count)/.test(up.error.message || "")) {
    await supabase.from("tiktok_connections").update({ updated_at: now }).eq("id", connectionId);
  }

  return { advertiserCount: rows.length, businessCenterCount: bcList.length, businessCenters: bcList };
}

// ---------------------------------------------------------------------------
// Effective campaign status
//
// The authoritative CURRENT state comes from the live `secondary_status` /
// `operation_status` fields on the ad group (`/adgroup/get/`) and campaign
// (`/campaign/get/`). `/adgroup/review_info/` is used ONLY for review facts
// that are themselves current — `contains_rejected_ads` and `appeal_status` —
// never as a standalone "was once rejected" trigger, so a historical
// rejection that has since been appealed and approved does NOT keep the row
// marked Rejected.
//
// Real samples: campaign `CAMPAIGN_STATUS_DISABLE` / `CAMPAIGN_STATUS_BUDGET_EXCEED`
// / `ADVERTISER_ACCOUNT_PUNISH`; ad group `ADGROUP_STATUS_CAMPAIGN_DISABLE` /
// `ADGROUP_STATUS_DELIVERY_OK` / `ADGROUP_STATUS_DISABLE` / `ADGROUP_STATUS_AUDIT`;
// advertiser `STATUS_ENABLE` / `STATUS_LIMIT`. adgroup/review_info gives
// `is_approved`, `review_status` (`ALL_AVAILABLE`/`PART_AVAILABLE`/`UNAVAILABLE`),
// `contains_rejected_ads` (bool), `appeal_status` (`NOT_APPEALED` / appeal states).
// ---------------------------------------------------------------------------

function accountHealthy(raw) {
  const s = String(raw || "").toUpperCase();
  return s === "" || s === "STATUS_ENABLE";
}

function accountLooksPunished(campaignSecondary) {
  const s = String(campaignSecondary || "").toUpperCase();
  return s.includes("ADVERTISER") || s.includes("ACCOUNT") || s.includes("PUNISH");
}

// Coarse bucket for one ad group's CURRENT operating status.
function classifyDelivery(raw) {
  const s = String(raw || "").toUpperCase();
  if (!s) return "unknown";
  if (s.includes("DENY") || s.includes("REJECT") || s.includes("DISAPPROV") || s.includes("NOT_APPROV"))
    return "rejected";
  if (s.includes("DELIVERY_OK") || s.endsWith("_OK") || s.includes("DELIVERING")) return "active";
  if (s.includes("AUDIT") || s.includes("REVIEW") || s.includes("PENDING") || s.includes("CHECKING"))
    return "in_review";
  if (s.includes("NOT_START") || s.includes("NOT_YET") || s.includes("SCHEDULE")) return "scheduled";
  if (s.includes("BALANCE") || s.includes("BUDGET") || s.includes("EXCEED") || s.includes("NO_BUDGET"))
    return "budget";
  if (s.includes("DONE") || s.includes("FINISH") || s.includes("COMPLETE") || s.includes("EXPIR"))
    return "done";
  if (s.includes("CAMPAIGN_DISABLE") || s.includes("CAMPAIGN_PAUSE")) return "campaign_paused";
  if (s.includes("ADVERTISER") || s.includes("ACCOUNT") || s.includes("PUNISH") || s.includes("FROZEN") || s.includes("LIMIT"))
    return "account";
  if (s.includes("DELETE")) return "deleted";
  if (s.includes("DISABLE") || s.includes("PAUSE")) return "paused"; // ad group / ad paused
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

// Is this ad group CURRENTLY rejected / in review, per its own review record?
// `review` is one entry from adgroup/review_info's `ad_group_review_map`.
function reviewState(review) {
  if (!review) return null;
  const rs = String(review.review_status || "").toUpperCase();
  const appeal = String(review.appeal_status || "").toUpperCase();

  const appealPending =
    appeal.includes("PENDING") || appeal.includes("PROCESSING") || appeal.includes("APPEALING") || appeal.includes("IN_REVIEW");
  if (appealPending) return "in_review";

  const currentlyRejected =
    review.contains_rejected_ads === true ||
    (review.is_approved === false && (rs.includes("UNAVAILABLE") || rs === "" ));
  if (currentlyRejected) return "rejected";

  if (rs.includes("AUDIT") || rs.includes("REVIEW") || rs.includes("PENDING") || rs.includes("CHECKING"))
    return "in_review";

  return null; // approved / not a review problem -> defer to delivery status
}

// Derives ONE display status for a campaign row. Priority (as specified):
//   1. account suspended/limited/punished
//   2. an ad currently rejected (and not since re-approved / not mid-appeal)
//   3. an ad currently pending / in review / mid-appeal
//   4. campaign active with >= 1 delivering ad copy
//   5. scheduled / out of budget
//   6. whole campaign manually paused
//   7. all ad groups individually paused (campaign itself not paused)
// A few manually-paused ad groups never hide an "Active" row.
function deriveEffectiveStatus({ advertiserStatus, campaign, adGroups, reviewByAdGroupId }) {
  const campSecondary = campaign?.secondary_status || "";
  if (!accountHealthy(advertiserStatus) || accountLooksPunished(campSecondary)) {
    const s = String(advertiserStatus || "").toUpperCase();
    if (s.includes("PENDING") || s.includes("CONFIRM") || s.includes("UNAUDITED") || s.includes("VERIF"))
      return { label: "Account Pending", tone: "warn", detail: advertiserStatus || campSecondary || null };
    return { label: "Account Suspended", tone: "bad", detail: advertiserStatus || campSecondary || null };
  }

  const list = adGroups || [];
  const classes = list.map((ag) => {
    const rv = reviewState(reviewByAdGroupId ? reviewByAdGroupId[String(ag.adgroup_id)] : null);
    if (rv) return rv;
    // Manual pause on this ad group takes precedence over its (masked) secondary status.
    if (String(ag.operation_status || "").toUpperCase() === "DISABLE") return "paused";
    return classifyDelivery(ag.secondary_status || ag.operation_status);
  });

  const n = (c) => classes.filter((x) => x === c).length;
  const total = classes.length;
  const activeAdCount = n("active");

  if (total > 0) {
    if (n("rejected") > 0)
      return { label: "Rejected", tone: "bad", detail: "One or more ads are currently not approved", activeAdCount };
    if (n("in_review") > 0)
      return { label: "In Review", tone: "warn", detail: null, activeAdCount };
    if (activeAdCount > 0) return { label: "Active", tone: "good", detail: null, activeAdCount };
    if (n("scheduled") > 0) return { label: "Scheduled", tone: "neutral", detail: null, activeAdCount };
    if (n("budget") > 0) return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
    if (n("campaign_paused") === total)
      return { label: "Paused", tone: "neutral", detail: "Campaign paused", activeAdCount };
    if (n("paused") > 0 && n("campaign_paused") === 0)
      return { label: "Ad Groups Paused", tone: "warn", detail: "All ad groups are paused", activeAdCount };
    if (n("done") === total) return { label: "Completed", tone: "neutral", detail: null, activeAdCount };
    if (n("deleted") === total) return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  }

  const camp = String(campSecondary || campaign?.operation_status || "").toUpperCase();
  if (camp.includes("DELETE")) return { label: "Deleted", tone: "bad", detail: null, activeAdCount };
  if (camp.includes("BUDGET") || camp.includes("EXCEED"))
    return { label: "Out of Budget", tone: "warn", detail: null, activeAdCount };
  if (camp.includes("DISABLE") || camp.includes("PAUSE"))
    return { label: "Paused", tone: "neutral", detail: null, activeAdCount };
  if (camp.includes("ENABLE"))
    return { label: total ? "Inactive" : "No Ads", tone: "warn", detail: total ? null : "Campaign has no ads yet", activeAdCount };
  return { label: humanizeStatus(camp) || "Unknown", tone: "neutral", detail: null, activeAdCount };
}

// Per-ad-group display status for the expanded sub-rows. Manual pause wins;
// otherwise use current review state, then the live secondary status.
function deriveAdGroupStatus(adGroup, review) {
  const op = String(adGroup.operation_status || "").toUpperCase();
  const rv = reviewState(review);
  if (rv === "rejected") return { label: "Rejected", tone: "bad" };
  if (rv === "in_review") return { label: "In Review", tone: "warn" };
  if (op === "DISABLE") return { label: "Paused", tone: "neutral" };
  switch (classifyDelivery(adGroup.secondary_status || adGroup.operation_status)) {
    case "active":
      return { label: "Active", tone: "good" };
    case "in_review":
      return { label: "In Review", tone: "warn" };
    case "rejected":
      return { label: "Rejected", tone: "bad" };
    case "scheduled":
      return { label: "Scheduled", tone: "neutral" };
    case "budget":
      return { label: "Out of Budget", tone: "warn" };
    case "campaign_paused":
      return { label: "Campaign Paused", tone: "neutral" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "account":
      return { label: "Account Suspended", tone: "bad" };
    case "done":
      return { label: "Completed", tone: "neutral" };
    case "deleted":
      return { label: "Deleted", tone: "bad" };
    default:
      return { label: humanizeStatus(adGroup.secondary_status) || "Unknown", tone: "neutral" };
  }
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

const ADGROUP_STATUS_FIELDS = [
  "adgroup_id",
  "adgroup_name",
  "campaign_id",
  "operation_status",
  "secondary_status",
];

// Pulls every ad group + its current review record for one advertiser, grouped
// by campaign id. One adgroup/review_info call per 20 ad groups.
async function loadAdGroupsForAdvertiser(client, advertiserId) {
  const res = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    page_size: 1000,
  });
  const adGroups = res?.list || [];
  const ids = adGroups.map((g) => String(g.adgroup_id)).filter(Boolean);

  const reviewByAdGroupId = {};
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const rev = await mcpCall(client, "adgroup_review_info_get", {
        advertiser_id: advertiserId,
        adgroup_ids: ids.slice(i, i + 20),
      });
      Object.assign(reviewByAdGroupId, rev?.ad_group_review_map || {});
    } catch {
      /* review lookup is best-effort */
    }
  }

  const byCampaign = {};
  for (const g of adGroups) {
    const cid = String(g.campaign_id);
    (byCampaign[cid] = byCampaign[cid] || []).push(g);
  }
  return { byCampaign, reviewByAdGroupId };
}

// Discovers current campaigns (all non-deleted) inside the tracked advertiser
// accounts under one connection, derives an effective status for each from the
// CURRENT ad group + review state, and upserts them into tiktok_campaigns.
// Reuses a single MCP client for every advertiser in the connection.
async function discoverAndStoreCampaigns({ supabase, client, connectionId, trackedAdvertisers, affiliateNetwork }) {
  const now = new Date().toISOString();
  const rows = [];
  const seenCampaignIds = [];
  const scannedAdvIds = []; // advertisers whose campaign list we actually read
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

      let byCampaign = {};
      let reviewByAdGroupId = {};
      try {
        ({ byCampaign, reviewByAdGroupId } = await loadAdGroupsForAdvertiser(client, advId));
      } catch {
        /* fall back to campaign-level status only */
      }

      for (const campaign of campaigns) {
        const cid = String(campaign.campaign_id);
        const campAdGroups = byCampaign[cid] || [];
        const eff = deriveEffectiveStatus({
          advertiserStatus: adv.status,
          campaign,
          adGroups: campAdGroups,
          reviewByAdGroupId,
        });
        seenCampaignIds.push(cid);
        rows.push({
          campaign_id: cid,
          connection_id: connectionId,
          advertiser_id: advId,
          advertiser_name: adv.advertiser_name || null,
          bc_id: adv.bc_id || null,
          bc_name: adv.bc_name || null,
          affiliate_network: resolveBcNetwork(adv.bc_id, adv.bc_name, affiliateNetwork),
          campaign_name: campaign.campaign_name || cid,
          objective_type: campaign.objective_type || null,
          budget: campaign.budget != null ? Number(campaign.budget) : null,
          budget_mode: campaign.budget_mode || null,
          campaign_operation_status: campaign.operation_status || null,
          campaign_secondary_status: campaign.secondary_status || null,
          effective_status: eff.label,
          effective_tone: eff.tone,
          status_detail: eff.detail || null,
          ad_count: campAdGroups.length,
          active_ad_count: eff.activeAdCount || 0,
          create_time: parseTikTokTime(campaign.create_time),
          updated_at: now,
        });
      }
      scannedAdvIds.push(advId);
      perAdvertiser[advId] = campaigns.length;
    } catch (err) {
      perAdvertiser[advId] = `error: ${err.message}`;
    }
  }

  if (rows.length) {
    let { error } = await supabase.from("tiktok_campaigns").upsert(rows, { onConflict: "campaign_id" });
    // Degrade gracefully if the bc_id/bc_name/affiliate_network columns aren't
    // added yet (migration supabase/tiktok_bc_networks.sql).
    if (error && /bc_(id|name)|affiliate_network/.test(error.message || "")) {
      const stripped = rows.map(({ bc_id, bc_name, affiliate_network, ...rest }) => rest);
      ({ error } = await supabase.from("tiktok_campaigns").upsert(stripped, { onConflict: "campaign_id" }));
    }
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Drop rows for campaigns that no longer exist — but only for advertisers we
  // actually scanned this run (a failed campaign_get must not wipe that
  // account's rows) and never a locally-hidden row (suspended-account case).
  if (scannedAdvIds.length) {
    const runDelete = (withHiddenGuard) => {
      let q = supabase.from("tiktok_campaigns").delete().in("advertiser_id", scannedAdvIds);
      if (seenCampaignIds.length) q = q.not("campaign_id", "in", `(${seenCampaignIds.join(",")})`);
      if (withHiddenGuard) q = q.neq("hidden", true);
      return q;
    };
    const del = await runDelete(true);
    if (del.error && /hidden/.test(del.error.message || "")) await runDelete(false);
  }

  return { campaignCount: rows.length, perAdvertiser };
}

function parseTikTokTime(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(raw)) ? "" : "Z"));
  return isNaN(d) ? null : d.toISOString();
}

// YYYY-MM-DD "today" in a given IANA timezone (report_integrated_get interprets
// its date range in the ad account's timezone). Falls back to America/New_York.
function localToday(tzName) {
  const tz = tzName || "America/New_York";
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return p; // en-CA formats as YYYY-MM-DD
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// TikTok's CPA for this business == cost per optimization conversion (the
// instant-form / instant-page completion). `cost_per_result` is a fallback for
// campaigns whose "result" event is configured; last resort spend/conversion.
function tiktokCpa(m) {
  const cpc = num(m.cost_per_conversion);
  if (cpc > 0) return cpc;
  const cpr = num(m.cost_per_result);
  if (cpr > 0) return cpr;
  const conv = num(m.conversion) || num(m.result);
  const spend = num(m.spend);
  return conv > 0 ? spend / conv : 0;
}

// -------- lazy: one campaign's live detail (row status + ad groups + today) --
// Verifies nothing — the caller must confirm the campaign belongs to a tracked
// advertiser first. Returns the freshly-derived campaign status AND the ad
// group sub-rows (name/id/status/today's spend/today's CPA/operation_status).
async function loadCampaignDetail({ client, advertiserId, advertiserStatus, campaignId, timezone }) {
  let campaign = null;
  try {
    const cRes = await mcpCall(client, "campaign_get", {
      advertiser_id: advertiserId,
      fields: CAMPAIGN_FIELDS,
      filtering: { campaign_ids: [String(campaignId)] },
    });
    campaign = (cRes?.list || []).find((c) => String(c.campaign_id) === String(campaignId)) || null;
  } catch {
    /* keep going with ad-group data only */
  }

  const gRes = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    filtering: { campaign_ids: [String(campaignId)] },
    page_size: 1000,
  });
  const adGroups = (gRes?.list || []).filter((g) => String(g.campaign_id) === String(campaignId));
  const ids = adGroups.map((g) => String(g.adgroup_id));

  const reviewById = {};
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const rev = await mcpCall(client, "adgroup_review_info_get", {
        advertiser_id: advertiserId,
        adgroup_ids: ids.slice(i, i + 20),
      });
      Object.assign(reviewById, rev?.ad_group_review_map || {});
    } catch {
      /* best-effort */
    }
  }

  const metricsById = {};
  if (ids.length) {
    const today = localToday(timezone);
    try {
      const rep = await mcpCall(client, "report_integrated_get", {
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_ADGROUP",
        advertiser_id: advertiserId,
        dimensions: ["adgroup_id"],
        metrics: ["spend", "conversion", "cost_per_conversion", "result", "cost_per_result", "impressions", "clicks"],
        start_date: today,
        end_date: today,
        filtering: [{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([String(campaignId)]) }],
        page_size: 1000,
      });
      for (const row of rep?.list || []) {
        const id = String(row.dimensions?.adgroup_id || "");
        if (id) metricsById[id] = row.metrics || {};
      }
    } catch {
      /* metrics best-effort — rows still render with 0 */
    }
  }

  const eff = deriveEffectiveStatus({
    advertiserStatus,
    campaign: campaign || {},
    adGroups,
    reviewByAdGroupId: reviewById,
  });

  const rows = adGroups.map((g) => {
    const id = String(g.adgroup_id);
    const m = metricsById[id] || {};
    const st = deriveAdGroupStatus(g, reviewById[id]);
    return {
      adgroup_id: id,
      adgroup_name: g.adgroup_name || id,
      operation_status: g.operation_status || null, // ENABLE / DISABLE -> button label
      status_label: st.label,
      status_tone: st.tone,
      spend: num(m.spend),
      cpa: tiktokCpa(m),
      conversions: num(m.conversion) || num(m.result),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
    };
  });

  return {
    campaign_operation_status: campaign?.operation_status || null,
    campaign_secondary_status: campaign?.secondary_status || null,
    effective_status: eff.label,
    effective_tone: eff.tone,
    status_detail: eff.detail || null,
    ad_count: adGroups.length,
    active_ad_count: eff.activeAdCount || 0,
    adGroups: rows,
  };
}

// -------- writes --------

async function setCampaignStatus({ client, advertiserId, campaignId, operationStatus }) {
  await mcpCall(client, "campaign_status_update", {
    advertiser_id: advertiserId,
    campaign_ids: [String(campaignId)],
    operation_status: operationStatus, // ENABLE | DISABLE
  });
  const res = await mcpCall(client, "campaign_get", {
    advertiser_id: advertiserId,
    fields: CAMPAIGN_FIELDS,
    filtering: { campaign_ids: [String(campaignId)] },
  });
  return (res?.list || []).find((c) => String(c.campaign_id) === String(campaignId)) || null;
}

// Permanently deletes a campaign in TikTok. `campaign_status_update` with
// operation_status DELETE is the documented delete operation — "Deleted
// campaigns cannot be modified afterward." Throws (via mcpCall) when TikTok
// refuses, e.g. the advertiser account is suspended/limited; the caller decides
// whether to fall back to hiding the row locally.
async function deleteCampaign({ client, advertiserId, campaignId }) {
  await mcpCall(client, "campaign_status_update", {
    advertiser_id: String(advertiserId),
    campaign_ids: [String(campaignId)],
    operation_status: "DELETE",
  });
  return { ok: true };
}

async function setAdGroupStatus({ client, advertiserId, adGroupId, operationStatus }) {
  await mcpCall(client, "adgroup_status_update", {
    advertiser_id: advertiserId,
    adgroup_ids: [String(adGroupId)],
    operation_status: operationStatus, // ENABLE | DISABLE
  });
  const res = await mcpCall(client, "adgroup_get", {
    advertiser_id: advertiserId,
    fields: ADGROUP_STATUS_FIELDS,
    filtering: { adgroup_ids: [String(adGroupId)] },
  });
  return (res?.list || []).find((g) => String(g.adgroup_id) === String(adGroupId)) || null;
}

// -------- affiliate network association --------

const NETWORKS = ["GLITCHY", "MABAC"];
function normalizeNetwork(v) {
  const s = String(v || "").toUpperCase();
  return NETWORKS.includes(s) ? s : "GLITCHY";
}

// Which affiliate network owns a Business Center's campaigns. The single source
// of truth is the per-connection tiktok_connections.affiliate_network column
// (set from the modal's Glitchy/Mabac toggle). Missing -> GLITCHY (preserves
// existing behaviour).
function resolveBcNetwork(_bcId, _bcName, storedNetwork) {
  return normalizeNetwork(storedNetwork);
}

// -------- advertiser account budget / Business Center balance --------
//
// Real TikTok model (verified against the live BC):
//  * bc/balance/get      -> ONE shared balance pool per Business Center
//                           (valid_account_balance). Ad accounts under a SHARED
//                           payment portfolio all draw from this pool.
//  * advertiser/balance/get (needs bc_id) -> per ad account:
//        budget_mode  (UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET)
//        budget       (the cap amount; 0 when UNLIMITED)
//        budget_cost  (spent against that cap)
//        budget_remaining (cap - cost; only with the extra `fields`)
//  * advertiser/update (bc_id + advertiser_budgets + budget_update_type=UPDATE)
//        -> sets/changes/removes the per-account cap. Caller must be BC Admin
//           with finance_role MANAGER.

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getBcBalance({ client, bcId }) {
  try {
    const d = await mcpCall(client, "bc_balance_get", { bc_id: bcId });
    return {
      balance: toNum(d.valid_account_balance ?? d.account_balance),
      cash_balance: toNum(d.valid_cash_balance ?? d.cash_balance),
      currency: d.currency || "USD",
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Every ad account's budget/cap under a BC, keyed by advertiser_id.
async function getAdvertiserBudgets({ client, bcId }) {
  const byId = {};
  let page = 1;
  for (;;) {
    let d;
    try {
      d = await mcpCall(client, "advertiser_balance_get", {
        bc_id: bcId,
        fields: ["budget_remaining", "budget_amount_restriction"],
        page,
        page_size: 50,
      });
    } catch (err) {
      // retry without the extra fields (older BCs)
      if (page === 1) {
        try {
          d = await mcpCall(client, "advertiser_balance_get", { bc_id: bcId, page, page_size: 50 });
        } catch (e2) {
          return { error: e2.message };
        }
      } else {
        break;
      }
    }
    const list = d?.advertiser_account_list || [];
    for (const a of list) {
      const id = String(a.advertiser_id);
      const mode = String(a.budget_mode || "UNLIMITED").toUpperCase();
      const cap = toNum(a.budget);
      const spent = toNum(a.budget_cost);
      const remaining = a.budget_remaining != null ? toNum(a.budget_remaining) : Math.max(0, cap - spent);
      byId[id] = {
        advertiser_id: id,
        budget_mode: mode,
        capped: mode !== "UNLIMITED" && cap > 0,
        cap,
        spent,
        remaining,
        min_cap: toNum(a.budget_amount_restriction?.minimum_amount),
        account_balance: toNum(a.valid_account_balance ?? a.account_balance),
        currency: a.currency || "USD",
        status: a.advertiser_status || null,
      };
    }
    const info = d?.page_info || {};
    if (!info.total_page || page >= info.total_page) break;
    page += 1;
    if (page > 40) break; // safety
  }
  return { byId };
}

// UPDATE / set / remove one ad account's cap.
//   budgetMode: UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET
//   budget:     cap amount (ignored when UNLIMITED)
async function setAdvertiserBudget({ client, bcId, advertiserId, budgetMode, budget }) {
  const mode = String(budgetMode || "").toUpperCase();
  const item = { advertiser_id: String(advertiserId), budget_mode: mode };
  if (mode !== "UNLIMITED") item.budget = toNum(budget);

  await mcpCall(client, "advertiser_update", {
    bc_id: bcId,
    budget_update_type: "UPDATE",
    advertiser_budgets: [item],
  });

  // Re-read this one account.
  const d = await mcpCall(client, "advertiser_balance_get", {
    bc_id: bcId,
    fields: ["budget_remaining", "budget_amount_restriction"],
    filtering: { keyword: String(advertiserId) },
    page_size: 50,
  });
  const a = (d?.advertiser_account_list || []).find((x) => String(x.advertiser_id) === String(advertiserId));
  if (!a) return null;
  const m = String(a.budget_mode || "UNLIMITED").toUpperCase();
  const cap = toNum(a.budget);
  const spent = toNum(a.budget_cost);
  return {
    advertiser_id: String(advertiserId),
    budget_mode: m,
    capped: m !== "UNLIMITED" && cap > 0,
    cap,
    spent,
    remaining: a.budget_remaining != null ? toNum(a.budget_remaining) : Math.max(0, cap - spent),
    account_balance: toNum(a.valid_account_balance ?? a.account_balance),
    currency: a.currency || "USD",
  };
}

module.exports = {
  DEFAULT_MCP_SERVER_URL,
  MCP_SCOPE,
  NETWORKS,
  normalizeNetwork,
  resolveBcNetwork,
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
  deriveAdGroupStatus,
  loadCampaignDetail,
  setCampaignStatus,
  setAdGroupStatus,
  deleteCampaign,
  getBcBalance,
  getAdvertiserBudgets,
  setAdvertiserBudget,
};
