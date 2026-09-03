// Generic server-side engagement-order abstraction.
//
// ⚠ SAFETY — READ BEFORE EXTENDING:
// This module NEVER contacts a third-party artificial-engagement / SMM service.
// Today every call is STORED-ONLY: an engagement_orders row is written with
// status READY and nothing leaves this server. This file is only the *seam*
// where an APPROVED provider adapter could be added later.
//
// A future approved adapter MUST:
//   • live entirely inside this directory (server-side, Netlify Functions only)
//   • read its credentials from process.env using the generic names
//       ENGAGEMENT_LIKES_API_KEY
//       ENGAGEMENT_SAVES_API_KEY
//       ENGAGEMENT_COMMENTS_API_KEY
//     — NEVER from the frontend, NEVER hard-coded, NEVER logged, NEVER returned
//       from a Netlify Function
//   • translate { provider, kind, campaignId, serviceId, link, quantity, comments }
//     into that provider's request shape
//   • be dispatched ONLY from submitEngagementOrder() below
//
// To add one: create ./engagement-providers/<name>.js exporting
//   async function submit({ kind, campaignId, serviceId, link, quantity, comments })
//     -> { ok, status, providerRef?, provider?, message }
// and register it in PROVIDERS. Nothing else in the codebase changes.
//
// `kind` is LIKES | SAVES | COMMENTS | AUTO — used to pick which
// ENGAGEMENT_<KIND>_API_KEY the adapter reads.

const PROVIDERS = {
  // "<name>": require("./engagement-providers/<name>"),   // e.g. an approved, ToS-compliant provider
};

function listProviders() {
  return Object.keys(PROVIDERS);
}

// Normalises a raw multiline string OR array into a clean array of one comment
// per non-empty line.
function parseComments(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean);
}

// The single dispatch point for every engagement order.
//
// Returns { ok, submitted, status, providerRef?, message }.
//   - submitted:false + status:"READY"  => stored only, awaiting an approved integration (the ONLY path today)
//   - submitted:true                    => a registered approved adapter handled it (future)
//
// It performs NO network calls unless a provider is BOTH named AND registered in
// PROVIDERS — which is never the case in this foundation build.
async function submitEngagementOrder({ provider, kind, campaignId, serviceId, link, quantity, comments } = {}) {
  if (!link) {
    return { ok: false, submitted: false, status: "FAILED", message: "No target link (TikTok post URL) provided." };
  }

  const count = Array.isArray(comments) ? comments.length : Number(quantity) || 0;
  const name = String(provider || process.env.ENGAGEMENT_PROVIDER || "").trim().toLowerCase();
  const adapter = name ? PROVIDERS[name] : null;

  if (!adapter) {
    return {
      ok: true,
      submitted: false,
      status: "READY",
      message:
        `Stored locally — no approved engagement provider is configured. ` +
        `${count} item(s) are ready for an approved integration. Nothing was sent to any external service.`,
    };
  }

  // Not reachable in this build. A registered adapter reads its own key from
  // process.env inside its module and never returns it here.
  try {
    const r = await adapter.submit({ kind, campaignId, serviceId, link, quantity: count, comments });
    return {
      ok: !!r.ok,
      submitted: r.ok !== false,
      status: r.status || (r.ok ? "SUBMITTED" : "FAILED"),
      providerRef: r.providerRef || null,
      message: r.message || "",
    };
  } catch (err) {
    // Never surface provider internals / credentials in the error.
    return { ok: false, submitted: false, status: "FAILED", message: "Engagement provider adapter failed." };
  }
}

module.exports = { submitEngagementOrder, listProviders, parseComments };
