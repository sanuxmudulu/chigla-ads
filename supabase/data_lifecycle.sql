-- OPTIONAL. Run this only if you want the daily retention job
-- (netlify/functions/cleanup.js) to stay fast once wh_warmup_campaigns /
-- engagement_orders grow to thousands of rows. At the current scale it is not
-- needed and the job works fine without it. Idempotent.
--
-- NOTHING here changes data, adds columns, or creates tables — indexes only.

-- terminal WH rows, by age (the daily purge filters exactly on this)
create index if not exists wh_warmup_terminal_age_idx
  on wh_warmup_campaigns (updated_at)
  where cleanup_status in ('DELETED', 'FAILED');

-- finished engagement operations, by age
create index if not exists engagement_orders_done_age_idx
  on engagement_orders (updated_at)
  where status in ('COMPLETED', 'FAILED');

-- campaign day-metrics staleness check
create index if not exists tiktok_campaigns_today_date_idx
  on tiktok_campaigns (today_date);
