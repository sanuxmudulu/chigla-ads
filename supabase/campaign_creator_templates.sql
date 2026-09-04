-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Reusable Campaign Creator templates. A template holds ONLY settings that are
-- the same across every launch (campaign type, CBO, budget, targeting, CTA, ad
-- text, interactive-card image). Per-launch values — campaign base name, Spark
-- codes, post links, schedule, identity, Instant Form — are supplied at run time
-- and are NEVER stored here.
--
-- Same shape/pattern as comment_templates.sql: a single jsonb `config` blob so
-- the schema never needs to change when a template field is added. NEVER touched
-- by the daily retention job (netlify/functions/cleanup.js). Deleting a template
-- does NOT affect campaigns already created from it (those live in
-- campaign_creator_campaigns and are fully self-contained).

create extension if not exists pgcrypto;

create table if not exists campaign_creator_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- 'LEAD_GENERATION' | 'SALES'
  campaign_type text not null,
  -- {
  --   cbo: true,
  --   daily_budget: 50,
  --   location_ids: ["6252001"], location_labels: ["United States"],
  --   age_groups: ["AGE_18_24","AGE_25_34","AGE_35_44","AGE_45_54","AGE_55_100"],
  --   gender: "GENDER_UNLIMITED",
  --   cta: "LEARN_MORE",
  --   ad_text: "…",
  --   interactive_card: { enabled: false, image_url: "", note: "" }
  -- }
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists campaign_creator_templates_name_idx
  on campaign_creator_templates (lower(name));
create index if not exists campaign_creator_templates_type_idx
  on campaign_creator_templates (campaign_type);
