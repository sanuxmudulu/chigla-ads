// POST /.netlify/functions/campaign-creator   { action, ... }   (Vercel: /api/campaign-creator)
//
//   "register"  { campaign_id, advertiser_id, connection_id, bc_id?, campaign_name?,
//                 initial_adgroup_id, initial_ad_id?, adgroup_payload, ad_payload?, dupe_target?:20 }
//        -> record a Campaign-Creator campaign so its initial ad group is
//           auto-duplicated once Active. No-op if campaign_id already registered.
//           (Called by the future Campaign Creator tool — nothing else writes here.)
//
//   "process_duplication"  (no body)
//        -> for every registered campaign still WAITING_FOR_ACTIVE / DUPLICATING:
//           if the initial ad group is genuinely Active, create up to
//           DUPES_PER_CYCLE more copies of it (default target 20). Idempotent.
//           Driven by the existing ~60s dashboard refresh.
//
//   "list"  -> registered campaigns + duplication state (monitoring)
//
// No admin password (same posture as the other tiktok-* write actions). All MCP
// calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  json,
} = require("./_shared/tiktok-mcp");
const { duplicateForRow, DUPES_PER_CYCLE } = require("./_shared/campaign-creator.js");

async function withClient(supabase, connection, fn) {
  const { serverUrl, redirectUrl } = resolveConfig();
  const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection });
  const { client } = await connectMcp({ provider, serverUrl });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    if (body.action === "register") return register(supabase, body);
    if (body.action === "process_duplication") return processDuplication(supabase);
    if (body.action === "list") return listRows(supabase);

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------

async function register(supabase, body) {
  const campaignId = String(body.campaign_id || "");
  const advertiserId = String(body.advertiser_id || "");
  const connectionId = body.connection_id;
  const initialAdgroupId = String(body.initial_adgroup_id || "");
  if (!campaignId || !advertiserId || !connectionId || !initialAdgroupId) {
    return json(400, { error: "campaign_id, advertiser_id, connection_id and initial_adgroup_id are required" });
  }
  if (!body.adgroup_payload || typeof body.adgroup_payload !== "object") {
    return json(400, { error: "adgroup_payload (the exact adgroup_create args) is required" });
  }

  // Never register a WH Warmup campaign for duplication.
  try {
    const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id").eq("campaign_id", campaignId).maybeSingle();
    if (wh) return json(400, { error: "That campaign is a WH Warmup campaign and cannot be duplicated." });
  } catch (_) {
    /* table missing — fine */
  }

  const { data: existing } = await supabase
    .from("campaign_creator_campaigns")
    .select("campaign_id")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (existing) return json(200, { ok: true, already: true });

  const { error } = await supabase.from("campaign_creator_campaigns").insert({
    campaign_id: campaignId,
    advertiser_id: advertiserId,
    connection_id: connectionId,
    bc_id: body.bc_id || null,
    campaign_name: body.campaign_name || null,
    initial_adgroup_id: initialAdgroupId,
    initial_ad_id: body.initial_ad_id ? String(body.initial_ad_id) : null,
    adgroup_payload: body.adgroup_payload,
    ad_payload: body.ad_payload || null,
    dupe_target: Number.isFinite(Number(body.dupe_target)) && Number(body.dupe_target) > 0 ? Number(body.dupe_target) : 20,
    dupe_status: "WAITING_FOR_ACTIVE",
    updated_at: new Date().toISOString(),
  });
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(500, { error: "campaign_creator_campaigns isn't migrated yet. Run supabase/campaign_creator.sql." });
    }
    return json(500, { error: "Could not register the campaign", details: sbErr(error) });
  }
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------

async function processDuplication(supabase) {
  const { data: rows, error } = await supabase
    .from("campaign_creator_campaigns")
    .select("*")
    .in("dupe_status", ["WAITING_FOR_ACTIVE", "DUPLICATING"]);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0, unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  if (!rows || !rows.length) return json(200, { ok: true, checked: 0, created: 0, completed: 0, failed: 0 });

  const byConnection = {};
  for (const r of rows) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);

  const tally = { checked: 0, created: 0, completed: 0, failed: 0, pending: 0 };
  const deadlineMs = Date.now() + 45000; // this endpoint gets maxDuration 60 on Vercel

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadlineMs) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      for (const r of list) {
        await patchRow(supabase, r.campaign_id, { dupe_status: "FAILED", dupe_error: "Connection removed.", updated_at: new Date().toISOString() });
        tally.failed += 1;
      }
      continue;
    }

    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advStatus = new Map((advRows || []).map((a) => [String(a.advertiser_id), a.status]));

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadlineMs) break;
          tally.checked += 1;
          const before = Number(r.dupe_created) || 0;
          r.__persist = (patch) => patchRow(supabase, r.campaign_id, patch);
          let out;
          try {
            out = await duplicateForRow({
              client,
              row: r,
              advertiserStatus: advStatus.get(String(r.advertiser_id)),
              deadlineMs,
            });
          } catch (err) {
            console.error(`[campaign-creator] ${r.campaign_id} failed: ${err.message}`);
            continue;
          }
          await patchRow(supabase, r.campaign_id, out.patch);
          tally.created += Math.max(0, (Number(out.patch.dupe_created) || before) - before);
          if (out.status === "COMPLETE") tally.completed += 1;
          else if (out.status === "FAILED") tally.failed += 1;
          else tally.pending += 1;
        }
      });
    } catch (err) {
      console.error(`[campaign-creator] connection ${connectionId} failed: ${err.message}`);
    }
  }

  return json(200, { ok: true, ...tally, dupes_per_cycle: DUPES_PER_CYCLE });
}

async function patchRow(supabase, campaignId, patch) {
  try {
    await supabase.from("campaign_creator_campaigns").update(patch).eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[campaign-creator] patch ${campaignId} failed: ${err.message}`);
  }
}

async function listRows(supabase) {
  const { data, error } = await supabase
    .from("campaign_creator_campaigns")
    .select(
      "campaign_id, advertiser_id, campaign_name, initial_adgroup_id, dupe_target, dupe_created, dupe_status, dupe_attempts, dupe_error, became_active_at, completed_at, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, campaigns: [], unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  return json(200, { ok: true, campaigns: data || [] });
}
