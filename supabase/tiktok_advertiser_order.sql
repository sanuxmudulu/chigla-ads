-- Run this once in the Supabase SQL editor for this project.
-- Adds a stable ordering column to tiktok_advertisers so the dashboard can
-- show ad accounts in the same order TikTok's own auth_advertiser_get list
-- returns them (i.e. the order they appear in the Business Center), instead
-- of alphabetically by name. Approved/Suspended grouping is still applied on
-- top of this by the frontend; list_order only controls order WITHIN each
-- group. Backfilled to null for existing rows — they fall back to the old
-- alphabetical order until the next "Refresh Data" re-discovers them.
alter table tiktok_advertisers add column if not exists list_order integer;
