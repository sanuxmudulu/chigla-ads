// Site-wide login. Checked by the root middleware.js before any page loads.
const { checkPassword, makeSessionCookie } = require("./_shared/session");

exports.handler = async function (event) {
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    /* fall through to the password check below, which fails on empty input */
  }

  if (!process.env.SITE_PASSWORD || !process.env.SESSION_SECRET) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "SITE_PASSWORD / SESSION_SECRET not set in Vercel env vars." }),
    };
  }

  if (!checkPassword(body.password)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Wrong password" }) };
  }

  return {
    statusCode: 200,
    headers: { "Set-Cookie": makeSessionCookie() },
    body: JSON.stringify({ ok: true }),
  };
};
