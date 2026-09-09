-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Backs the auto budget-bump feature: a CBO campaign's TikTok daily/lifetime
-- budget is automatically raised by $50 for every $10 it spends (today's NY-
-- date spend — see netlify/functions/_shared/auto-budget-bump.js).
--
-- auto_budget_baseline — the campaign's budget at the moment bumping first
--   applied to it (captured once, from TikTok's own campaign_get, not
--   assumed). Every later bump is baseline + (bumps * 50), recomputed fresh
--   each time from today's actual spend — never accumulated blindly — so a
--   skipped poll that lets spend jump past more than one $10 step still ends
--   up at the correct budget, not under-bumped.
-- auto_budget_bumps — how many $10 thresholds have been applied so far today.
--   Resets to 0 automatically at the NY-day rollover along with today_spend
--   (same existing reset in tiktok-campaigns.js's "metrics" action / the
--   daily cleanup.js cron), so a campaign still running the next day starts
--   its bump counting over from that day's spend.
alter table tiktok_campaigns add column if not exists auto_budget_baseline numeric;
alter table tiktok_campaigns add column if not exists auto_budget_bumps    integer not null default 0;
