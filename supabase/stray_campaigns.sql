-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Backs "stray campaign" discovery: a plain MARKER for a real, currently-
-- existing TikTok campaign that a full sync found sitting in an Approved ad
-- account but that isn't a Campaign Creator campaign (campaign_creator_
-- campaigns) or a WH Warmup campaign (wh_warmup_campaigns) — i.e. nothing in
-- this dashboard was watching it. Surfaced in the "WHs Warming Up" panel so
-- it's never silently burning money unnoticed; excluded from Detailed
-- Metrics instead (see is_stray in tiktok-campaigns.js's readCampaigns).
--
-- Deliberately has NO cleanup/lifecycle automation attached, unlike
-- wh_warmup_campaigns (which auto-deletes its rows once Active) — a stray
-- campaign is a real ad that might be worth keeping; it is only ever
-- paused/deleted by an explicit user action, never automatically.
create table if not exists stray_campaigns (
  campaign_id    text primary key,
  connection_id  uuid not null references tiktok_connections(id) on delete cascade,
  advertiser_id  text not null,
  campaign_name  text,
  discovered_at  timestamptz not null default now()
);

create index if not exists stray_campaigns_advertiser_idx on stray_campaigns (advertiser_id);
