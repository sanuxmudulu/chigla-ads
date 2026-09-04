// GET  /.netlify/functions/campaign-creator-templates          -> { templates: [...] }
// POST /.netlify/functions/campaign-creator-templates  { action, ... }
//        "create"  { name, campaign_type, config }        -> { template }
//        "update"  { id, name, campaign_type, config }    -> { template }
//        "delete"  { id }                                 -> { ok: true }
//
// Reusable Campaign Creator templates (Lead Generation / Sales). Same posture as
// comment-templates.js: global, not tied to a BC/campaign, not password gated,
// no external calls. Deleting a template never affects campaigns already created
// from it. See supabase/campaign_creator_templates.sql.

const { getSupabase, sbErr, json } = require("./_shared/tiktok-mcp");
const { normalizeTemplateConfig, TEMPLATE_TYPES } = require("./_shared/campaign-creator-build");

const COLS = "id, name, campaign_type, config, created_at, updated_at";

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    if (event.httpMethod === "GET") {
      const { data, error } = await supabase
        .from("campaign_creator_templates")
        .select(COLS)
        .order("name", { ascending: true });
      if (error) {
        if (/does not exist|schema cache|could not find/i.test(error.message || "")) {
          return json(200, { templates: [], unmigrated: true });
        }
        return json(500, { error: "Supabase read failed", details: sbErr(error) });
      }
      return json(200, { templates: data || [] });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    if (body.action === "create" || body.action === "update") {
      const name = String(body.name || "").trim();
      const campaignType = String(body.campaign_type || "").toUpperCase();
      if (!name) return json(400, { error: "Template name is required." });
      if (!TEMPLATE_TYPES.includes(campaignType)) {
        return json(400, { error: `campaign_type must be one of ${TEMPLATE_TYPES.join(", ")}` });
      }

      const { config, errors } = normalizeTemplateConfig(body.config || {});
      if (errors.length) return json(400, { error: errors[0], errors });

      if (body.action === "create") {
        const { data, error } = await supabase
          .from("campaign_creator_templates")
          .insert({ name, campaign_type: campaignType, config })
          .select(COLS)
          .maybeSingle();
        if (error) {
          if (/does not exist|schema cache|could not find/i.test(error.message || "")) {
            return json(500, {
              error: "campaign_creator_templates isn't migrated yet. Run supabase/campaign_creator_templates.sql, then retry.",
            });
          }
          return json(500, { error: "Could not save the template", details: sbErr(error) });
        }
        return json(200, { template: data });
      }

      if (!body.id) return json(400, { error: "id is required" });
      const { data, error } = await supabase
        .from("campaign_creator_templates")
        .update({ name, campaign_type: campaignType, config, updated_at: new Date().toISOString() })
        .eq("id", String(body.id))
        .select(COLS)
        .maybeSingle();
      if (error) return json(500, { error: "Could not update the template", details: sbErr(error) });
      if (!data) return json(404, { error: "Template not found." });
      return json(200, { template: data });
    }

    if (body.action === "delete") {
      if (!body.id) return json(400, { error: "id is required" });
      const { error } = await supabase.from("campaign_creator_templates").delete().eq("id", String(body.id));
      if (error) return json(500, { error: "Could not delete the template", details: sbErr(error) });
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
