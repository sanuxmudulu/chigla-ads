-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- FOUNDATION ONLY for engagement automation. Nothing here contacts any
-- third-party artificial-engagement / SMM service.
--
-- tiktok_post_url is the AUTHORITATIVE per-campaign mapping (campaign_id ->
-- post link). It is written directly onto the campaign row by Campaign Creation
-- Automation (not built yet) from its ordered Spark-code / post-link pairs —
-- never derived later by campaign name or ordering. Until then it stays null.
-- There is NO manual "attach URL" UI.
--
-- No existing campaign data is modified.

create extension if not exists pgcrypto;

-- Per-campaign engagement target + idempotent lifecycle flag.
--   engagement_status:  PENDING  (default — nothing to do)
--                       READY    (campaign is genuinely Active AND has a post URL)
--                       COMPLETED (an approved provider processed it — future)
--                       FAILED   (an approved provider rejected it — future)
--   engagement_added_at: when tiktok_post_url was set (by campaign creation).
alter table tiktok_campaigns add column if not exists tiktok_post_url     text;
alter table tiktok_campaigns add column if not exists engagement_status   text not null default 'PENDING';
alter table tiktok_campaigns add column if not exists engagement_added_at timestamptz;

-- One row per queued engagement batch (e.g. a set of comments). Created locally
-- with status READY and NEVER auto-submitted anywhere. A future server-side
-- provider adapter (netlify/functions/_shared/engagement-provider.js) would pick
-- these up and move them to SUBMITTED / COMPLETED / FAILED.
create table if not exists engagement_orders (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  text not null references tiktok_campaigns(campaign_id) on delete cascade,
  kind         text not null default 'COMMENTS',        -- COMMENTS | LIKES | VIEWS | ...
  provider     text,                                    -- null until an approved provider is configured
  service_id   text,                                    -- provider's service identifier (free-form for now)
  link         text not null,                           -- the TikTok post URL
  quantity     integer not null default 0,
  comments     jsonb,                                   -- array of strings, one per line (for COMMENTS)
  status       text not null default 'READY',           -- READY | SUBMITTED | COMPLETED | FAILED
  provider_ref text,                                    -- provider's order id, once submitted (future)
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists engagement_orders_campaign_idx on engagement_orders (campaign_id);
create index if not exists engagement_orders_status_idx   on engagement_orders (status);
