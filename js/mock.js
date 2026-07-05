// Mock data generators — ONLY for things TikTok's API would provide once
// connected (spend, CPM, impressions-derived ROAS/type). Everything here is
// deterministic (seeded by source name + date) so numbers don't jitter
// randomly across refreshes, only evolve when the date changes.
// Real numbers (clicks, conversions, payout) come from Glitchy — see api.js.

import { seededRng, rngRange, rngPick } from "./seed.js";

const AD_TYPES = ["ABO", "CBO"];

export function mockAccounts() {
  return [
    { id: "acc_1", name: "Chigla Main BM", region: "US", status: "active" },
    { id: "acc_2", name: "Chigla Backup BM", region: "UK", status: "active" },
    { id: "acc_3", name: "Chigla Scale BM", region: "CA", status: "suspended" },
  ];
}

// Deterministic per-source "TikTok profile" for a given date: campaign type,
// a spend baseline, and a CPM baseline. Clicks/conversions stay real.
export function mockSourceProfile(sourceName, dateStr) {
  const rng = seededRng(`${sourceName}::${dateStr}`);
  const type = rngPick(rng, AD_TYPES);
  const baseSpend = rngRange(rng, 18, 340);
  const cpm = rngRange(rng, 6, 22);
  return { type, baseSpend, cpm };
}

// Spend derived from clicks so it feels internally consistent (more clicks
// roughly implies more spend) while still being fully mock and deterministic.
export function mockSpendForSource(sourceName, dateStr, clicks) {
  const { baseSpend } = mockSourceProfile(sourceName, dateStr);
  const clickFactor = 1 + Math.log10(1 + clicks) * 0.6;
  return Math.round(baseSpend * clickFactor * 100) / 100;
}

// Distributes a source's daily mock spend across 24 hours using a realistic
// "ramps up midday, tapers at night" curve, seeded for stability.
export function mockHourlySpendCurve(sourceName, dateStr, totalSpend) {
  const rng = seededRng(`${sourceName}::${dateStr}::hourly`);
  const weights = [];
  for (let h = 0; h < 24; h++) {
    // bell-ish curve centered ~15:00 with jitter
    const distFromPeak = Math.abs(h - 15);
    const base = Math.max(0.15, 1.4 - distFromPeak * 0.09);
    weights.push(base * rngRange(rng, 0.7, 1.3));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((w / sum) * totalSpend * 100) / 100);
}

// Mock hourly earnings curve for individual-source chart view (real Glitchy
// data is only broken out hourly for "All Sources Combined" via raw entries).
export function mockHourlyEarningsCurve(sourceName, dateStr, totalEarnings) {
  const rng = seededRng(`${sourceName}::${dateStr}::earnings-hourly`);
  const weights = [];
  for (let h = 0; h < 24; h++) {
    const distFromPeak = Math.abs(h - 17);
    const base = Math.max(0.1, 1.3 - distFromPeak * 0.08);
    weights.push(base * rngRange(rng, 0.6, 1.4));
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.round((w / sum) * totalEarnings * 100) / 100);
}

// Deterministic mock day total (used only to backfill calendar days that
// predate any real daily_totals row, e.g. before this dashboard existed).
export function mockDayTotals(dateStr) {
  const rng = seededRng(`daytotal::${dateStr}`);
  const spend = rngRange(rng, 80, 620);
  const roasFactor = rngRange(rng, 0.6, 1.9);
  const earnings = spend * roasFactor;
  return {
    total_spend: Math.round(spend * 100) / 100,
    total_earnings: Math.round(earnings * 100) / 100,
  };
}

// Small continuous "live jitter" nudge (+/- ~0.4%) applied to mock-derived
// figures between real refresh cycles, purely cosmetic, so the dashboard
// never looks frozen even when Glitchy hasn't returned new data yet.
export function jitter(value, magnitude = 0.004) {
  const delta = (Math.random() * 2 - 1) * magnitude;
  return value * (1 + delta);
}
