const { uploadStatus } = require("./_shared/organic-uploadpost");

exports.handler = async function (event) {
  const id = (event.queryStringParameters || {}).request_id;
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "request_id required" }) };
  try {
    return { statusCode: 200, body: JSON.stringify(await uploadStatus(id)) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
