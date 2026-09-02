// GET /.netlify/functions/mabac-stats?startDate=&endDate=
//
// Mabac "Sub ID Report" for the EST calendar day (default today), grouped by
// sub1 (== the TikTok campaign name == Glitchy "source" equivalent).
//
// Always returns HTTP 200 so the dashboard never breaks — when Mabac isn't
// configured yet it returns { configured: false, sources: [] } and the
// dashboard just runs Glitchy-only.

const { todayEst } = require("./_shared/glitchy-daily");
const { fetchMabacSubIdReport } = require("./_shared/mabac");

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const today = todayEst();
  const startDate = params.startDate || today;
  const endDate = params.endDate || today;

  try {
    const result = await fetchMabacSubIdReport({ startDate, endDate });
    return { statusCode: 200, body: JSON.stringify({ startDate, endDate, ...result }) };
  } catch (err) {
    // Configured but the request failed — surface it without breaking the page.
    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate,
        endDate,
        configured: true,
        error: err.message,
        details: err.details || null,
        sources: [],
      }),
    };
  }
};
