// Lists the Drive Content/ClipN folders for the organic dashboard's Content page.
const { listClips } = require("./_shared/organic-drive");

exports.handler = async function () {
  try {
    const clips = await listClips();
    return { statusCode: 200, body: JSON.stringify({ clips }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ clips: [], error: err.message }) };
  }
};
