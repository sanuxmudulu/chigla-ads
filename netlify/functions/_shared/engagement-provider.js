// Server-side engagement-order dispatch.
//
// SAFETY / CONFIG:
//   • Every provider call happens ONLY on this server (Netlify / Vercel
//     Functions). Credentials come from process.env and are never logged,
//     returned to the browser, or placed in an error message.
//   • A provider is active only when its ENGAGEMENT_<KIND>_API_KEY is set. With
//     no key the order is STORED-ONLY (status READY, nothing leaves the server) —
//     exactly the old foundation behaviour.
//
// KIND -> panel:
//   LIKES     JustAnotherPanel   (ENGAGEMENT_LIKES_*)
//   SAVES     AutoSMMPanel       (ENGAGEMENT_SAVES_*)
//   COMMENTS  DripFeedPanel      (ENGAGEMENT_COMMENTS_*)  — service id comes from the UI
//
// Per kind the env vars are:
//   ENGAGEMENT_<KIND>_API_KEY       (secret — REQUIRED to activate)
//   ENGAGEMENT_<KIND>_API_URL       (default below)
//   ENGAGEMENT_<KIND>_SERVICE_ID    (default below; COMMENTS is overridden per-order by the modal)
//   ENGAGEMENT_<KIND>_QUANTITY      (LIKES / SAVES only; default below)

const panel = require("./engagement-providers/smm-panel");

function env(name, fallback = "") {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
function intEnv(name, fallback) {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const KIND_DEFAULTS = {
  LIKES: { provider: "justanotherpanel", url: "https://justanotherpanel.com/api/v2", service: "8979", quantity: 250 },
  SAVES: { provider: "autosmmpanel", url: "https://autosmmpanel.com/api/v2", service: "1277", quantity: 50 },
  COMMENTS: { provider: "dripfeedpanel", url: "https://dripfeedpanel.com/api/v2", service: "5824", quantity: 0 },
};

// Resolves the live config for one kind. `submitted` capable only when apiKey set.
function configFor(kind) {
  const k = String(kind || "").toUpperCase();
  const d = KIND_DEFAULTS[k];
  if (!d) return null;
  return {
    kind: k,
    provider: d.provider,
    apiUrl: env(`ENGAGEMENT_${k}_API_URL`, d.url),
    apiKey: env(`ENGAGEMENT_${k}_API_KEY`),
    serviceId: env(`ENGAGEMENT_${k}_SERVICE_ID`, d.service),
    quantity: intEnv(`ENGAGEMENT_${k}_QUANTITY`, d.quantity),
  };
}

// True when a real provider will be contacted for this kind.
function providerConfigured(kind) {
  const c = configFor(kind);
  return !!(c && c.apiKey);
}
function listProviders() {
  return Object.keys(KIND_DEFAULTS).filter(providerConfigured);
}

// One comment per non-empty trimmed line (same rule as the frontend helper).
function parseComments(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean);
}

// The single dispatch point for every engagement order.
//
// Returns { ok, submitted, status, provider, providerRef, quantity, message }.
//   submitted:false + status:"READY"      => stored only (no API key for this kind)
//   submitted:true  + status:"SUBMITTED"  => a panel accepted the order (providerRef = its order id)
//   ok:false        + status:"FAILED"     => a configured panel rejected it (message = why)
async function submitEngagementOrder({ kind, campaignId, serviceId, link, quantity, comments } = {}) {
  if (!link) {
    return { ok: false, submitted: false, status: "FAILED", message: "No target link (TikTok post URL) provided." };
  }
  const cfg = configFor(kind);
  if (!cfg) {
    return { ok: false, submitted: false, status: "FAILED", message: `Unknown engagement kind "${kind}".` };
  }

  const commentList = cfg.kind === "COMMENTS" ? parseComments(comments) : null;
  const qty = commentList && commentList.length ? commentList.length : Number(quantity) || cfg.quantity;
  // The modal's Service ID wins for COMMENTS; env/default otherwise.
  const service = String(serviceId || cfg.serviceId || "").trim();

  if (!cfg.apiKey) {
    return {
      ok: true,
      submitted: false,
      status: "READY",
      provider: null,
      quantity: qty,
      message:
        `Stored locally — ${cfg.kind} provider not configured ` +
        `(set ENGAGEMENT_${cfg.kind}_API_KEY). Nothing was sent to any external service.`,
    };
  }

  try {
    const orderRef = await panel.addOrder({
      apiUrl: cfg.apiUrl,
      apiKey: cfg.apiKey,
      serviceId: service,
      link,
      quantity: qty,
      comments: commentList,
    });
    return {
      ok: true,
      submitted: true,
      status: "SUBMITTED",
      provider: cfg.provider,
      providerRef: orderRef,
      quantity: qty,
      message: `${qty} ${cfg.kind.toLowerCase()} ordered on ${cfg.provider} (order ${orderRef}).`,
    };
  } catch (err) {
    // The panel's own error text is safe to surface (it never echoes the key);
    // still, keep it short and prefixed.
    return {
      ok: false,
      submitted: false,
      status: "FAILED",
      provider: cfg.provider,
      quantity: qty,
      message: `${cfg.provider}: ${String(err.message || "order failed").slice(0, 200)}`,
    };
  }
}

// Poll a placed order's delivery status. Returns { status, raw } or null when
// the kind's provider isn't configured / no order ref.
async function checkEngagementOrder({ kind, orderRef } = {}) {
  const cfg = configFor(kind);
  if (!cfg || !cfg.apiKey || !orderRef) return null;
  try {
    const raw = await panel.getStatus({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, orderRef });
    return { status: String(raw.status || "").trim() || "Unknown", raw };
  } catch (_) {
    return null;
  }
}

module.exports = {
  submitEngagementOrder,
  checkEngagementOrder,
  listProviders,
  providerConfigured,
  configFor,
  parseComments,
};
