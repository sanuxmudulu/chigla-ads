// POST /.netlify/functions/wh-warmup   { action, ... }
//
//   "create"  { connection_id, advertiser_ids: [...], target_country, spark_code }
//        -> for EACH advertiser independently: create a Traffic-CBO warmup
//           campaign + ad group + Spark ad. One account failing never stops the
//           batch. Returns per-account results.
//
//   "cleanup"  (no body)
//        -> poll every WH campaign still in WAITING_FOR_ACTIVE / DELETE_PENDING;
//           delete from TikTok the moment it is genuinely Active. Idempotent.
//
//   "list"     (no body)   -> WH campaigns + their cleanup status (monitoring UI)
//
//   "countries" { connection_id, advertiser_id }
//        -> valid country-level TikTok target locations for that advertiser
//           ({ countries: [{ location_id, name, code }] }); drives the autocomplete
//
// No admin password (same posture as the other tiktok-* write actions — every
// write is scoped server-side to advertiser accounts under the given connection).
// All MCP calls run here; no tokens are ever returned to the browser.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  json,
} = require("./_shared/tiktok-mcp");
const { createWarmupForAdvertiser, cleanupOneWarmup, listCountryRegions } = require("./_shared/wh-warmup");

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

const advApproved = (a) => String(a?.status || "").toUpperCase() === "STATUS_ENABLE";

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

    if (body.action === "create") return createBatch(supabase, body);
    if (body.action === "cleanup") return cleanupBatch(supabase);
    if (body.action === "list") return listWarmups(supabase);
    if (body.action === "countries") return countriesFor(supabase, body);

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

// Valid country-level TikTok target locations for one advertiser (drives the
// WH settings-screen autocomplete). { countries: [{ location_id, name, code }] }
async function countriesFor(supabase, body) {
  const connectionId = body.connection_id;
  const advertiserId = String(body.advertiser_id || "");
  if (!connectionId || !advertiserId) return json(400, { error: "connection_id and advertiser_id are required" });

  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return json(404, { error: "Connection not found." });

  try {
    const countries = await withClient(supabase, conn, (client) => listCountryRegions(client, advertiserId));
    return json(200, { ok: true, countries });
  } catch (err) {
    return json(502, { error: "Couldn't load TikTok countries", details: err.message });
  }
}

async function createBatch(supabase, body) {
  const connectionId = body.connection_id;
  const advertiserIds = [...new Set((body.advertiser_ids || []).map(String).filter(Boolean))];
  const targetCountry = String(body.target_country || "").trim();
  const locationId = String(body.location_id || "").trim() || null;
  const rawSpark = String(body.spark_code || "");
  const sparkCode = rawSpark.trim(); // ONLY strip surrounding whitespace/newlines — # + = are kept

  if (!connectionId) return json(400, { error: "connection_id is required" });
  if (!advertiserIds.length) return json(400, { error: "Select at least one advertiser account." });
  if (!targetCountry) return json(400, { error: "Enter a target country." });
  if (!sparkCode) return json(400, { error: "Enter a Spark code." });

  // Safe fingerprint (never the code) so the exact characters can be verified in
  // the function logs across the input path.
  console.log(
    `[wh-warmup] spark in: rawLen=${rawSpark.length} trimmedLen=${sparkCode.length} ` +
      `hash=${sparkCode.startsWith("#")} plus=${sparkCode.includes("+")} pct2b=${/%2[bB]/.test(sparkCode)} ` +
      `eq=${sparkCode.endsWith("=")} space=${sparkCode.includes(" ")}`
  );

  const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!conn) return json(404, { error: "Connection not found." });

  const { data: advRows } = await supabase
    .from("tiktok_advertisers")
    .select("advertiser_id, advertiser_name, status, currency, timezone, display_timezone, bc_id")
    .eq("connection_id", connectionId)
    .in("advertiser_id", advertiserIds);
  const advById = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));

  const results = [];
  let storeWarning = null;

  await withClient(supabase, conn, async (client) => {
    for (const advId of advertiserIds) {
      const adv = advById.get(advId);
      const name = adv?.advertiser_name || advId;
      if (!adv) {
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Failed", error: "Account not under this connection." });
        continue;
      }
      if (!advApproved(adv)) {
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Skipped", error: "Account is Suspended." });
        continue;
      }
      try {
        const r = await createWarmupForAdvertiser({
          client,
          advertiserId: advId,
          currency: adv.currency,
          targetCountry,
          locationId,
          sparkCode,
        });
        // Record IMMEDIATELY so a mid-batch failure never leaves an untracked
        // (undeletable-by-us) campaign live on TikTok.
        const { error: insErr } = await supabase.from("wh_warmup_campaigns").upsert(
          {
            campaign_id: r.campaign_id,
            advertiser_id: advId,
            advertiser_name: adv.advertiser_name || null,
            connection_id: connectionId,
            bc_id: adv.bc_id || conn.bc_id || null,
            campaign_name: r.campaign_name,
            adgroup_id: r.adgroup_id,
            ad_id: r.ad_id,
            destination_url: r.destination_url,
            target_country: r.target_country,
            location_id: r.location_id,
            spark_item_id: r.spark_item_id,
            daily_budget: r.daily_budget,
            currency: r.currency,
            cleanup_status: "WAITING_FOR_ACTIVE",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "campaign_id" }
        );
        if (insErr && !storeWarning) {
          storeWarning = `Some campaigns were created but could not be stored for auto-cleanup (${insErr.message}). Run supabase/wh_warmup.sql.`;
          console.error(`[wh-warmup] store failed campaign=${r.campaign_id}: ${insErr.message}`);
        }
        results.push({
          advertiser_id: advId,
          advertiser_name: name,
          status: "Created",
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
        });
      } catch (err) {
        console.error(`[wh-warmup] create failed adv=${advId}: ${err.message}`);
        results.push({ advertiser_id: advId, advertiser_name: name, status: "Failed", error: err.message });
      }
    }
  }).catch((err) => {
    for (const advId of advertiserIds) {
      if (!results.some((x) => x.advertiser_id === advId)) {
        results.push({
          advertiser_id: advId,
          advertiser_name: advById.get(advId)?.advertiser_name || advId,
          status: "Failed",
          error: err.message,
        });
      }
    }
  });

  return json(200, { ok: true, results, ...(storeWarning ? { warning: storeWarning } : {}) });
}

