-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- WH Warmup = temporary Traffic-CBO warmup campaigns created in bulk across
-- Approved advertiser accounts, then AUTO-DELETED from TikTok as soon as each
-- one reaches "Active". They live ONLY in this dedicated table and are NEVER
-- written to tiktok_campaigns, so they cannot touch Detailed Metrics, KPIs,
-- ROAS/CPNC/EPC, the hourly graph, Glitchy/Mabac joins, or daily_totals.
--
-- No existing data is modified.

create extension if not exists pgcrypto;

create table if not exists wh_warmup_campaigns (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      text unique not null,
  advertiser_id    text not null,
  advertiser_name  text,
  connection_id    uuid not null references tiktok_connections(id) on delete cascade,
  bc_id            text,
  campaign_name    text,
  adgroup_id       text,
  ad_id            text,
  destination_url  text,          -- the random https://etsy.com/<slug>/ used for ad group + ad
  target_country   text,          -- what the user typed
  location_id      text,          -- resolved TikTok location id
  spark_item_id    text,          -- resolved Spark post item_id
  daily_budget     numeric,       -- the CBO daily budget actually sent
  currency         text,

  -- cleanup lifecycle (idempotent):
  --   WAITING_FOR_ACTIVE : created, polling status; delete once it is genuinely Active
  --   DELETE_PENDING     : reached Active, a delete is being attempted / retried
  --   DELETED            : deleted from TikTok — terminal, never retried
  --   FAILED             : delete permanently abandoned (account suspended / retry cap) — terminal
  cleanup_status    text not null default 'WAITING_FOR_ACTIVE',
  cleanup_attempts  integer not null default 0,
  cleanup_error     text,
  became_active_at  timestamptz,
  deleted_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists wh_warmup_cleanup_idx on wh_warmup_campaigns (cleanup_status)
  where cleanup_status in ('WAITING_FOR_ACTIVE', 'DELETE_PENDING');
create index if not exists wh_warmup_advertiser_idx on wh_warmup_campaigns (advertiser_id);
