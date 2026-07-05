-- Run this once in the Supabase SQL editor for this project.
-- Backs the profit calendar heatmap (see netlify/functions/daily-totals.js).

create table if not exists daily_totals (
  date date primary key,
  total_spend numeric not null default 0,
  total_earnings numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- Added for the Profit Calendar's detailed-view modal (per-day click/conversion
-- counts). Only backfilled going forward from today's upsert — days recorded
-- before this migration will read as 0 rather than having real history.
alter table daily_totals add column if not exists total_clicks integer not null default 0;
alter table daily_totals add column if not exists total_conversions integer not null default 0;
