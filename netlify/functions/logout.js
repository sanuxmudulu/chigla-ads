const { clearSessionCookie } = require("./_shared/session");

exports.handler = async function () {
  return {
    statusCode: 200,
    headers: { "Set-Cookie": clearSessionCookie() },
    body: JSON.stringify({ ok: true }),
  };
};
