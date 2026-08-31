import {
  fetchGlitchyStats,
  fetchDailyTotals,
  loadCache,
  fetchTiktokConnections,
  startTiktokAuth,
  postTiktokAction,
  fetchTiktokCampaigns,
  syncTiktokCampaigns,
  fetchCampaignAdGroups,
  setCampaignStatus,
  setAdgroupStatus,
} from "./api.js";
import { initTheme } from "./theme.js";
import { createMainChart } from "./charts.js";

// ---------------------------------------------------------------------------
// Fallback dataset — only ever used on a brand-new browser with no cache AND
// a failed first network call, so the dashboard never renders empty.
// ---------------------------------------------------------------------------
function fallbackSources() {
  return [
    { source: "US_Sweeps_ABO_AdA", offer_name: "iPhone 16 Sweepstakes", clicks: 812, conversions: 34, payout: 289.0, entries_count: 40, reset_applied: true },
    { source: "US_Sweeps_ABO_AdB", offer_name: "iPhone 16 Sweepstakes", clicks: 540, conversions: 19, payout: 152.5, entries_count: 26, reset_applied: true },
    { source: "CBO_CPI_Android_Global", offer_name: "SuperApp Install", clicks: 1204, conversions: 88, payout: 176.0, entries_count: 61, reset_applied: false },
    { source: "UK_CPI_iOS_CBO", offer_name: "Fitness Tracker App", clicks: 396, conversions: 21, payout: 94.5, entries_count: 18, reset_applied: false },
  ];
}

// Glitchy's "hour" field is EST-anchored, so "today" here means the same EST
// calendar date the backend uses. The dashboard day rolls over automatically
// at EST midnight — there is no manual "New Day".
function todayStr() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}
function currentEstHour() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return est.getHours();
}
function estDateLabel() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return est.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
const money = (n) => `$${(n || 0).toFixed(2)}`;
const num = (n) => (n || 0).toLocaleString("en-US");
const signedMoney = (n) => `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`;

const state = {
  sources: [],
  glitchyRows: [], // raw per-source rows from Glitchy (clicks/payout/conversions)
  tiktokCampaigns: [], // rows from tiktok-campaigns (campaign_name == source)
  adGroupsByCampaign: {}, // campaign_id -> { loadedAt, rows, error }
  pendingActions: new Set(), // in-flight campaign/adgroup writes (double-click guard)
  raw: [],
  chartSource: "__all__",
  hasFetchedOnce: false,
  prevConversions: new Map(),
  baseSpendTotal: 0,
  baseEarningsTotal: 0,
  expandedSources: new Set(),
};

let lastUpdatedAt = null;
let mainChartCanvas = null;

// ============================== INIT ==============================

document.addEventListener("DOMContentLoaded", () => {
  updateDateDisplay();

  initTheme(() => {
    // Chart colors are read from CSS vars at creation time — rebuild on theme swap.
    renderChart();
  });

  mainChartCanvas = document.getElementById("mainChart");

  renderFromCacheOrFallback();
  wireEvents();
  handleTiktokReturn();
  startTimers();
  refreshAll();
  loadTiktokCampaigns();
});

// Loads stored TikTok campaign rows (fast, from Supabase) and merges them into
// the Detailed Metrics table. Does not hit the TikTok API — that only happens
// on an explicit "Sync campaigns".
async function loadTiktokCampaigns() {
  try {
    const data = await fetchTiktokCampaigns();
    state.tiktokCampaigns = data.campaigns || [];
    rebuildSources();
  } catch (_) {
    /* non-fatal — table still renders from Glitchy data */
  }
}

function updateDateDisplay() {
  const el = document.getElementById("dateDisplay");
  if (el) el.textContent = estDateLabel();
}

function renderFromCacheOrFallback() {
  const cache = loadCache();
  if (cache && cache.data && cache.data.sources && cache.data.sources.length) {
    applyGlitchyResponse(cache.data, { flagNewConversions: false });
    lastUpdatedAt = cache.savedAt || Date.now();
  } else {
    applyGlitchyResponse(
      { sources: fallbackSources(), raw: [] },
      { flagNewConversions: false }
    );
    lastUpdatedAt = Date.now();
  }
}

// ============================== EVENTS ==============================

function wireEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll(true));

  // ---- Tools panel ----
  document.getElementById("toolsBtn").addEventListener("click", openToolsDrawer);
  document.getElementById("closeToolsBtn").addEventListener("click", closeToolsDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeToolsDrawer);

  document.getElementById("toolsThemesToggle").addEventListener("click", () => {
    document.getElementById("toolsThemesGroup").classList.toggle("open");
  });

  document.getElementById("toolsAccountsBtn").addEventListener("click", () => {
    openAccountsModal();
    renderTiktokAccounts();
  });
  document.getElementById("closeAccountsModal").addEventListener("click", closeAccountsModal);
  document.getElementById("accountsModal").addEventListener("click", (e) => {
    if (e.target.id === "accountsModal") closeAccountsModal();
  });
  wireTiktokEvents();

  document.getElementById("toolsCalendarBtn").addEventListener("click", openCalendarModal);
  document.getElementById("closeCalendarModal").addEventListener("click", closeCalendarModal);
  document.getElementById("calendarModal").addEventListener("click", (e) => {
    if (e.target.id === "calendarModal") closeCalendarModal();
  });
  document.getElementById("calPrevMonth").addEventListener("click", () => shiftCalendarMonth(-1));
  document.getElementById("calNextMonth").addEventListener("click", () => shiftCalendarMonth(1));

  document.getElementById("chartSourceSelect").addEventListener("change", (e) => {
    state.chartSource = e.target.value;
    renderChart();
  });

  document.getElementById("sourcesBody").addEventListener("click", (e) => {
    // Campaign pause/unpause button — must NOT toggle the row.
    const campBtn = e.target.closest("[data-campaign-action]");
    if (campBtn) {
      e.stopPropagation();
      handleCampaignAction(campBtn);
      return;
    }
    // Ad group pause/unpause button inside an expanded row.
    const agBtn = e.target.closest("[data-adgroup-action]");
    if (agBtn) {
      e.stopPropagation();
      handleAdgroupAction(agBtn);
      return;
    }
    const row = e.target.closest("tr.source-row");
    if (!row) return;
    toggleRowExpand(row.dataset.source);
  });
}

