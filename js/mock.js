// The only thing left here once TikTok's API is disconnected: which naming
// convention a source follows (ABO = per-ad, CBO = per-campaign — see the
// project's campaign structure notes). Everything TikTok would actually
// report (spend, CPM, CPA, CPNC, ROAS) is zeroed out in app.js instead of
// invented here, so real and placeholder numbers can never be confused.

import { seededRng, rngPick } from "./seed.js";

const AD_TYPES = ["ABO", "CBO"];

export function mockAccounts() {
  return [
    { id: "acc_1", name: "Chigla Main BM", status: "active" },
    { id: "acc_2", name: "Chigla Backup BM", status: "active" },
    { id: "acc_3", name: "Chigla Scale BM", status: "suspended" },
  ];
}

// Deterministic per source+date so it doesn't change on every refresh.
export function mockSourceProfile(sourceName, dateStr) {
  const rng = seededRng(`${sourceName}::${dateStr}`);
  return { type: rngPick(rng, AD_TYPES) };
}
