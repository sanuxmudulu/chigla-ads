-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
-- Supersedes tiktok_bc_columns.sql (includes those columns).
--
-- Adds:
--  * Business Center identity to tiktok_connections (bc_id / bc_name / bc_count)
--  * affiliate-network association (GLITCHY | MABAC) to tiktok_connections
--    and, denormalised for the frontend, to tiktok_campaigns
--  * Business Center id/name denormalised onto tiktok_campaigns so the
--    Detailed Metrics "Business Center" filter needs no join.
--
-- No existing data is modified. `affiliate_network` defaults to GLITCHY so
-- every current connection/campaign keeps its existing behaviour.

alter table tiktok_connections add column if not exists bc_id            text;
alter table tiktok_connections add column if not exists bc_name          text;
alter table tiktok_connections add column if not exists bc_count         integer not null default 0;
alter table tiktok_connections add column if not exists affiliate_network text   not null default 'GLITCHY';

alter table tiktok_campaigns   add column if not exists bc_id            text;
alter table tiktok_campaigns   add column if not exists bc_name          text;
alter table tiktok_campaigns   add column if not exists affiliate_network text   not null default 'GLITCHY';

create index if not exists tiktok_campaigns_bc_idx on tiktok_campaigns (bc_id);
