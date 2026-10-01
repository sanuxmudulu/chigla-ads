// Dummy test endpoint: downloads one Drive video and posts it to the chosen
// platforms via Upload-Post. Ported from chigla-organic/app/api/test-post/route.ts.
const { downloadFile } = require("./_shared/organic-drive");
const { PLATFORMS, buildFields, uploadVideo } = require("./_shared/organic-uploadpost");

exports.handler = async function (event) {
  let b;
  try {
    b = JSON.parse(event.body || "{}");
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad JSON body" }) };
  }

  const user = process.env.UPLOAD_POST_USER;
  const platforms = (b.platforms || []).filter((p) => PLATFORMS.includes(p));
  if (!b.fileId || platforms.length === 0 || !b.title || !b.title.trim())
    return { statusCode: 400, body: JSON.stringify({ error: "Pick a video, at least one platform, and a caption" }) };
  if (!user) return { statusCode: 400, body: JSON.stringify({ error: "UPLOAD_POST_USER is not set" }) };

  try {
    const input = { ...b, user, platforms, async: true };
    const fields = buildFields(input); // throws early (e.g. missing Facebook Page ID) before any download
    if (b.dryRun)
      return { statusCode: 200, body: JSON.stringify({ dryRun: true, sentToUploadPost: false, fields, video: b.fileName }) };
    if (!process.env.UPLOAD_POST_API_KEY)
      return { statusCode: 400, body: JSON.stringify({ error: "UPLOAD_POST_API_KEY is not set" }) };
    const video = await downloadFile(b.fileId);
    const result = await uploadVideo(input, video, b.fileName || "video.mp4");
    return { statusCode: result.ok ? 200 : 502, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