function startTimers() {
  // "last updated Xs ago" ticker — also refreshes the (purely cosmetic) date
  // label so it keeps up if the dashboard is left open across EST midnight.
  setInterval(() => {
    const el = document.getElementById("lastUpdated");
    if (lastUpdatedAt) {
      const secs = Math.floor((Date.now() - lastUpdatedAt) / 1000);
      el.textContent = secs < 2 ? "updated just now" : secs < 60 ? `updated ${secs}s ago` : `updated ${Math.floor(secs / 60)}m ago`;
    }
    updateDateDisplay();
  }, 1000);

  // Auto-refresh real data periodically. This only re-fetches the running
  // session's totals — it never starts a new session.
  setInterval(() => refreshAll(), 60000);
}

// ============================== DATA FETCH ==============================

async function refreshAll(userTriggered) {
  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.classList.add("spinning");
  try {
    const today = todayStr();
    const data = await fetchGlitchyStats(today, today);
    applyGlitchyResponse(data, { flagNewConversions: state.hasFetchedOnce });
    state.hasFetchedOnce = true;
    lastUpdatedAt = Date.now();
    setStatus(null);
  } catch (err) {
    setStatus(`Couldn't reach Glitchy: ${err.message} — showing last known data.`, true);
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

function setStatus(msg, isError) {
  const el = document.getElementById("statusMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

function applyGlitchyResponse(data, { flagNewConversions }) {
  const sources = data.sources || [];

  const newConversionSources = new Set();
  if (flagNewConversions) {
    for (const s of sources) {
      const prev = state.prevConversions.get(s.source);
      if (prev !== undefined && s.conversions > prev) newConversionSources.add(s.source);
    }
  }
  state.prevConversions = new Map(sources.map((s) => [s.source, s.conversions]));

  state.glitchyRows = sources;
  state.raw = data.raw || [];

  rebuildSources({ newConversionSources });
}

// Builds the Detailed Metrics table rows as the UNION of:
//   - Glitchy sources (real clicks / earning / EPC), and
//   - TikTok campaigns inside tracked advertiser accounts (SOURCE = campaign
//     name), which appear as soon as the campaign exists even with no spend.
// TikTok-supplied metrics (spend, CPM, CPA, CPNC, ROAS) are still 0 — the
// metric merge is a later step. Matching key: Glitchy `source` == campaign name.
function rebuildSources(opts = {}) {
  const glitchyBySource = new Map(state.glitchyRows.map((s) => [s.source, s]));
  const tiktokByName = new Map();
  for (const c of state.tiktokCampaigns) {
    if (c && c.campaign_name) tiktokByName.set(c.campaign_name, c);
  }

  const names = new Set([...glitchyBySource.keys(), ...tiktokByName.keys()]);

  const merged = [...names].map((name) => {
    const g = glitchyBySource.get(name);
    const tk = tiktokByName.get(name);

    const clicks = g?.clicks || 0;
    const conversions = g?.conversions || 0;
    const payout = g?.payout || 0;

    // From TikTok — not wired to real values yet, initialise at 0.
    const spend = 0;
    const cpm = 0;
    const cpa = 0;
    const cpnc = 0;
    const roas = 0;

    const epc = clicks > 0 ? payout / clicks : 0;
    const profit = payout - spend;

    return {
      source: name,
      offer_name: g?.offer_name || null,
      clicks,
      conversions,
      payout,
      spend,
      cpm,
      cpa,
      cpnc,
      epc,
      roas,
      profit,
      status: tk
        ? { label: tk.effective_status || "Unknown", tone: tk.effective_tone || "neutral", detail: tk.status_detail || null }
        : null,
      hasTiktok: !!tk,
      hasGlitchy: !!g,
      campaignId: tk ? String(tk.campaign_id) : null,
      campaignOpStatus: tk ? tk.campaign_operation_status || null : null, // ENABLE / DISABLE
      advertiserName: tk ? tk.advertiser_name || null : null,
    };
  });

  state.sources = merged;
  state.baseSpendTotal = merged.reduce((a, s) => a + s.spend, 0);
  state.baseEarningsTotal = merged.reduce((a, s) => a + s.payout, 0);

  populateChartSourceOptions(merged);
  renderKpis();
  renderTable(opts.newConversionSources);
  renderChart();
}

function populateChartSourceOptions(sources) {
  const select = document.getElementById("chartSourceSelect");
  const current = state.chartSource;
  select.innerHTML = `<option value="__all__">All Sources Combined</option>`;
  sources.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.source;
    opt.textContent = s.source;
    select.appendChild(opt);
  });
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  else state.chartSource = "__all__";
}

// ============================== KPI ROW ==============================

function renderKpis() {
  const totalSpend = state.baseSpendTotal; // always 0 until TikTok is wired in
  const totalEarnings = state.baseEarningsTotal;
  const netProfit = totalEarnings - totalSpend;
  const roas = 0;

  setKpi("kpiSpend", money(totalSpend));
  setKpi("kpiEarnings", money(totalEarnings));
  setKpi("kpiProfit", (netProfit >= 0 ? "+" : "-") + money(Math.abs(netProfit)), netProfit >= 0 ? "positive" : "negative");
  setKpi("kpiRoas", `${roas.toFixed(2)}x`);
}

function setKpi(id, text, sentiment) {
  const el = document.getElementById(id);
  if (!el) return;
  const flashClass = sentiment === "positive" ? "kpi-flash-up" : sentiment === "negative" ? "kpi-flash-down" : null;
  el.textContent = text;
  el.classList.remove("positive", "negative");
  if (sentiment) el.classList.add(sentiment);
  const card = el.closest(".kpi-card");
  if (flashClass && card) {
    card.classList.remove("kpi-flash-up", "kpi-flash-down");
    void card.offsetWidth; // restart animation
    card.classList.add(flashClass);
  }
}

// ============================== TABLE ==============================

function renderTable(newConversionSources) {
  const tbody = document.getElementById("sourcesBody");
  tbody.innerHTML = "";

  const sorted = [...state.sources].sort((a, b) => b.profit - a.profit);
  // ROAS is 0 for every row until TikTok spend is real, so a "best ROAS"
  // crown would just be an arbitrary tie — only show it once ROAS can
  // actually distinguish rows.
  const bestRoas = sorted.reduce((best, s) => (s.roas > (best?.roas ?? 0) ? s : best), null);

  sorted.forEach((s) => {
    const tr = document.createElement("tr");
    tr.className = "source-row " + (s.profit >= 0 ? "profit-positive" : "profit-negative");
    tr.dataset.source = s.source;
    if (newConversionSources && newConversionSources.has(s.source)) {
      tr.classList.add("new-conversion");
      setTimeout(() => tr.classList.remove("new-conversion"), 2500);
    }

    const crown = bestRoas && s === bestRoas ? `<span class="crown" title="Best ROAS today">👑</span>` : "";

    tr.innerHTML = `
      <td>${statusBadge(s.status)}</td>
      <td class="source-name"><span class="expand-caret">▸</span>${crown}${escapeHtml(s.source)}</td>
      <td class="num">${money(s.spend)}</td>
      <td class="num">${money(s.cpm)}</td>
      <td class="num">${money(s.cpa)}</td>
      <td class="num">${money(s.cpnc)}</td>
      <td class="num">${num(s.clicks)}</td>
      <td class="num">${money(s.payout)}</td>
      <td class="num">${money(s.epc)}</td>
      <td class="num ${s.roas >= 1 ? "positive" : "negative"}">${s.roas.toFixed(2)}x</td>
      <td class="action-cell">${campaignActionButton(s)}</td>
    `;
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "row-detail";
    detailTr.innerHTML = `<td colspan="11"><div class="row-detail-inner"><div class="adgroups-panel" data-adgroups-for="${escapeHtml(s.campaignId || "")}"></div></div></td>`;
    tbody.appendChild(detailTr);

    if (state.expandedSources.has(s.source)) {
      tr.classList.add("expanded");
      requestAnimationFrame(() => renderAdGroupsPanel(s));
    }
  });
}

// Compact Pause / Unpause control for the campaign row. Only for rows backed by
// a tracked TikTok campaign.
function campaignActionButton(s) {
  if (!s.hasTiktok || !s.campaignId) return "";
  const op = String(s.campaignOpStatus || "").toUpperCase();
  const paused = op === "DISABLE";
  const label = paused ? "Unpause" : "Pause";
  const pending = state.pendingActions.has(`c:${s.campaignId}`);
  return `<button class="mini-action ${paused ? "resume" : "pause"}" data-campaign-action="${paused ? "ENABLE" : "DISABLE"}" data-campaign-id="${escapeHtml(s.campaignId)}" ${pending ? "disabled" : ""}>${pending ? "…" : label}</button>`;
}

function toggleRowExpand(source) {
  const tr = document.querySelector(`tr.source-row[data-source="${cssEscapeAttr(source)}"]`);
  if (!tr) return;
  const isOpen = tr.classList.toggle("expanded");
  const s = state.sources.find((x) => x.source === source);
  if (isOpen) {
    state.expandedSources.add(source);
    if (s) renderAdGroupsPanel(s);
  } else {
    state.expandedSources.delete(source);
  }
}

// ---- expanded ad-group panel (lazy-loaded from TikTok MCP) ----

function panelEl(campaignId) {
  return document.querySelector(`.adgroups-panel[data-adgroups-for="${cssEscapeAttr(campaignId || "")}"]`);
}

async function renderAdGroupsPanel(s, { force } = {}) {
  const panel = panelEl(s.campaignId);
  if (!panel) return;

  if (!s.hasTiktok || !s.campaignId) {
    panel.innerHTML = `<div class="adgroups-empty">No tracked TikTok campaign for this source — ad groups come from TikTok only.</div>`;
    return;
  }

  const cached = state.adGroupsByCampaign[s.campaignId];
  const fresh = cached && Date.now() - cached.loadedAt < 60000 && !force;
  if (fresh && cached.rows) {
    paintAdGroups(panel, s, cached.rows);
    return;
  }
  if (cached && cached.error && !force) {
    panel.innerHTML = `<div class="adgroups-error">Couldn't load ad groups: ${escapeHtml(cached.error)}</div>`;
    return;
  }

  panel.innerHTML = `<div class="adgroups-loading">Loading ad groups…</div>`;
  try {
    const res = await fetchCampaignAdGroups(s.campaignId);
    state.adGroupsByCampaign[s.campaignId] = { loadedAt: Date.now(), rows: res.adgroups || [] };
    applyCampaignStatusResult(res); // keep the row status in sync with the live read
    const s2 = state.sources.find((x) => x.campaignId === s.campaignId) || s;
    const panel2 = panelEl(s.campaignId);
    if (panel2) paintAdGroups(panel2, s2, res.adgroups || []);
  } catch (err) {
    state.adGroupsByCampaign[s.campaignId] = { loadedAt: Date.now(), error: err.message };
    const p = panelEl(s.campaignId);
    if (p) p.innerHTML = `<div class="adgroups-error">Couldn't load ad groups: ${escapeHtml(err.message)}</div>`;
  }
}

function paintAdGroups(panel, s, rows) {
  if (!rows.length) {
    panel.innerHTML = `<div class="adgroups-empty">This campaign has no ad groups.</div>`;
    return;
  }
  panel.innerHTML = `
    <table class="adgroups-table">
      <thead>
        <tr><th>Ad group</th><th>Status</th><th class="num">Spend</th><th class="num">CPA</th><th>Action</th></tr>
      </thead>
      <tbody>
        ${rows.map((g) => adGroupRowHtml(s.campaignId, g)).join("")}
      </tbody>
    </table>
    <div class="adgroups-foot">TikTok · today only · CPA = cost per conversion</div>`;
}

function adGroupRowHtml(campaignId, g) {
  const paused = String(g.operation_status || "").toUpperCase() === "DISABLE";
  const label = paused ? "Unpause" : "Pause";
  const key = `g:${g.adgroup_id}`;
  const pending = state.pendingActions.has(key);
  return `
    <tr data-adgroup-row="${escapeHtml(g.adgroup_id)}">
      <td>
        <div class="ag-name">${escapeHtml(g.adgroup_name || g.adgroup_id)}</div>
        <div class="ag-id">${escapeHtml(g.adgroup_id)}</div>
      </td>
      <td><span class="status-badge ${["good", "warn", "bad", "neutral"].includes(g.status_tone) ? g.status_tone : "neutral"}">${escapeHtml(g.status_label || "—")}</span></td>
      <td class="num">${money(g.spend)}</td>
      <td class="num">${money(g.cpa)}</td>
      <td>
        <button class="mini-action ${paused ? "resume" : "pause"}" data-adgroup-action="${paused ? "ENABLE" : "DISABLE"}" data-campaign-id="${escapeHtml(campaignId)}" data-adgroup-id="${escapeHtml(g.adgroup_id)}" ${pending ? "disabled" : ""}>${pending ? "…" : label}</button>
      </td>
    </tr>`;
}

// Merge a { campaign_id, campaign_operation_status, effective_status, ... }
// result from the backend into the stored campaign + re-render its row/panel.
function applyCampaignStatusResult(res) {
  if (!res || !res.campaign_id) return;
  const tk = state.tiktokCampaigns.find((c) => String(c.campaign_id) === String(res.campaign_id));
  if (tk) {
    if (res.campaign_operation_status !== undefined) tk.campaign_operation_status = res.campaign_operation_status;
    if (res.effective_status) tk.effective_status = res.effective_status;
    if (res.effective_tone) tk.effective_tone = res.effective_tone;
    if (res.status_detail !== undefined) tk.status_detail = res.status_detail;
  }
  if (Array.isArray(res.adgroups)) {
    state.adGroupsByCampaign[String(res.campaign_id)] = { loadedAt: Date.now(), rows: res.adgroups };
  }
  rebuildSources();
  // rebuildSources -> renderTable rebuilds rows; re-open panels that were expanded.
  for (const s of state.sources) {
    if (state.expandedSources.has(s.source)) {
      const cached = state.adGroupsByCampaign[s.campaignId];
      const panel = panelEl(s.campaignId);
      if (panel && cached && cached.rows) paintAdGroups(panel, s, cached.rows);
    }
  }
}

// ---- campaign / ad group pause-unpause writes ----

async function handleCampaignAction(btn) {
  const campaignId = btn.dataset.campaignId;
  const targetOp = btn.dataset.campaignAction; // ENABLE | DISABLE
  const key = `c:${campaignId}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const outcome = await withTiktokPassword(
      {
        title: targetOp === "DISABLE" ? "Pause campaign" : "Enable campaign",
        hint: "Enter the dashboard password to change this TikTok campaign.",
      },
      (password) => setCampaignStatus(password, campaignId, targetOp)
    );
    if (outcome && !outcome.cancelled) {
      applyCampaignStatusResult(outcome.result);
      setStatus(`Campaign ${targetOp === "DISABLE" ? "paused" : "enabled"} — now “${outcome.result.effective_status}”.`);
    }
  } catch (err) {
    setStatus(`Campaign update failed: ${err.message}`, true);
  } finally {
    state.pendingActions.delete(key);
    rebuildSources();
  }
}

async function handleAdgroupAction(btn) {
  const campaignId = btn.dataset.campaignId;
  const adgroupId = btn.dataset.adgroupId;
  const targetOp = btn.dataset.adgroupAction;
  const key = `g:${adgroupId}`;
  if (state.pendingActions.has(key)) return;
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const outcome = await withTiktokPassword(
      {
        title: targetOp === "DISABLE" ? "Pause ad group" : "Unpause ad group",
        hint: "Enter the dashboard password to change this ad group.",
      },
      (password) => setAdgroupStatus(password, campaignId, adgroupId, targetOp)
    );
    if (outcome && !outcome.cancelled) {
      applyCampaignStatusResult(outcome.result);
      setStatus(`Ad group ${targetOp === "DISABLE" ? "paused" : "unpaused"}.`);
    }
  } catch (err) {
    setStatus(`Ad group update failed: ${err.message}`, true);
    const s = state.sources.find((x) => x.campaignId === campaignId);
    if (s) renderAdGroupsPanel(s, { force: true });
  } finally {
    state.pendingActions.delete(key);
  }
}

// Real per-source hourly payout, derived from the raw Glitchy entries the
// function already returns (not baseline-corrected, but genuinely real data).
// Glitchy's "hour" field is already anchored to EST, so these buckets need
// no timezone conversion of their own.
function hourlyPayoutForSource(source) {
  const buckets = Array(24).fill(0);
  for (const entry of state.raw) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat || stat.source !== source) continue;
    const hr = parseInt(stat.hour, 10);
    if (Number.isFinite(hr) && hr >= 0 && hr < 24) buckets[hr] += Number(stat.payout || 0);
  }
  const hours = buckets.map((_, h) => `${String(h).padStart(2, "0")}:00`);
  return { hours, values: buckets.map((v) => Math.round(v * 100) / 100) };
}

// Effective operating status for a SOURCE/campaign row. `status` is
// { label, tone, detail } from the TikTok campaign, or null when the source
// only exists on the Glitchy side (no matching tracked TikTok campaign).
function statusBadge(status) {
  if (!status || !status.label) {
    return `<span class="status-badge none" title="No matching tracked TikTok campaign">—</span>`;
  }
  const tone = ["good", "warn", "bad", "neutral"].includes(status.tone) ? status.tone : "neutral";
  const tip = status.detail ? `${status.label} — ${status.detail}` : status.label;
  return `<span class="status-badge ${tone}" title="${escapeHtml(tip)}">${escapeHtml(status.label)}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cssSafeId(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, "_");
}
function cssEscapeAttr(str) {
  return String(str).replace(/"/g, '\\"');
}

// ============================== MAIN CHART ==============================

function hourlyPayoutCombined() {
  const buckets = Array(24).fill(0);
  for (const entry of state.raw) {
    const stat = entry.Stat || entry.stat || entry;
    if (!stat) continue;
    const hr = parseInt(stat.hour, 10);
    if (Number.isFinite(hr) && hr >= 0 && hr < 24) buckets[hr] += Number(stat.payout || 0);
  }
  return buckets;
}

function renderChart() {
  if (!mainChartCanvas || !window.Chart) return;

  // Fixed 00:00–23:00 EST axis, always — never the viewer's local timezone.
  // Only hours up to (and including) the current EST hour get plotted;
  // everything after stays a gap (null) until that hour actually happens.
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const limit = currentEstHour() + 1;

  const spendFull = Array(24).fill(0); // no hourly shape until TikTok is connected
  let earningsFull;
  if (state.chartSource === "__all__") {
    earningsFull = hourlyPayoutCombined();
  } else {
    earningsFull = hourlyPayoutForSource(state.chartSource).values;
  }

  const spendBuckets = spendFull.map((v, h) => (h < limit ? v : null));
  const earningsBuckets = earningsFull.map((v, h) => (h < limit ? v : null));

  createMainChart(mainChartCanvas, hourLabels, earningsBuckets, spendBuckets);
}

// ============================== TOOLS DRAWER ==============================

function openToolsDrawer() {
  document.getElementById("toolsDrawer").classList.add("open");
  document.getElementById("drawerBackdrop").classList.add("open");
}
function closeToolsDrawer() {
  document.getElementById("toolsDrawer").classList.remove("open");
  document.getElementById("drawerBackdrop").classList.remove("open");
}

// ============================== TIKTOK ACCOUNTS MODAL ==============================
// Authentication + connection storage + advertiser discovery/selection only.
// All token handling lives in the tiktok-* Netlify functions.

const tiktokState = { connections: [], advertisers: [], dirty: false };
let tiktokPassword = null; // cached in memory for the session after first success
let tiktokPwHandler = null;

function openAccountsModal() {
  document.getElementById("accountsModal").classList.add("open");
}
function closeAccountsModal() {
  document.getElementById("accountsModal").classList.remove("open");
}

function wireTiktokEvents() {
  document.getElementById("tiktokConnectBtn").addEventListener("click", connectTiktok);
  document.getElementById("tiktokSaveTrackedBtn").addEventListener("click", saveTiktokTracked);
  document.getElementById("tiktokSyncCampaignsBtn").addEventListener("click", () => runTiktokCampaignSync());

  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.addEventListener("change", (e) => {
    if (e.target.matches('input[type="checkbox"][data-tk-adv]')) markTiktokDirty(true);
  });
  wrap.addEventListener("click", (e) => {
    const refreshId = e.target.dataset?.tkRefresh;
    const disconnectId = e.target.dataset?.tkDisconnect;
    if (refreshId) refreshTiktokConnection(refreshId, e.target);
    if (disconnectId) disconnectTiktokConnection(disconnectId);
  });

  document.getElementById("tiktokPwCancel").addEventListener("click", closeTiktokPwModal);
  document.getElementById("tiktokPwConfirm").addEventListener("click", submitTiktokPw);
  document.getElementById("tiktokPwInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitTiktokPw();
  });
  document.getElementById("tiktokPwModal").addEventListener("click", (e) => {
    if (e.target.id === "tiktokPwModal") closeTiktokPwModal();
  });
}

function markTiktokDirty(value) {
  tiktokState.dirty = value;
  document.getElementById("tiktokSaveTrackedBtn").disabled = !value;
}

async function renderTiktokAccounts() {
  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.innerHTML = `<p class="tk-loading">Loading connections…</p>`;
  markTiktokDirty(false);

  let data;
  try {
    data = await fetchTiktokConnections();
  } catch (err) {
    wrap.innerHTML = `<p class="tk-error">Couldn't load connections: ${escapeHtml(err.message)}</p>`;
    return;
  }

  tiktokState.connections = data.connections || [];
  tiktokState.advertisers = data.advertisers || [];

  renderTiktokSummary();

  if (!tiktokState.connections.length) {
    wrap.innerHTML = `<p class="tk-empty">No TikTok accounts connected yet. Click “Connect TikTok Ads” and authorize in this browser profile.</p>`;
    return;
  }

  wrap.innerHTML = tiktokState.connections
    .map((c) => {
      const advs = tiktokState.advertisers
        .filter((a) => a.connection_id === c.id)
        // Approved accounts first, then Suspended; stable by name within a group.
        .slice()
        .sort(
          (a, b) =>
            advApprovedRank(a) - advApprovedRank(b) ||
            String(a.advertiser_name || a.advertiser_id).localeCompare(String(b.advertiser_name || b.advertiser_id))
        );
      const rows = advs.length
        ? advs.map((a) => tiktokAdvRow(c.id, a)).join("")
        : `<p class="tk-empty">No advertiser accounts found for this connection.</p>`;
      const approved = advs.filter((a) => advIsApproved(a)).length;
      const sub = [
        c.tiktok_email || c.tiktok_display_name || "",
        `${advs.length} account${advs.length === 1 ? "" : "s"}`,
        `${approved} Approved · ${advs.length - approved} Suspended`,
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <div class="tk-conn" data-tk-conn-card="${c.id}">
          <div class="tk-conn-head">
            <div>
              <div class="tk-conn-label">${escapeHtml(c.label || "TikTok connection")}</div>
              <div class="tk-conn-sub">${escapeHtml(sub)}</div>
            </div>
            <div class="tk-conn-actions">
              <button class="tk-mini" data-tk-refresh="${c.id}">Re-scan</button>
              <button class="tk-mini danger" data-tk-disconnect="${c.id}">Disconnect</button>
            </div>
          </div>
          <div class="tk-adv-list">${rows}</div>
        </div>`;
    })
    .join("");
}

// TikTok advertiser `status` is kept raw in storage; only the label shown to
// the user is mapped. STATUS_ENABLE -> "Approved", anything else -> "Suspended".
function advIsApproved(a) {
  return String(a.status || "").toUpperCase() === "STATUS_ENABLE";
}
function advApprovedRank(a) {
  return advIsApproved(a) ? 0 : 1;
}
function advStatusLabel(a) {
  return advIsApproved(a) ? "Approved" : "Suspended";
}

function renderTiktokSummary() {
  const el = document.getElementById("tiktokSummary");
  if (!el) return;
  const advs = tiktokState.advertisers || [];
  if (!advs.length) {
    el.innerHTML = "";
    return;
  }
  const approved = advs.filter((a) => advIsApproved(a)).length;
  el.innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;
}

function tiktokAdvRow(connectionId, a) {
  const meta = [
    a.advertiser_id,
    a.currency || null,
    a.display_timezone || a.timezone || null,
    a.bc_name || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const approved = advIsApproved(a);
  return `
    <label class="tk-adv">
      <input type="checkbox" data-tk-adv data-tk-adv-id="${escapeHtml(a.advertiser_id)}" data-tk-conn-id="${connectionId}" ${a.tracked ? "checked" : ""} />
      <span class="tk-adv-main">
        <span class="tk-adv-name">${escapeHtml(a.advertiser_name || a.advertiser_id)}</span>
        <span class="tk-adv-meta">${escapeHtml(meta)}</span>
      </span>
      <span class="tk-adv-status ${approved ? "ok" : "warn"}">${advStatusLabel(a)}</span>
    </label>`;
}

// ---- privileged action helper (password gate, mirrors the New Day pattern) ----

function askTiktokPassword({ title, hint }) {
  return new Promise((resolve) => {
    tiktokPwHandler = resolve;
    document.getElementById("tiktokPwTitle").textContent = title || "Dashboard password";
    document.getElementById("tiktokPwHint").textContent =
      hint || "Enter the dashboard password to continue.";
    document.getElementById("tiktokPwInput").value = "";
    document.getElementById("tiktokPwError").textContent = "";
    document.getElementById("tiktokPwModal").classList.add("open");
    document.getElementById("tiktokPwInput").focus();
  });
}
function closeTiktokPwModal() {
  document.getElementById("tiktokPwModal").classList.remove("open");
  if (tiktokPwHandler) {
    tiktokPwHandler(null);
    tiktokPwHandler = null;
  }
}
function submitTiktokPw() {
  const val = document.getElementById("tiktokPwInput").value;
  if (!val) {
    document.getElementById("tiktokPwError").textContent = "Password required.";
    return;
  }
  document.getElementById("tiktokPwModal").classList.remove("open");
  if (tiktokPwHandler) {
    tiktokPwHandler(val);
    tiktokPwHandler = null;
  }
}

// Runs `fn(password)`; prompts for the password unless one is already cached,
// and clears the cache on a 401 so the next attempt re-prompts.
async function withTiktokPassword(purpose, fn) {
  let password = tiktokPassword;
  if (!password) {
    password = await askTiktokPassword(purpose);
    if (!password) return { cancelled: true };
  }
  try {
    const result = await fn(password);
    tiktokPassword = password;
    return { result };
  } catch (err) {
    if (err.status === 401) {
      tiktokPassword = null;
      setStatus("Incorrect password.", true);
    }
    throw err;
  }
}

// ---- actions ----

async function connectTiktok() {
  let outcome;
  try {
    outcome = await withTiktokPassword(
      {
        title: "Connect TikTok Ads",
        hint: "Enter the dashboard password. You'll then be sent to TikTok to authorize this browser's logged-in Business account.",
      },
      (password) => startTiktokAuth(password, "")
    );
  } catch (err) {
    setStatus(`Couldn't start TikTok authentication: ${err.message}`, true);
    return;
  }
  if (!outcome || outcome.cancelled) return;
  const { authorizeUrl } = outcome.result;
  if (!authorizeUrl) {
    setStatus("TikTok did not return an authorization URL.", true);
    return;
  }
  // Full-page redirect — survives AdsPower profiles and popup blockers. We come
  // back to /?tiktok=connected (handled in init).
  window.location.assign(authorizeUrl);
}

async function saveTiktokTracked() {
  const selections = [...document.querySelectorAll('input[type="checkbox"][data-tk-adv]')].map(
    (el) => ({
      connection_id: el.dataset.tkConnId,
      advertiser_id: el.dataset.tkAdvId,
      tracked: el.checked,
    })
  );
  const btn = document.getElementById("tiktokSaveTrackedBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const outcome = await withTiktokPassword(
      { title: "Save tracked accounts", hint: "Enter the dashboard password to save your selection." },
      (password) => postTiktokAction({ password, action: "track", selections })
    );
    if (outcome && !outcome.cancelled) {
      markTiktokDirty(false);
      setStatus(`Saved — tracking ${selections.filter((s) => s.tracked).length} advertiser account(s).`);
      // Pull in campaigns for the freshly-selected accounts.
      await runTiktokCampaignSync({ silent: true });
    }
  } catch (err) {
    setStatus(`Couldn't save selection: ${err.message}`, true);
  } finally {
    btn.textContent = "Save tracked accounts";
    btn.disabled = !tiktokState.dirty;
  }
}

// Hits the TikTok MCP for every tracked advertiser account, refreshes stored
// campaigns + their effective status, then re-merges the Detailed Metrics table.
async function runTiktokCampaignSync({ silent } = {}) {
  const btn = document.getElementById("tiktokSyncCampaignsBtn");
  const original = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Syncing…";
  }
  if (!silent) setStatus("Syncing TikTok campaigns…");
  try {
    const outcome = await withTiktokPassword(
      { title: "Sync campaigns", hint: "Enter the dashboard password to pull campaigns from the tracked accounts." },
      (password) => syncTiktokCampaigns(password)
    );
    if (outcome && !outcome.cancelled) {
      await loadTiktokCampaigns();
      const r = outcome.result || {};
      if (r.note) setStatus(r.note);
      else setStatus(`Synced ${r.campaignCount ?? 0} TikTok campaign(s) from ${r.connections ?? 0} connection(s).`);
    }
  } catch (err) {
    setStatus(`Campaign sync failed: ${err.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original || "Sync campaigns";
    }
  }
}

async function refreshTiktokConnection(connectionId, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    const outcome = await withTiktokPassword(
      { title: "Re-scan accounts", hint: "Enter the dashboard password to re-scan this connection." },
      (password) => postTiktokAction({ password, action: "refresh", connection_id: connectionId })
    );
    if (outcome && !outcome.cancelled) {
      setStatus(`Re-scanned — ${outcome.result.advertiserCount ?? 0} advertiser account(s) found.`);
      await renderTiktokAccounts();
    }
  } catch (err) {
    setStatus(`Re-scan failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function disconnectTiktokConnection(connectionId) {
  try {
    const outcome = await withTiktokPassword(
      { title: "Disconnect", hint: "Enter the dashboard password to remove this TikTok connection." },
      (password) => postTiktokAction({ password, action: "disconnect", connection_id: connectionId })
    );
    if (outcome && !outcome.cancelled) {
      setStatus("TikTok connection removed.");
      await renderTiktokAccounts();
    }
  } catch (err) {
    setStatus(`Couldn't disconnect: ${err.message}`, true);
  }
}

// Called from init when returning from the OAuth redirect.
function handleTiktokReturn() {
  const qp = new URLSearchParams(window.location.search);
  const kind = qp.get("tiktok");
  if (!kind) return;

  if (kind === "connected") {
    const n = qp.get("accounts");
    const warn = qp.get("warn");
    setStatus(
      `TikTok account connected${n != null ? ` — ${n} ad account(s) discovered` : ""}.` +
        (warn ? ` Note: ${warn}` : "")
    );
  } else if (kind === "error") {
    setStatus(`TikTok connection failed: ${qp.get("reason") || "unknown error"}`, true);
  }

  history.replaceState({}, "", window.location.pathname);

  if (kind === "connected") {
    openAccountsModal();
    renderTiktokAccounts();
  }
}

// ============================== PROFIT CALENDAR (modal, on demand) ==============================
// Automatic history — no "New Day". Reads the stored daily_totals rows; the
// current day's row is kept fresh by the normal glitchy-stats poll.

let calendarMonth = null; // "YYYY-MM" currently displayed

function monthGridDays(daily) {
  const month = daily.month || todayStr().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstWeekday = new Date(year, mon - 1, 1).getDay();
  const todayIso = todayStr();
  const rowsByDate = new Map((daily.days || []).map((d) => [d.date, d]));

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    days.push({
      dateStr,
      day: d,
      isFuture: dateStr > todayIso,
      isToday: dateStr === todayIso,
      entry: rowsByDate.get(dateStr) || null,
    });
  }
  return { year, mon, firstWeekday, days };
}

function dayProfit(entry) {
  if (!entry) return 0;
  if (entry.net_profit != null) return entry.net_profit;
  return (entry.total_earnings || 0) - (entry.total_spend || 0);
}

async function openCalendarModal() {
  document.getElementById("calendarModal").classList.add("open");
  calendarMonth = todayStr().slice(0, 7);
  await loadCalendar();
}

function closeCalendarModal() {
  document.getElementById("calendarModal").classList.remove("open");
}

function shiftCalendarMonth(delta) {
  if (!calendarMonth) calendarMonth = todayStr().slice(0, 7);
  const [y, m] = calendarMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadCalendar();
}

async function loadCalendar() {
  const grid = document.getElementById("calendarGridDetailed");
  grid.innerHTML = `<div class="cal-loading">Loading…</div>`;
  try {
    const daily = await fetchDailyTotals(calendarMonth);
    renderDetailedCalendar(daily);
  } catch (_) {
    renderDetailedCalendar({ month: calendarMonth, days: [] });
  }
}

// Heatmap intensity for one day's profit, normalised against the visible month
// so a single unusually large day doesn't wash out the rest. The reference is
// the ~80th percentile of the month's absolute profits (falls back to the max);
// sqrt scaling lifts the mid-range. Near-zero days stay very subtle.
function makeIntensity(magnitudes) {
  const sorted = magnitudes.filter((v) => v > 0).sort((a, b) => a - b);
  const ref = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))] || sorted[sorted.length - 1]
    : 1;
  return (profit) => {
    const r = Math.min(1, Math.sqrt(Math.abs(profit) / (ref || 1)));
    return Math.round(6 + r * 46); // 6% (subtle) .. 52%
  };
}

function renderDetailedCalendar(daily) {
  const { year, mon, firstWeekday, days } = monthGridDays(daily);

  document.getElementById("calendarModalMonthLabel").textContent = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const populated = days.filter((d) => d.entry && !d.isFuture);
  const totalSpend = populated.reduce((a, d) => a + (d.entry.total_spend || 0), 0);
  const totalEarnings = populated.reduce((a, d) => a + (d.entry.total_earnings || 0), 0);
  const totalProfit = totalEarnings - totalSpend;
  const overallRoas = totalSpend > 0 ? totalEarnings / totalSpend : 0;

  document.getElementById("summarySpend").textContent = money(totalSpend);
  document.getElementById("summaryEarnings").textContent = money(totalEarnings);
  const profitEl = document.getElementById("summaryProfit");
  profitEl.textContent = signedMoney(totalProfit);
  profitEl.classList.toggle("positive", totalProfit >= 0);
  profitEl.classList.toggle("negative", totalProfit < 0);
  document.getElementById("summaryRoas").textContent = `${overallRoas.toFixed(2)}x`;

  const intensity = makeIntensity(populated.map((d) => Math.abs(dayProfit(d.entry))));

  const grid = document.getElementById("calendarGridDetailed");
  grid.innerHTML = "";

  for (let i = 0; i < firstWeekday; i++) {
    const filler = document.createElement("div");
    filler.className = "cal-cell-detailed empty";
    grid.appendChild(filler);
  }

  days.forEach(({ dateStr, day, isFuture, isToday, entry }, idx) => {
    const cell = document.createElement("div");
    cell.className = "cal-cell-detailed" + (isFuture ? " future" : "") + (isToday ? " today" : "");
    cell.style.animationDelay = `${idx * 5}ms`;

    if (entry && !isFuture) {
      const profit = dayProfit(entry);
      const sentiment = profit >= 0 ? "positive" : "negative";
      const pct = intensity(profit);
      cell.style.background =
        profit >= 0
          ? `color-mix(in srgb, var(--profit) ${pct}%, var(--bg-2))`
          : `color-mix(in srgb, var(--loss) ${pct}%, var(--bg-2))`;
      cell.innerHTML = `
        <span class="cal-d-daynum">${day}</span>
        <span class="cal-d-amount ${sentiment}">${signedMoney(profit)}</span>`;
      cell.title = `${dateStr} — net profit ${signedMoney(profit)}`;
    } else {
      cell.innerHTML = `<span class="cal-d-daynum">${day}</span>`;
      cell.title = dateStr;
    }

    grid.appendChild(cell);
  });
}
