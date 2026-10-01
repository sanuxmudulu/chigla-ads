// Site-wide login session: a signed "<expiry>.<hmac>" cookie. Separate from the
// existing per-action TIKTOK_ADMIN_PASSWORD modal (see tiktok-mcp.js) — this
// gate protects the whole site (both Ads and Organic), that one confirms a
// single sensitive action. Session length: 24h, sliding (renewed on every
// successful check), per 2026-10 decision.

const crypto = require("crypto");

const COOKIE_NAME = "chigla_session";
const MAX_AGE_S = 24 * 60 * 60; // 24 hours

function sign(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(input) {
  const want = process.env.SITE_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!want || !secret || !input) return false;
  // Compare HMACs (not the raw strings) so length differences don't leak anything.
  return safeEqual(sign(secret, "pw:" + input), sign(secret, "pw:" + want));
}

function makeSessionCookie() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  const value = `${exp}.${sign(secret, exp)}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function verifySessionToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(secret, exp));
}

function readCookie(cookieHeader, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader || "");
  return m ? decodeURIComponent(m[1]) : undefined;
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_S,
  checkPassword,
  makeSessionCookie,
  clearSessionCookie,
  verifySessionToken,
  readCookie,
};
