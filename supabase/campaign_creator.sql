-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- FOUNDATION for Campaign Creation Automation (the "Campaign Creator" tool,
-- not built yet). Rows here are created ONLY by that tool via the
-- campaign-creator.js "register" action after it builds a
-- 1 CBO campaign -> 1 initial ad group -> 1 Spark ad.
--
-- The auto-duplicate processor (also in campaign-creator.js) watches these rows
-- and, once the initial ad group is genuinely Active, creates `dupe_target`
-- additional copies of it (default 20 -> 21 ad groups total). It NEVER acts on
-- any campaign that isn't in this table, so existing / manually-created
-- campaigns and WH Warmup campaigns are never touched.
--
-- No existing data is modified.

create extension if not exists pgcrypto;

create table if not exists campaign_creator_campaigns (
  campaign_id         text primary key,
  advertiser_id       text not null,
  connection_id       uuid not null references tiktok_connections(id) on delete cascade,
  bc_id               text,
  campaign_name       text,

  initial_adgroup_id  text not null,
  initial_ad_id       text,
  -- The EXACT args used to create the initial ad group / ad, so duplicates are
  -- an exact replay (name + schedule + request_id are regenerated per copy).
  adgroup_payload     jsonb not null,
  ad_payload          jsonb,

  dupe_target         integer not null default 20,
  dupe_created        integer not null default 0,
  -- WAITING_FOR_ACTIVE : initial ad group not yet genuinely Active
  -- DUPLICATING        : Active reached; creating the copies (resumable)
  -- COMPLETE           : dupe_created == dupe_target — terminal
  -- FAILED             : retry cap hit / advertiser suspended / 3-day timeout — terminal
  dupe_status         text not null default 'WAITING_FOR_ACTIVE',
  dupe_attempts       integer not null default 0,
  dupe_error          text,

  became_active_at    timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists campaign_creator_dupe_idx on campaign_creator_campaigns (dupe_status)
  where dupe_status in ('WAITING_FOR_ACTIVE', 'DUPLICATING');
