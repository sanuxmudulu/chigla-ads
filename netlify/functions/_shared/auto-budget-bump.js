// Auto budget-bump: raises a CBO campaign's TikTok budget by $50 for every
// $10 it spends today (NY date). Runs INSIDE the existing "metrics" action's
// per-advertiser loop in tiktok-campaigns.js — the same ~60s client poll that
// already fetches fresh spend for the Detailed Metrics table — so it reuses
// that connected MCP client instead of opening a separate one. This means it
// only ever runs while the dashboard is open and polling; see the doc
// comment on applyAutoBudgetBumps for what that means in practice.
//
// Bump math is always recomputed from CURRENT total spend, never accumulated
// blindly: bumpsEarned = floor(spend / 10). If a poll is missed and spend
// jumps two thresholds at once, the next check still lands on the correct
// budget in one step, not one $50 behind.

const { mcpCall } = require("./tiktok-mcp");

const BUMP_THRESHOLD = 10; // dollars of spend per step
const BUMP_AMOUNT = 50; // dollars added to budget per step

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// `spendByCampaignId`: { campaign_id: spend } for this advertiser, from the
// SAME report the metrics action just fetched — no extra report call.
// `knownById`: Map campaign_id -> tiktok_campaigns row (must include
// auto_budget_baseline, auto_budget_bumps — the caller's existing "known"
// query just needs those two columns added to its select).
// `whIds`: Set of WH Warmup campaign_ids — always excluded (throwaway
// campaigns that auto-delete once Active; never worth scaling).
//
// Returns rows to fold into the caller's existing tiktok_campaigns upsert:
// [{ campaign_id, budget, auto_budget_baseline, auto_budget_bumps }].
// Best-effort throughout — a single campaign_get/campaign_update failure
// just leaves that campaign's state untouched for a retry next tick; it
// never throws out of here (a bad campaign shouldn't block the others, or
// the metrics response itself).
async function applyAutoBudgetBumps({ client, advertiserId, spendByCampaignId, knownById, whIds }) {
  const out = [];

  const candidateIds = Object.keys(spendByCampaignId).filter((cid) => {
    if (whIds.has(cid)) return false;
    if (!knownById.has(cid)) return false;
    return (Number(spendByCampaignId[cid]) || 0) >= BUMP_THRESHOLD;
  });
  if (!candidateIds.length) return out;

  let campaigns;
  try {
    const res = await mcpCall(client, "campaign_get", {
      advertiser_id: advertiserId,
      fields: ["campaign_id", "budget", "budget_mode", "budget_optimize_on"],
      filtering: { campaign_ids: candidateIds },
      page_size: 1000,
    });
    campaigns = res?.list || [];
  } catch (err) {
    console.error(`[auto-budget] campaign_get failed adv=${advertiserId}: ${err.message}`);
    return out;
  }

  for (const camp of campaigns) {
    const cid = String(camp.campaign_id);
    if (!camp.budget_optimize_on) continue; // not CBO — the ad group owns the budget instead, not this campaign
    const mode = String(camp.budget_mode || "").toUpperCase();
    if (!mode || mode === "BUDGET_MODE_INFINITE") continue; // no cap to raise

    const spend = Number(spendByCampaignId[cid]) || 0;
    const bumpsEarned = Math.floor(spend / BUMP_THRESHOLD);
    if (bumpsEarned <= 0) continue;

    const state = knownById.get(cid) || {};
    const appliedBumps = Number(state.auto_budget_bumps) || 0;
    if (bumpsEarned <= appliedBumps) continue; // already caught up this cycle

    // Baseline is captured ONCE, from TikTok's own current budget the first
    // time this campaign qualifies — never assumed/hardcoded — so bumping
    // works the same regardless of what the campaign's starting budget was.
    const baseline = state.auto_budget_baseline != null ? Number(state.auto_budget_baseline) : Number(camp.budget) || 0;
    let newBudget = baseline + bumpsEarned * BUMP_AMOUNT;

    // TikTok's own constraint: a campaign's budget must be >= 105% of its
    // current spend. Our bump size makes this a non-issue in the normal
    // case, but this keeps a call from failing outright if spend ever
    // surges unusually fast between polls.
    const minAllowed = round2(spend * 1.05);
    if (newBudget < minAllowed) newBudget = minAllowed;
    newBudget = round2(newBudget);

    try {
      await mcpCall(client, "campaign_update", {
        advertiser_id: advertiserId,
        campaign_id: cid,
        budget: newBudget,
      });
      out.push({ campaign_id: cid, budget: newBudget, auto_budget_baseline: baseline, auto_budget_bumps: bumpsEarned });
    } catch (err) {
      console.error(`[auto-budget] campaign_update failed campaign=${cid}: ${err.message}`);
      // Left untouched — retried next tick with the same (still correct) math.
    }
  }

  return out;
}

module.exports = { applyAutoBudgetBumps, BUMP_THRESHOLD, BUMP_AMOUNT };
