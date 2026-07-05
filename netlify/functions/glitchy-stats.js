// This runs on Netlify's server, not in the browser.
// Your Glitchy token stays here — never sent to the frontend.

const { todayEst, resolveSessionRange, summarizeWithBaseline } = require("./_shared/glitchy-session");

exports.handler = async function (event) {
  try {
    const token = process.env.GLITCHY_TOKEN;

    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "GLITCHY_TOKEN is missing. Add it in Netlify → Site settings → Environment variables.",
        }),
      };
    }

    // Read startDate/endDate from the URL query, e.g. ?startDate=2026-07-04&endDate=2026-07-05
    // Defaults to today (EST, matching Glitchy's hour field) if not provided.
    const params = event.queryStringParameters || {};
    const today = todayEst();
    const requestedStart = params.startDate || today;
    const requestedEnd = params.endDate || today;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    let effectiveStartDate = requestedStart;
    let effectiveEndDate = requestedEnd;
    let baselineBySource = {};
    let sessionExtended = false;

    if (supabaseUrl && supabaseKey) {
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(supabaseUrl, supabaseKey);

      try {
        const session = await resolveSessionRange(supabase, requestedStart, requestedEnd);
        effectiveStartDate = session.effectiveStartDate;
        effectiveEndDate = session.effectiveEndDate;
        baselineBySource = session.baselineBySource;
        sessionExtended = session.sessionExtended;
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: "Supabase read failed", details: err.message }),
        };
      }
    }

    const url = `https://api.glitchy.com/v3/stats?rangeTypeValue=Today&startDate=${effectiveStartDate}&endDate=${effectiveEndDate}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/plain, */*",
      },
    });

    // If Glitchy rejects the token (expired, revoked, etc), this catches it
    // instead of silently returning garbage.
    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `Glitchy responded with status ${response.status}`,
          details: text.slice(0, 500), // trim in case it's a huge HTML error page
        }),
      };
    }

    const data = await response.json();

    // The raw response is a list of entries, each with its own Stat + Offer block.
    // We don't know the exact top-level shape yet (list vs single object) —
    // this handles both so we don't crash either way.
    const entries = Array.isArray(data) ? data : data.data || data.results || [data];

    const bySource = summarizeWithBaseline(entries, baselineBySource, effectiveEndDate);
    const sources = Object.keys(bySource).map((src) => ({ source: src, ...bySource[src] }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
        requestedStartDate: requestedStart,
        session_extended: sessionExtended,
        raw_entry_count: entries.length,
        sources,
        // Keep the raw data in the response too, for now — helps us debug
        // if grouping looks wrong. We'll remove this once it's stable.
        raw: entries,
      }),
    };
  } catch (err) {
    // Catches network failures, JSON parse errors, anything unexpected.
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Function crashed",
        message: err.message,
        stack: err.stack,
      }),
    };
  }
};
