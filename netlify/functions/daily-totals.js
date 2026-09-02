// Backs the Profit Calendar. Reads the `daily_totals` history table (one row
// per EST calendar date) and returns the requested month with net profit and
// ROAS derived per day. If the requested month contains today, today's row is
// refreshed first so the calendar is current even on a stale tab.
//
// total_spend stays 0 until TikTok metrics are merged into the daily history —
// so today net_profit == total_earnings and roas == 0, matching the KPI cards.

const {
  todayEst,
  supabaseClient,
  fetchGlitchy,
  upsertTodayTotals,
  networkByCampaignName,
} = require("./_shared/glitchy-daily");
const { fetchMabacSubIdReport } = require("./_shared/mabac");

exports.handler = async function (event) {
  try {
    const supabase = supabaseClient();
    if (!supabase) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars in Netlify." }),
      };
    }

    const params = event.queryStringParameters || {};
    const today = todayEst();
    const month = params.month || today.slice(0, 7); // YYYY-MM

    const [year, mon] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

    // Keep today's row current if it falls inside the requested month.
    const token = process.env.GLITCHY_TOKEN;
    let refresh = null;
    if (token && today >= monthStart && today <= monthEnd) {
      try {
        const { entries } = await fetchGlitchy(token, today, today);
        let mabacSources = [];
        try {
          const mb = await fetchMabacSubIdReport({ startDate: today, endDate: today });
          mabacSources = mb.sources || [];
        } catch (_) {
          /* Mabac optional */
        }
        const networkByName = await networkByCampaignName(supabase);
        refresh = await upsertTodayTotals(supabase, entries, { mabacSources, networkByName });
      } catch (err) {
        refresh = { error: err.message }; // non-fatal — stored history still renders
      }
    }

    const { data: rows, error } = await supabase
      .from("daily_totals")
      .select("*")
      .gte("date", monthStart)
      .lte("date", monthEnd)
      .order("date", { ascending: true });

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: "Supabase read failed", details: error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        month,
        today_refresh: refresh,
        days: (rows || []).map((r) => {
          const spend = Number(r.total_spend) || 0;
          const earnings = Number(r.total_earnings) || 0;
          return {
            date: r.date,
            total_spend: spend,
            total_earnings: earnings,
            total_clicks: Number(r.total_clicks || 0),
            total_conversions: Number(r.total_conversions || 0),
            net_profit: Math.round((earnings - spend) * 100) / 100,
            roas: spend > 0 ? Math.round((earnings / spend) * 10000) / 10000 : 0,
          };
        }),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Function crashed", message: err.message, stack: err.stack }),
    };
  }
};
