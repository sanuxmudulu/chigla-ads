-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Adds attempt tracking + a one-row-per-(campaign, kind) guarantee for the
-- AUTO engagement kinds (LIKES / SAVES). COMMENTS is intentionally left
-- unconstrained — the operator can queue several comment batches per campaign.
--
-- The backend degrades gracefully without this migration (it falls back to
-- inserting a fresh row and can't cap retries as tightly), so it is
-- RECOMMENDED, not required.

alter table engagement_orders add column if not exists attempts integer not null default 0;

-- At most one LIKES row and one SAVES row per campaign — the auto processor
-- updates that row in place instead of stacking duplicates on every retry.
create unique index if not exists engagement_orders_campaign_kind_ux
  on engagement_orders (campaign_id, kind)
  where kind in ('LIKES', 'SAVES');
