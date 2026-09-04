-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- AUTOMATIC AD-REJECTION APPEALS for Campaign Creator campaigns.
--
-- Adds appeal-lifecycle state to campaign_creator_campaigns (created in
-- supabase/campaign_creator.sql). Auto appeal is scoped to these rows ONLY:
-- they are registered by the Campaign Creator tool at creation time, carry the
-- exact initial_adgroup_id / initial_ad_id, are monitored every ~60s through
-- their first review by campaign-creator.js "process_duplication", and are
-- bounded by that processor's 3-day give-up — so a stale rejected campaign can
-- never be surprise-appealed on a restart. WH Warmup campaigns are a separate
-- table and are already refused by the "register" action, so they are never
-- eligible.
--
-- Idempotency: `appeal_attempted` is a hard one-way latch. It is set true ONLY
-- after adgroup_appeal returns success and is NEVER cleared. Once true, no
-- second automatic appeal is ever submitted for this campaign — not on a
-- dashboard refresh, not on a server restart, not after TikTok rejects the
-- appeal. A purely technical MCP/HTTP failure does NOT set it (state stays
-- 'REJECTED' and is retried up to a small cap), so a transient outage can never
-- permanently mark a campaign 'APPEAL_REJECTED'.
--
-- No existing data is modified.

alter table campaign_creator_campaigns
  -- NONE               : no rejection seen (default)
  -- REJECTED           : initial ad group currently rejected; appeal pending / not yet possible
  -- UNSUPPORTED        : rejected for a reason we have no template for — left rejected, never auto-appealed
  -- APPEAL_SUBMITTING  : claim taken, adgroup_appeal call in flight (transient)
  -- APPEAL_UNDER_REVIEW: one appeal submitted successfully; awaiting TikTok's decision
  -- APPEAL_APPROVED    : appeal approved / initial ad group is Active again — duplication may proceed
  -- APPEAL_REJECTED    : TikTok rejected the appeal — terminal, never auto-appealed again
  add column if not exists appeal_state        text not null default 'NONE',
  add column if not exists appeal_attempted    boolean not null default false,  -- hard idempotency latch
  add column if not exists appeal_attempts     integer not null default 0,      -- technical-failure retries only
  add column if not exists appeal_raw_reasons  jsonb,                           -- raw TikTok reject strings (deduped)
  add column if not exists appeal_reasons      jsonb,                           -- normalized canonical category ids
  add column if not exists appeal_text         text,                            -- generated appeal text (debugging)
  add column if not exists appeal_ad_id        text,                            -- ad the rejection reason came from
  add column if not exists appeal_adgroup_id   text,                            -- ad group the appeal targets
  add column if not exists appeal_submitted_at timestamptz,
  add column if not exists appeal_error        text,                            -- last technical failure (NOT a TikTok rejection)
  add column if not exists appeal_updated_at   timestamptz;

-- Fast lookup of campaigns with a live appeal (read-time status overlay in
-- tiktok-campaigns.js readCampaigns).
create index if not exists campaign_creator_appeal_state_idx
  on campaign_creator_campaigns (appeal_state)
  where appeal_state <> 'NONE';
