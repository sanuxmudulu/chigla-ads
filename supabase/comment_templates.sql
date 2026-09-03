-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Global, reusable comment templates for the "Add comments" modal. NOT tied to
-- any campaign, connection, or Business Center. Purely a convenience library.
--
-- IMPORTANT: this table is NEVER touched by the daily retention job
-- (netlify/functions/cleanup.js) or by any engagement-order cleanup. Templates
-- persist until you delete them from the UI.

create extension if not exists pgcrypto;

create table if not exists comment_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  comments   jsonb not null default '[]'::jsonb,   -- array of strings, one comment per line
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comment_templates_name_idx on comment_templates (lower(name));
