-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Stores TODAY'S live TikTok campaign performance on each campaign row so:
--   * the frontend can show real Spend / CPM / CPA (see js/app.js rebuildSources)
--   * daily_totals.total_spend can be derived server-side WITHOUT the Glitchy
--     poll ever needing an MCP client (see _shared/glitchy-daily.js)
--
-- `today_date` is the America/New_York calendar date the numbers belong to (the
-- dashboard's reporting boundary — same clock as Glitchy / Mabac / daily_totals).
-- When today_date != the current NY date the values are simply ignored as stale
-- and treated as 0 until the next metrics refresh overwrites them.
--
-- Written only by the tiktok-campaigns.js "metrics" action. A campaign re-sync
-- (discoverAndStoreCampaigns) never touches these columns, so onConflict
-- preserves them. No historical daily_totals rows are affected.

alter table tiktok_campaigns add column if not exists today_date         date;
alter table tiktok_campaigns add column if not exists today_spend        numeric     not null default 0;
alter table tiktok_campaigns add column if not exists today_impressions  bigint      not null default 0;
alter table tiktok_campaigns add column if not exists today_clicks       bigint      not null default 0;
alter table tiktok_campaigns add column if not exists today_conversions  numeric     not null default 0;
alter table tiktok_campaigns add column if not exists today_cpm          numeric     not null default 0;
alter table tiktok_campaigns add column if not exists today_cpa          numeric     not null default 0;
alter table tiktok_campaigns add column if not exists metrics_updated_at timestamptz;
