-- Run this once in the Supabase SQL editor for this project.
-- Adds campaign discovery for the TikTok integration. Depends on the tables in
-- tiktok_connections.sql. Independent of the Glitchy tables.
--
-- See netlify/functions/tiktok-campaigns.js.

create table if not exists tiktok_campaigns (
  campaign_id                text primary key,
  connection_id              uuid not null references tiktok_connections(id) on delete cascade,
  advertiser_id              text not null,
  advertiser_name            text,
  campaign_name              text not null,          -- == Glitchy "source" join key
  objective_type             text,
  budget                     numeric,
  budget_mode                text,
  campaign_operation_status  text,                   -- raw, e.g. ENABLE / DISABLE
  campaign_secondary_status  text,                   -- raw, e.g. CAMPAIGN_STATUS_DISABLE
  effective_status           text,                   -- derived display label, e.g. "Active" / "Rejected"
  effective_tone             text,                   -- good | warn | bad | neutral
  status_detail              text,                   -- e.g. rejection reason
  ad_count                   integer not null default 0,
  active_ad_count            integer not null default 0,
  create_time                timestamptz,
  discovered_at              timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists tiktok_campaigns_advertiser_idx on tiktok_campaigns (advertiser_id);
create index if not exists tiktok_campaigns_name_idx on tiktok_campaigns (campaign_name);
