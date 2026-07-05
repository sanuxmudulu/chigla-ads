// Shared by glitchy-stats.js and daily-totals.js.
//
// The tracking "day" isn't the calendar date — it's whatever's happened
// since the last time "Reset Day" was clicked. If real-world midnight
// passes and Glitchy rolls into a new calendar date before you've reset,
// you're still in the same session: the dashboard needs to keep summing
// from the last reset through today, not reset itself on the clock.
//
// This module resolves that session (the date range to actually query
// Glitchy for, and each source's baseline) and applies the baseline
// correction across however many calendar dates that session spans.

function todayEst() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Glitchy's Stat.date isn't guaranteed to already be a bare YYYY-MM-DD
// string — normalize defensively (and anchor to EST, same clock the hour
// field and reset_baselines use) so date comparisons are safe either way.
function normalizeDateKey(raw, fallback) {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  if (isNaN(d)) return fallback;
  const est = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}

// Looks up each source's most recent reset at or before `requestedEnd`, and —
// only when the requested range's end is today — extends the fetch window
// back to cover the least-recently-reset source, without ever narrowing a
// wider range the caller explicitly asked for.
async function resolveSessionRange(supabase, requestedStart, requestedEnd) {
  const today = todayEst();
  const effectiveEndDate = requestedEnd;
  let effectiveStartDate = requestedStart;

  const { data: baselines, error } = await supabase
    .from("reset_baselines")
    .select("*")
    .lte("reset_date", effectiveEndDate);

  if (error) throw new Error(`Supabase read failed: ${error.message}`);

  const baselineBySource = {};
  for (const b of baselines || []) {
    if (!baselineBySource[b.source_name] || b.reset_date > baselineBySource[b.source_name].reset_date) {
      baselineBySource[b.source_name] = b;
    }
  }

  if (effectiveEndDate === today) {
    const resetDates = Object.values(baselineBySource).map((b) => b.reset_date);
    if (resetDates.length) {
      const sessionStart = resetDates.reduce((min, d) => (d < min ? d : min));
      if (sessionStart < effectiveStartDate) effectiveStartDate = sessionStart;
    }
  }

  return {
    effectiveStartDate,
    effectiveEndDate,
    baselineBySource,
    sessionExtended: effectiveStartDate !== requestedStart,
    today,
  };
}

// Groups raw Glitchy entries by source + calendar date + hour, then applies
// the baseline: the boundary (reset date + reset hour) gets the snapshot
// subtracted, everything before it is dropped, everything after — including
// later calendar dates — counts in full.
function summarizeWithBaseline(entries, baselineBySource, fallbackDate) {
  const bySourceDateHour = {};
  const offerNameBySource = {};

  for (const entry of entries) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || !stat.source) continue;
    const src = stat.source;
    const dateKey = stat.date ? normalizeDateKey(stat.date, fallbackDate) : fallbackDate;
    const hr = stat.hour;
    bySourceDateHour[src] = bySourceDateHour[src] || {};
    bySourceDateHour[src][dateKey] = bySourceDateHour[src][dateKey] || {};
    bySourceDateHour[src][dateKey][hr] = bySourceDateHour[src][dateKey][hr] || { clicks: 0, conversions: 0, payout: 0, entries: 0 };
    bySourceDateHour[src][dateKey][hr].clicks += Number(stat.clicks || 0);
    bySourceDateHour[src][dateKey][hr].conversions += Number(stat.conversions || 0);
    bySourceDateHour[src][dateKey][hr].payout += Number(stat.payout || 0);
    bySourceDateHour[src][dateKey][hr].entries += 1;
    offerNameBySource[src] = entry.Offer?.name || entry.offer?.name || offerNameBySource[src] || null;
  }

  const result = {};
  for (const src of Object.keys(bySourceDateHour)) {
    const byDate = bySourceDateHour[src];
    const baseline = baselineBySource[src];
    let clicks = 0, conversions = 0, payout = 0, entryCount = 0;

    for (const dateKey of Object.keys(byDate)) {
      const hours = byDate[dateKey];
      for (const hr of Object.keys(hours)) {
        entryCount += hours[hr].entries;

        const onBoundary = baseline && dateKey === baseline.reset_date && hr === baseline.reset_hour;
        const beforeBoundary =
          baseline && (dateKey < baseline.reset_date || (dateKey === baseline.reset_date && hr < baseline.reset_hour));

        if (onBoundary) {
          clicks += Math.max(0, hours[hr].clicks - baseline.clicks_at_reset);
          conversions += Math.max(0, hours[hr].conversions - baseline.conversions_at_reset);
          payout += Math.max(0, hours[hr].payout - baseline.payout_at_reset);
        } else if (beforeBoundary) {
          continue;
        } else {
          clicks += hours[hr].clicks;
          conversions += hours[hr].conversions;
          payout += hours[hr].payout;
        }
      }
    }

    result[src] = {
      clicks,
      conversions,
      payout,
      entries_count: entryCount,
      offer_name: offerNameBySource[src],
      reset_applied: !!baseline,
    };
  }
  return result;
}

module.exports = { todayEst, resolveSessionRange, summarizeWithBaseline };
