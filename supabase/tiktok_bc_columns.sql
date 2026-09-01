-- Run this once in the Supabase SQL editor.
-- Adds Business Center identity to tiktok_connections so the TikTok Ad Accounts
-- modal can label / group multiple connections by their BC. Populated from
-- bc/get during advertiser discovery (auth callback, Re-scan, Refresh TikTok
-- Data). Idempotent — safe to re-run. No existing data is modified.

alter table tiktok_connections add column if not exists bc_id    text;
alter table tiktok_connections add column if not exists bc_name  text;
alter table tiktok_connections add column if not exists bc_count integer not null default 0;
