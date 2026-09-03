-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Backs ONLY the Live Performance graph's TikTok "Spend" series. TikTok gives us
-- cumulative spend-so-far-today, not hourly spend, so we snapshot the running
-- total once per America/New_York hour and derive each hour's spend as the
-- difference between consecutive snapshots.
--
-- One row per (NY date, NY hour). The row for the CURRENT hour is overwritten on
-- every ~60s metrics refresh; once the hour passes, its last written value is the
-- frozen end-of-hour cumulative. Rows older than ~14 days are swept automatically
-- by the metrics function. Nothing here touches Detailed Metrics or daily_totals.

create table if not exists tiktok_spend_snapshots (
  date             date    not null,
  hour             integer not null check (hour >= 0 and hour <= 23),
  cumulative_spend numeric not null default 0,   -- total today's TikTok spend across tracked campaigns, as of the last write in this hour
  updated_at       timestamptz not null default now(),
  primary key (date, hour)
);
