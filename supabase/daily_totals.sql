-- Run this once in the Supabase SQL editor for this project.
-- Backs the profit calendar heatmap (see netlify/functions/daily-totals.js).

create table if not exists daily_totals (
  date date primary key,
  total_spend numeric not null default 0,
  total_earnings numeric not null default 0,
  updated_at timestamptz not null default now()
);
