// Organic dashboard: Overview / Content / Schedule / Test post.
// Talks to the organic-* functions registered in api/[fn].js.

const PLATFORMS = ["tiktok", "instagram", "youtube", "facebook"];

document.getElementById("signOutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    location.href = "/login.html";
  }
});

// ---- view switcher ----
document.querySelectorAll(".organic-nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".organic-nav button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".organic-view").forEach((v) => v.classList.toggle("active", v.id === `view-${btn.dataset.view}`));
  });
});

async function getJSON(url) {
  const res = await fetch(url);
  return res.json();
}

// ---- data shared across views ----
let clipsCache = null;
async function loadClips() {
  if (clipsCache) return clipsCache;
  clipsCache = await getJSON("/api/organic-content");
  return clipsCache;
}

// ---- Overview ----
async function renderOverview() {
  const { clips, error } = await loadClips();
  const videos = clips.reduce((n, c) => n + c.videos.length, 0);
  const expected = 25;
  document.getElementById("kpiVideos").textContent = error ? "error" : `${videos}/${expected}`;
  document.getElementById("kpiPosts").textContent = "25 posts/day/platform";

  const items = [
    ["Rotation logic (25 videos/day, no repeats)", true],
    ["Google Drive reader", true],
    ["Site-wide login", true],
    ["Test post to Upload-Post", true],
    ["Supabase: captions, hashtags, settings", false],
    ["Auto-scheduler (daily cron -> Upload-Post scheduled_date)", false],
  ];
  document.getElementById("progressList").innerHTML = items
    .map(([label, done]) => `<span class="pill ${done ? "pill-ok" : "pill-warn"}">${done ? "Done" : "To do"}</span> ${label}<br/>`)
    .join("");
}

// ---- Content ----
async function renderContent() {
  const { clips, error } = await loadClips();
  const table = document.getElementById("contentTable");
  if (error) {
    table.innerHTML = `<tr><td style="color:#ff6b6b;">${error}</td></tr>`;
    return;
  }
  const cols = [0, 1, 2, 3, 4];
  const head = `<tr><th>Clip</th>${cols.map((h) => `<th>Hook ${h + 1}</th>`).join("")}</tr>`;
  const rows = clips
    .map((c) => {
      const cells = cols
        .map((h) => {
          const v = c.videos[h];
          return `<td>${v ? v.name : '<span style="color:#f1c40f;">missing</span>'}</td>`;
        })
        .join("");
      return `<tr><td>${c.folderName}</td>${cells}</tr>`;
    })
    .join("");
  table.innerHTML = head + rows;
}

// ---- Schedule ----
async function renderSchedule() {
  const { today, timeZone, plan, error } = await getJSON("/api/organic-schedule-preview");
  const table = document.getElementById("scheduleTable");
  if (error) {
    table.innerHTML = `<tr><td style="color:#ff6b6b;">${error}</td></tr>`;
    return;
  }
  const fmt = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit" });
  const head = `<tr><th>Session</th><th>Time (${timeZone})</th><th>Account</th><th>Clip</th><th>Hook</th></tr>`;
  const rows = plan
    .map(
      (p) =>
        `<tr><td>${p.session + 1}</td><td>${fmt.format(new Date(p.publishAt))}</td><td>Account ${p.account + 1}</td><td>Clip ${p.clip + 1}</td><td>Hook ${p.hook + 1}</td></tr>`,
    )
    .join("");
  table.innerHTML = head + rows;
}

// ---- Test post ----
async function renderTest() {
  const { clips, error } = await loadClips();
  const select = document.getElementById("tpVideo");
  const videos = clips.flatMap((c) => c.videos.map((v) => ({ id: v.id, name: v.name, label: `${c.folderName} / ${v.name}` })));
  if (error || videos.length === 0) {
    select.innerHTML = `<option>${error || "No videos in Drive yet"}</option>`;
    return;
  }
  select.innerHTML = videos.map((v) => `<option value="${v.id}" data-name="${v.name}">${v.label}</option>`).join("");

  const checksEl = document.getElementById("tpPlatforms");
  checksEl.innerHTML = PLATFORMS.map(
    (p, i) => `<label><input type="checkbox" value="${p}" ${i === 0 ? "checked" : ""}/> ${p}</label>`,
  ).join("");

  const out = document.getElementById("tpOut");
  const statusBtn = document.getElementById("tpStatus");
  let lastRequestId = "";

  async function send(dryRun) {
    const opt = select.selectedOptions[0];
    const platforms = [...checksEl.querySelectorAll("input:checked")].map((i) => i.value);
    const body = {
      fileId: opt?.value,
      fileName: opt?.dataset.name,
      platforms,
      title: document.getElementById("tpTitle").value,
      facebookPageId: document.getElementById("tpPageId").value || undefined,
      tiktokPrivacy: document.getElementById("tpTiktokPrivacy").value,
      youtubePrivacy: document.getElementById("tpYoutubePrivacy").value,
      dryRun,
    };
    out.style.display = "block";
    out.textContent = "Working...";
    try {
      const res = await fetch("/api/organic-test-post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      out.textContent = JSON.stringify(j, null, 2);
      lastRequestId = j?.body?.request_id || "";
      statusBtn.style.display = lastRequestId ? "inline-block" : "none";
    } catch (e) {
      out.textContent = "Error: " + e.message;
    }
  }

  document.getElementById("tpDryRun").onclick = () => send(true);
  document.getElementById("tpSend").onclick = () => send(false);
  statusBtn.onclick = async () => {
    out.textContent = "Checking...";
    const res = await fetch(`/api/organic-test-post-status?request_id=${encodeURIComponent(lastRequestId)}`);
    out.textContent = JSON.stringify(await res.json(), null, 2);
  };
}

renderOverview();
renderContent();
renderSchedule();
renderTest();
