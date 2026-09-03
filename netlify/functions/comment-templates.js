// GET  /.netlify/functions/comment-templates          -> { templates: [...] }
// POST /.netlify/functions/comment-templates  { action, ... }
//        "create"  { name, comments: [...] }   -> { template }
//        "update"  { id, name, comments: [...] } -> { template }
//        "delete"  { id }                        -> { ok: true }
//
// Global reusable comment templates. Not tied to a campaign / BC. Not password
// gated (same posture as the other engagement actions). No external calls.

const { getSupabase, sbErr, json } = require("./_shared/tiktok-mcp");

const COLS = "id, name, comments, created_at, updated_at";

// One clean array of non-empty comment lines from a string OR array.
function parseComments(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean);
}

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    if (event.httpMethod === "GET") {
      const { data, error } = await supabase
        .from("comment_templates")
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
      const comments = parseComments(body.comments);
      if (!name) return json(400, { error: "Template name is required." });
      if (!comments.length) return json(400, { error: "Enter at least one comment (one per line)." });

      if (body.action === "create") {
        const { data, error } = await supabase
          .from("comment_templates")
          .insert({ name, comments })
          .select(COLS)
          .maybeSingle();
        if (error) {
          if (/does not exist|schema cache|could not find/i.test(error.message || "")) {
            return json(500, { error: "The comment_templates table isn't migrated yet. Run supabase/comment_templates.sql, then retry." });
          }
          return json(500, { error: "Could not save the template", details: sbErr(error) });
        }
        return json(200, { template: data });
      }

      if (!body.id) return json(400, { error: "id is required" });
      const { data, error } = await supabase
        .from("comment_templates")
        .update({ name, comments, updated_at: new Date().toISOString() })
        .eq("id", String(body.id))
        .select(COLS)
        .maybeSingle();
      if (error) return json(500, { error: "Could not update the template", details: sbErr(error) });
      if (!data) return json(404, { error: "Template not found." });
      return json(200, { template: data });
    }

    if (body.action === "delete") {
      if (!body.id) return json(400, { error: "id is required" });
      const { error } = await supabase.from("comment_templates").delete().eq("id", String(body.id));
      if (error) return json(500, { error: "Could not delete the template", details: sbErr(error) });
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
