-- Run this once in the Supabase SQL editor for this project.
-- No column/constraint changes needed — cleanup_status is a plain unconstrained
-- text column, so the new PAUSE_PENDING value (WH Warmup now pauses a campaign
-- BEFORE deleting it, once Active, as a money-safety guarantee) just works.
-- This only refreshes the partial index so PAUSE_PENDING rows stay covered by
-- it, matching the WAITING_FOR_ACTIVE / DELETE_PENDING it already indexed.
--
-- Updated lifecycle:
--   WAITING_FOR_ACTIVE : created, polling status; once genuinely Active, pause it
--   PAUSE_PENDING       : Active, pausing (retried every cycle — never given up on;
--                         a paused campaign can't spend, so this is the safety net)
--   DELETE_PENDING      : paused, a delete is being attempted / retried
--   DELETED             : deleted from TikTok — terminal, never retried
--   FAILED              : delete permanently abandoned (account suspended / retry
--                         cap) — terminal, but the campaign is already PAUSED by
--                         this point, so nothing is still spending

drop index if exists wh_warmup_cleanup_idx;
create index if not exists wh_warmup_cleanup_idx on wh_warmup_campaigns (cleanup_status)
  where cleanup_status in ('WAITING_FOR_ACTIVE', 'PAUSE_PENDING', 'DELETE_PENDING');
