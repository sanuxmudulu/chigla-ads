// Thin client for the Upload-Post REST API (https://docs.upload-post.com).
// Ported from chigla-organic/lib/uploadpost.ts.
const BASE = "https://api.upload-post.com/api";
const PLATFORMS = ["tiktok", "instagram", "youtube", "facebook"];

function isConfigured() {
  return Boolean(process.env.UPLOAD_POST_API_KEY && process.env.UPLOAD_POST_USER);
}

function buildFields(i) {
  const f = [["user", i.user]];
  for (const p of i.platforms) f.push(["platform[]", p]);
  f.push(["title", i.title]);
  if (i.description) f.push(["description", i.description]);
  if (i.platforms.includes("tiktok")) {
    f.push(["post_mode", "DIRECT_POST"]);
    if (i.tiktokPrivacy) f.push(["privacy_level", i.tiktokPrivacy]);
  }
  if (i.platforms.includes("youtube") && i.youtubePrivacy) f.push(["privacyStatus", i.youtubePrivacy]);
  if (i.platforms.includes("facebook")) {
    if (!i.facebookPageId) throw new Error("Facebook needs a Page ID (facebook_page_id)");
    f.push(["facebook_page_id", i.facebookPageId]);
  }
  if (i.scheduledDate) {
    f.push(["scheduled_date", i.scheduledDate]);
    if (i.timezone) f.push(["timezone", i.timezone]);
  }
  if (i.async) f.push(["async_upload", "true"]);
  return f;
}

function authHeaders() {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) throw new Error("UPLOAD_POST_API_KEY is not set");
  return { authorization: `Apikey ${key}` };
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function uploadVideo(i, video, filename) {
  const form = new FormData();
  for (const [k, v] of buildFields(i)) form.append(k, v);
  form.append("video", video, filename);
  const res = await fetch(`${BASE}/upload`, { method: "POST", headers: authHeaders(), body: form });
  return { httpStatus: res.status, ok: res.ok, body: await readBody(res) };
}

async function uploadStatus(requestId) {
  const url = `${BASE}/uploadposts/status?request_id=${encodeURIComponent(requestId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  return { httpStatus: res.status, ok: res.ok, body: await readBody(res) };
}

module.exports = { PLATFORMS, isConfigured, buildFields, uploadVideo, uploadStatus };