// ---------------------------------------------------------------------------
// cleanup — the "Active -> delete" state machine, driven by the 60s refresh
// ---------------------------------------------------------------------------

async function cleanupBatch(supabase) {
  const { data: rows, error } = await supabase
    .from("wh_warmup_campaigns")
    .select("*")
    .in("cleanup_status", ["WAITING_FOR_ACTIVE", "DELETE_PENDING"]);
  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message || "")) {
      return json(200, { ok: true, checked: 0, deleted: 0, failed: 0, pending: 0, unmigrated: true });
    }
    return json(500, { error: "Supabase read failed", details: sbErr(error) });
  }
  if (!rows || !rows.length) return json(200, { ok: true, checked: 0, deleted: 0, failed: 0, pending: 0 });

  const byConnection = {};
  for (const r of rows) (byConnection[r.connection_id] = byConnection[r.connection_id] || []).push(r);

  const tally = { checked: 0, deleted: 0, failed: 0, pending: 0 };
  const deadline = Date.now() + 9000;

  for (const [connectionId, list] of Object.entries(byConnection)) {
    if (Date.now() > deadline) break;
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      // connection gone -> abandon its WH rows
      for (const r of list) {
        await patchRow(supabase, r.campaign_id, { cleanup_status: "FAILED", cleanup_error: "Connection removed.", updated_at: new Date().toISOString() });
        tally.failed += 1;
      }
      continue;
    }

    // advertiser status/timezone for status derivation
    const advIds = [...new Set(list.map((r) => String(r.advertiser_id)))];
    const { data: advRows } = await supabase
      .from("tiktok_advertisers")
      .select("advertiser_id, status, timezone, display_timezone")
      .eq("connection_id", connectionId)
      .in("advertiser_id", advIds);
    const advById = new Map((advRows || []).map((a) => [String(a.advertiser_id), a]));

    try {
      await withClient(supabase, conn, async (client) => {
        for (const r of list) {
          if (Date.now() > deadline) break;
          tally.checked += 1;
          const adv = advById.get(String(r.advertiser_id)) || {};
          const out = await cleanupOneWarmup({
            client,
            row: r,
            advertiserStatus: adv.status,
            timezone: adv.timezone || adv.display_timezone || null,
          });
          await patchRow(supabase, r.campaign_id, out.patch);
          if (out.status === "DELETED") {
            tally.deleted += 1;
            // The WH campaign is gone from TikTok — pull its Detailed Metrics row
            // now instead of waiting for the next discovery sync to prune it.
            try {
              await supabase.from("tiktok_campaigns").delete().eq("campaign_id", String(r.campaign_id));
            } catch (e) {
              console.error(`[wh-warmup] tiktok_campaigns cleanup ${r.campaign_id} failed: ${e.message}`);
            }
          } else if (out.status === "FAILED") tally.failed += 1;
          else tally.pending += 1;
        }
      });
    } catch (err) {
      console.error(`[wh-warmup] cleanup connection ${connectionId} failed: ${err.message}`);
      // leave rows as-is; next cycle retries
    }
  }

  return json(200, { ok: true, ...tally });
}

async function patchRow(supabase, campaignId, patch) {
  try {
    await supabase.from("wh_warmup_campaigns").update(patch).eq("campaign_id", String(campaignId));
  } catch (err) {
    console.error(`[wh-warmup] patch ${campaignId} failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listWarmups(supabase) {
  const { data, error } = await supabase
    .from("wh_warmup_campaigns")
    .select(
      "campaign_id, advertiser_id, advertiser_name, campaign_name, target_country, daily_budget, currency, cleanup_status, cleanup_attempts, cleanup_error, became_active_at, deleted_at, created_at"
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
