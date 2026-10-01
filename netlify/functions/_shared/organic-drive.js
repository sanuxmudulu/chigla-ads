// Minimal Google Drive reader using a service account. Ported from the Next.js
// prototype (chigla-organic/lib/drive.ts) — same logic, plain CommonJS.
const { createSign } = require("crypto");

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const b64url = (b) => Buffer.from(b).toString("base64url");

let cached = null;

async function accessToken() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(
      JSON.stringify({
        iss: email,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google auth failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function list(q, fields = "id,name,mimeType,size") {
  const token = await accessToken();
  const out = [];
  let pageToken = "";
  do {
    const url = new URL(`${DRIVE}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", `nextPageToken,files(${fields})`);
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    for (const f of j.files) out.push({ ...f, size: f.size ? Number(f.size) : undefined });
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

async function findRootFolder() {
  if (process.env.GOOGLE_DRIVE_FOLDER_ID)
    return { id: process.env.GOOGLE_DRIVE_FOLDER_ID, name: "(from env)" };
  const found = await list(`mimeType='${FOLDER_MIME}' and name='Content' and trashed=false`);
  if (found.length === 0) throw new Error('No folder named "Content" is shared with the service account');
  if (found.length > 1) throw new Error('More than one shared folder named "Content"; set GOOGLE_DRIVE_FOLDER_ID');
  return found[0];
}

async function listClips(rootId) {
  const root = rootId || (await findRootFolder()).id;
  const folders = await list(`'${root}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`);
  const clips = folders
    .map((f) => ({ f, m: /^clip\s*(\d+)$/i.exec(f.name.trim()) }))
    .filter((x) => x.m)
    .map((x) => ({ clip: Number(x.m[1]), folder: x.f }))
    .sort((a, b) => a.clip - b.clip);
  return Promise.all(
    clips.map(async ({ clip, folder }) => {
      const files = await list(`'${folder.id}' in parents and trashed=false`);
      const videos = files.filter((f) => f.mimeType.startsWith("video/")).sort((a, b) => natural(a.name, b.name));
      return { clip, folderName: folder.name, videos };
    }),
  );
}

async function downloadFile(id) {
  const token = await accessToken();
  const res = await fetch(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  return res.blob();
}

module.exports = { findRootFolder, listClips, downloadFile };
