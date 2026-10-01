// Site-wide login gate (added 2026-10). Protects every page (Ads, Organic) behind
// one password, separate from the existing per-action TIKTOK_ADMIN_PASSWORD modal
// (see netlify/functions/_shared/tiktok-mcp.js), which still works exactly as before.
//
// .mjs (not .js) so this one file runs as ESM without adding "type": "module" to
// package.json, which would otherwise turn every existing CommonJS netlify/functions/
// file into a syntax error. Verification logic is duplicated (not imported) from
// netlify/functions/_shared/session.js to avoid any cross-directory bundling
// uncertainty in Vercel's separate Routing Middleware build step.
import { next } from "@vercel/functions";
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "chigla_session";
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);

function sign(secret, msg) {
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hasValidSession(request) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const m = COOKIE_RE.exec(request.headers.get("cookie") || "");
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(secret, exp));
}

export const config = {
  // Everything except /api/*, static assets, and the login page itself.
  matcher: ["/((?!api/|css/|js/|assets/|favicon\\.ico|login\\.html).*)"],
};

export default function middleware(request) {
  if (hasValidSession(request)) return next();
  const url = new URL(request.url);
  const dest = new URL("/login.html", url.origin);
  dest.searchParams.set("redirect", url.pathname + url.search);
  return Response.redirect(dest, 302);
}
