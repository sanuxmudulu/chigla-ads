import {
  fetchGlitchyStats,
  fetchMabacStats,
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
  fetchTiktokBudgets,
  setAdvertiserBudget,
  setConnectionNetwork,
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
  glitchyRows: [], // per-source rows from Glitchy (clicks/payout/conversions)
  mabacRows: [], // per-sub1 rows from Mabac (clicks/conversions/revenue)
  mabacConfigured: false,
  tiktokCampaigns: [], // rows from tiktok-campaigns (campaign_name == source)
  budgets: {}, // advertiser_id -> { budget_mode, capped, cap, spent, remaining, account_balance, currency, bc_id }
  bcBalances: {}, // bc_id -> { balance, currency, bc_name }
  detailBcFilter: "all", // "all" | bc_id — VIEW filter only, never untracks anything
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
  loadTiktokBudgets();
});

// Loads stored TikTok campaign rows (fast, from Supabase) and merges them into
// the Detailed Metrics table. Does not hit the TikTok API — that only happens
// on an explicit "Refresh TikTok Data".
async function loadTiktokCampaigns() {
  try {
    const data = await fetchTiktokCampaigns();
    state.tiktokCampaigns = data.campaigns || [];
    renderDetailBcSelector();
    rebuildSources();
  } catch (_) {
    /* non-fatal — table still renders from Glitchy data */
  }
}

// Advertiser-account budgets + BC balances. Hits the MCP, so on load + manual
// refresh only (not the 60s poll).
async function loadTiktokBudgets() {
  try {
    const data = await fetchTiktokBudgets();
    state.budgets = data.advertisers || {};
    state.bcBalances = data.bc || {};
    renderDetailBcSelector();
    rebuildSources();
  } catch (_) {
    /* non-fatal — Budget column just shows — */
  }
}

// Mabac affiliate report for today. Optional network — Glitchy keeps working
// regardless.
async function loadMabac() {
  try {
    const today = todayStr();
    const data = await fetchMabacStats(today, today);
    state.mabacConfigured = !!data.configured;
    state.mabacRows = data.sources || [];
    rebuildSources();
  } catch (_) {
    /* non-fatal */
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

  document.getElementById("detailBcSelect").addEventListener("change", (e) => {
    state.detailBcFilter = e.target.value;
    updateBcBalanceBanner();
    rebuildSources();
  });

  // ---- Advertiser budget modal ----
  document.getElementById("closeBudgetModal").addEventListener("click", closeBudgetModal);
  document.getElementById("cancelBudgetBtn").addEventListener("click", closeBudgetModal);
  document.getElementById("budgetModal").addEventListener("click", (e) => {
    if (e.target.id === "budgetModal") closeBudgetModal();
  });
  document.getElementById("budgetModeSelect").addEventListener("change", syncBudgetAmountVisibility);
  document.getElementById("confirmBudgetBtn").addEventListener("click", submitBudgetEdit);

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
    // Advertiser budget "Edit" / "Set cap" — must NOT toggle the row.
    const budBtn = e.target.closest("[data-budget-edit]");
    if (budBtn) {
      e.stopPropagation();
      openBudgetModal(budBtn.dataset.budgetEdit);
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
    // Glitchy is the primary affiliate source and must not be affected by Mabac.
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
  // Mabac runs alongside, independently.
  loadMabac();
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

// Builds the Detailed Metrics table rows.
//
// Affiliate-network ownership (deterministic, never double-counts):
//   - A row backed by a tracked TikTok campaign uses THAT campaign's
//     affiliate_network (from its connection). Its clicks/earning come only
//     from that one network's data by name.
//   - An affiliate row with no TikTok campaign: GLITCHY if it's a Glitchy
//     source, MABAC if it's only in Mabac. Shown only in the "All Business
//     Centers" view.
// Glitchy earnings + Mabac earnings for the same name are NEVER summed.
//
// The Business Center selector (state.detailBcFilter) is a VIEW filter only —
// it never changes tracked selections.
function rebuildSources(opts = {}) {
  const glitchyByName = new Map(state.glitchyRows.map((s) => [s.source, s]));
  const mabacByName = new Map(state.mabacRows.map((s) => [s.sub1, s]));

  const bcFilter = state.detailBcFilter || "all";
  const tiktokByName = new Map();
  for (const c of state.tiktokCampaigns) {
    if (!c || !c.campaign_name) continue;
    if (bcFilter !== "all" && String(c.bc_id || "") !== String(bcFilter)) continue;
    tiktokByName.set(c.campaign_name, c);
  }

  const names = new Set(tiktokByName.keys());
  if (bcFilter === "all") {
    for (const k of glitchyByName.keys()) names.add(k);
    for (const k of mabacByName.keys()) names.add(k);
  }

  const merged = [...names].map((name) => {
    const tk = tiktokByName.get(name);
    const g = glitchyByName.get(name);
    const m = mabacByName.get(name);

    // Which network owns this row's affiliate figures?
    let network;
    if (tk) network = String(tk.affiliate_network || "GLITCHY").toUpperCase();
    else if (m && !g) network = "MABAC";
    else network = "GLITCHY";

    const aff = network === "MABAC" ? m : g;
    const clicks = network === "MABAC" ? aff?.clicks || 0 : aff?.clicks || 0;
    const conversions = network === "MABAC" ? aff?.conversions || 0 : aff?.conversions || 0;
    const payout = network === "MABAC" ? aff?.revenue || 0 : aff?.payout || 0;

    // TikTok-supplied metrics — not wired to real per-campaign values yet.
    const spend = 0;
    const cpm = 0;
    const cpa = 0;
    const roas = spend > 0 ? payout / spend : 0;
    const cpnc = clicks > 0 && spend > 0 ? spend / clicks : 0;

    const epc = clicks > 0 ? payout / clicks : 0;
    const profit = payout - spend;

    const budget = tk && tk.advertiser_id ? state.budgets[String(tk.advertiser_id)] || null : null;

    return {
      source: name,
      offer_name: g?.offer_name || null,
      network,
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
      hasMabac: !!m,
      campaignId: tk ? String(tk.campaign_id) : null,
      campaignOpStatus: tk ? tk.campaign_operation_status || null : null, // ENABLE / DISABLE
      advertiserId: tk ? String(tk.advertiser_id || "") : null,
      advertiserName: tk ? tk.advertiser_name || null : null,
      bcId: tk ? tk.bc_id || null : null,
      budget,
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
      <td class="toggle-cell">${campaignToggle(s)}</td>
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
      <td class="budget-cell">${budgetCell(s)}</td>
    `;
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "row-detail";
    detailTr.innerHTML = `<td colspan="12"><div class="row-detail-inner"><div class="adgroups-panel" data-adgroups-for="${escapeHtml(s.campaignId || "")}"></div></div></td>`;
    tbody.appendChild(detailTr);

    if (state.expandedSources.has(s.source)) {
      tr.classList.add("expanded");
      requestAnimationFrame(() => renderAdGroupsPanel(s));
    }
  });
}

// Compact ON/OFF switch for the campaign row. ON = campaign ENABLE, OFF =
// DISABLE. Only for rows backed by a tracked TikTok campaign. Clicking toggles
// the campaign via the same MCP action; it never expands the row.
function campaignToggle(s) {
  if (!s.hasTiktok || !s.campaignId) return "";
  const on = String(s.campaignOpStatus || "").toUpperCase() === "ENABLE";
  const pending = state.pendingActions.has(`c:${s.campaignId}`);
  return switchHtml({
    on,
    pending,
    attrs: `data-campaign-action="${on ? "DISABLE" : "ENABLE"}" data-campaign-id="${escapeHtml(s.campaignId)}"`,
    title: on ? "Campaign running — click to pause" : "Campaign paused — click to enable",
  });
}

// Shared toggle-switch markup (campaign rows + ad-group rows).
function switchHtml({ on, pending, attrs, title }) {
  return `<button type="button" role="switch" aria-checked="${on ? "true" : "false"}" title="${escapeHtml(title || "")}" class="tk-switch${on ? " on" : ""}${pending ? " busy" : ""}" ${pending ? "disabled" : ""} ${attrs}></button>`;
}

// ADVERTISER-ACCOUNT budget/spend-cap (NOT campaign CBO budget). Keyed by
// advertiser_id — one advertiser account can own several campaign rows.
function budgetCell(s) {
  if (!s.hasTiktok || !s.advertiserId) return "";
  const b = s.budget;
  const pending = state.pendingActions.has(`b:${s.advertiserId}`);
  if (!b) {
    return `<span class="bud-none" title="Budget info not loaded for this account">—</span>`;
  }
  const edit = `<button class="bud-edit" data-budget-edit="${escapeHtml(s.advertiserId)}" ${pending ? "disabled" : ""}>${pending ? "…" : b.capped ? "Edit" : "Set cap"}</button>`;
  if (b.capped) {
    const leftTone = b.remaining > 0 ? "ok" : "bad";
    return `
      <div class="bud" title="Spent ${money(b.spent)} of ${money(b.cap)}">
        <span class="bud-left ${leftTone}">${money(b.remaining)} left</span>
        <span class="bud-sub">of ${money(b.cap)} cap</span>
        ${edit}
      </div>`;
  }
  return `
    <div class="bud" title="No spend cap on this ad account">
      <span class="bud-left muted">Uncapped</span>
      <span class="bud-sub">bal ${money(b.account_balance)}</span>
      ${edit}
    </div>`;
}

// ---- Business Center view filter (Detailed Metrics header) ----

function trackedBcOptions() {
  const map = new Map();
  for (const c of state.tiktokCampaigns) {
    if (c && c.bc_id) map.set(String(c.bc_id), c.bc_name || `BC ${c.bc_id}`);
  }
  return [...map.entries()].map(([bc_id, bc_name]) => ({ bc_id, bc_name }));
}

function renderDetailBcSelector() {
  const wrap = document.getElementById("detailBcWrap");
  const select = document.getElementById("detailBcSelect");
  const opts = trackedBcOptions();

  // Only worth showing once ≥ 2 BCs contribute tracked campaigns.
  if (opts.length < 2) {
    wrap.hidden = true;
    if (state.detailBcFilter !== "all" && !opts.some((o) => o.bc_id === state.detailBcFilter)) {
      state.detailBcFilter = "all";
    }
    updateBcBalanceBanner();
    return;
  }

  if (!["all", ...opts.map((o) => o.bc_id)].includes(state.detailBcFilter)) {
    state.detailBcFilter = "all";
  }
  select.innerHTML =
    `<option value="all">All Business Centers</option>` +
    opts
      .map((o) => `<option value="${escapeHtml(o.bc_id)}" ${o.bc_id === state.detailBcFilter ? "selected" : ""}>${escapeHtml(o.bc_name)}</option>`)
      .join("");
  wrap.hidden = false;
  updateBcBalanceBanner();
}

function updateBcBalanceBanner() {
  const el = document.getElementById("detailBcBalance");
  const bcId = state.detailBcFilter;
  const bal = bcId !== "all" ? state.bcBalances[bcId] : null;
  if (!bal || bal.error || bal.balance == null) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="bcbal-label">Available Balance</span><span class="bcbal-value tabular">${money(bal.balance)}</span>`;
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
      <colgroup>
        <col style="width:44px" /><col style="width:92px" /><col /><col style="width:76px" /><col style="width:76px" />
      </colgroup>
      <thead>
        <tr><th>On/Off</th><th>Status</th><th>Ad group</th><th class="num">Spend</th><th class="num">CPA</th></tr>
      </thead>
      <tbody>
        ${rows.map((g) => adGroupRowHtml(s.campaignId, g)).join("")}
      </tbody>
    </table>`;
}

function adGroupRowHtml(campaignId, g) {
  const on = String(g.operation_status || "").toUpperCase() === "ENABLE";
  const pending = state.pendingActions.has(`g:${g.adgroup_id}`);
  const tone = ["good", "warn", "bad", "neutral"].includes(g.status_tone) ? g.status_tone : "neutral";
  return `
    <tr data-adgroup-row="${escapeHtml(g.adgroup_id)}">
      <td class="toggle-cell">${switchHtml({
        on,
        pending,
        attrs: `data-adgroup-action="${on ? "DISABLE" : "ENABLE"}" data-campaign-id="${escapeHtml(campaignId)}" data-adgroup-id="${escapeHtml(g.adgroup_id)}"`,
        title: on ? "Ad group running — click to pause" : "Ad group paused — click to unpause",
      })}</td>
      <td><span class="status-badge ${tone}">${escapeHtml(g.status_label || "—")}</span></td>
      <td class="ag-name-cell"><span class="ag-name">${escapeHtml(g.adgroup_name || g.adgroup_id)}</span></td>
      <td class="num">${money(g.spend)}</td>
      <td class="num">${money(g.cpa)}</td>
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
  if (state.pendingActions.has(key)) return; // double-click guard
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const result = await setCampaignStatus(campaignId, targetOp);
    state.pendingActions.delete(key);
    applyCampaignStatusResult(result);
    setStatus(`Campaign ${targetOp === "DISABLE" ? "paused" : "enabled"} — now “${result.effective_status}”.`);
  } catch (err) {
    state.pendingActions.delete(key);
    setStatus(`Campaign update failed: ${err.message}`, true);
    rebuildSources();
  }
}

async function handleAdgroupAction(btn) {
  const campaignId = btn.dataset.campaignId;
  const adgroupId = btn.dataset.adgroupId;
  const targetOp = btn.dataset.adgroupAction;
  const key = `g:${adgroupId}`;
  if (state.pendingActions.has(key)) return; // double-click guard
  state.pendingActions.add(key);
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const result = await setAdgroupStatus(campaignId, adgroupId, targetOp);
    state.pendingActions.delete(key);
    applyCampaignStatusResult(result); // repaints the panel + row from the live result
    setStatus(`Ad group ${targetOp === "DISABLE" ? "paused" : "unpaused"}.`);
  } catch (err) {
    state.pendingActions.delete(key);
    setStatus(`Ad group update failed: ${err.message}`, true);
    const s = state.sources.find((x) => x.campaignId === campaignId);
    if (s) renderAdGroupsPanel(s, { force: true });
  }
}

// ---- advertiser account spend-cap edit ----

let budgetModalAdvId = null;
const BUDGET_MODE_LABEL = {
  UNLIMITED: "Uncapped",
  MONTHLY_BUDGET: "Monthly",
  DAILY_BUDGET: "Daily",
  CUSTOM_BUDGET: "Custom",
};

function openBudgetModal(advertiserId) {
  const b = state.budgets[String(advertiserId)];
  budgetModalAdvId = String(advertiserId);
  const s = state.sources.find((x) => x.advertiserId === budgetModalAdvId);
  document.getElementById("budgetModalAcct").textContent =
    (s && s.advertiserName ? `${s.advertiserName} · ` : "") + `Ad account ${budgetModalAdvId}`;

  const cur = document.getElementById("budgetModalCurrent");
  if (b && b.capped) {
    cur.innerHTML = `
      <div><span>Current cap</span><strong>${money(b.cap)}</strong> <em>(${BUDGET_MODE_LABEL[b.budget_mode] || b.budget_mode})</em></div>
      <div><span>Spent</span><strong>${money(b.spent)}</strong></div>
      <div><span>Remaining</span><strong>${money(b.remaining)}</strong></div>`;
  } else {
    cur.innerHTML = `<div><span>Current</span><strong>Uncapped</strong></div>
      <div><span>Shared BC balance</span><strong>${b ? money(b.account_balance) : "—"}</strong></div>`;
  }

  document.getElementById("budgetModeSelect").value = b && b.capped ? b.budget_mode : "MONTHLY_BUDGET";
  document.getElementById("budgetAmountInput").value = b && b.capped ? String(b.cap) : "";
  document.getElementById("budgetModalError").textContent = "";
  syncBudgetAmountVisibility();
  document.getElementById("budgetModal").classList.add("open");
}

function closeBudgetModal() {
  document.getElementById("budgetModal").classList.remove("open");
  budgetModalAdvId = null;
}

function syncBudgetAmountVisibility() {
  const mode = document.getElementById("budgetModeSelect").value;
  document.getElementById("budgetAmountWrap").hidden = mode === "UNLIMITED";
}

async function submitBudgetEdit() {
  if (!budgetModalAdvId) return;
  const advId = budgetModalAdvId;
  const mode = document.getElementById("budgetModeSelect").value;
  const amount = Number(document.getElementById("budgetAmountInput").value);
  const errEl = document.getElementById("budgetModalError");
  errEl.textContent = "";

  if (mode !== "UNLIMITED" && !(amount > 0)) {
    errEl.textContent = "Enter a cap amount greater than 0.";
    return;
  }

  const btn = document.getElementById("confirmBudgetBtn");
  btn.disabled = true;
  btn.textContent = "Updating…";
  state.pendingActions.add(`b:${advId}`);
  rebuildSources();

  try {
    const res = await setAdvertiserBudget(advId, mode, mode === "UNLIMITED" ? 0 : amount);
    if (res.budget) state.budgets[advId] = { ...state.budgets[advId], ...res.budget };
    closeBudgetModal();
    setStatus(`Ad account cap updated — ${mode === "UNLIMITED" ? "uncapped" : money(amount) + " " + (BUDGET_MODE_LABEL[mode] || "")}.`);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Update";
    state.pendingActions.delete(`b:${advId}`);
    rebuildSources();
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

// connections: [{id,label,tiktok_email,tiktok_display_name,bc_id,bc_name,bc_count,...}]
// advertisers: [{connection_id,advertiser_id,...,tracked}]
// selectedConnectionId: which connection the management view shows (multi-BC only)
// trackedDraft: { "<connId>::<advId>": bool } — unsaved checkbox changes, survives
//               switching the BC dropdown until Save.
const tiktokState = { connections: [], advertisers: [], selectedConnectionId: null, trackedDraft: {} };
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
  document.getElementById("tiktokSyncCampaignsBtn").addEventListener("click", () => refreshTiktokData());
  document.getElementById("tiktokBcSelect").addEventListener("change", (e) => {
    tiktokState.selectedConnectionId = e.target.value;
    renderSelectedConnection();
  });

  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-tk-adv]');
    if (cb) {
      tiktokState.trackedDraft[`${cb.dataset.tkConnId}::${cb.dataset.tkAdvId}`] = cb.checked;
      updateSaveButton();
    }
  });
  wrap.addEventListener("click", (e) => {
    const refreshBtn = e.target.closest("[data-tk-refresh]");
    const disconnectBtn = e.target.closest("[data-tk-disconnect]");
    if (refreshBtn) rescanConnection(refreshBtn.dataset.tkRefresh, refreshBtn);
    if (disconnectBtn) disconnectConnection(disconnectBtn.dataset.tkDisconnect);
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

function updateSaveButton() {
  const n = Object.keys(tiktokState.trackedDraft).length;
  const btn = document.getElementById("tiktokSaveTrackedBtn");
  btn.disabled = n === 0;
  btn.textContent = n ? `Save tracked accounts (${n})` : "Save tracked accounts";
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

// A connection's Business Center identity for display. Real BC name from
// bc/get when known; never invented from advertiser names.
function connBcName(c) {
  return c.bc_name || c.tiktok_display_name || c.tiktok_email || "TikTok connection";
}
function connBcOptionLabel(c) {
  const primary = c.bc_name || (c.bc_count > 1 ? `${c.bc_count} Business Centers` : c.tiktok_display_name) || "Connection";
  return c.tiktok_email ? `${primary} — ${c.tiktok_email}` : primary;
}

function advsForConnection(connId) {
  return tiktokState.advertisers
    .filter((a) => a.connection_id === connId)
    .slice()
    .sort(
      (a, b) =>
        advApprovedRank(a) - advApprovedRank(b) ||
        String(a.advertiser_name || a.advertiser_id).localeCompare(String(b.advertiser_name || b.advertiser_id))
    );
}

function isAdvTracked(connId, adv) {
  const draft = tiktokState.trackedDraft[`${connId}::${adv.advertiser_id}`];
  return draft === undefined ? !!adv.tracked : draft;
}

async function renderTiktokAccounts() {
  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.innerHTML = `<p class="tk-loading">Loading connections…</p>`;

  let data;
  try {
    data = await fetchTiktokConnections();
  } catch (err) {
    wrap.innerHTML = `<p class="tk-error">Couldn't load connections: ${escapeHtml(err.message)}</p>`;
    return;
  }

  tiktokState.connections = data.connections || [];
  tiktokState.advertisers = data.advertisers || [];

  const ids = tiktokState.connections.map((c) => c.id);
  if (!ids.includes(tiktokState.selectedConnectionId)) {
    tiktokState.selectedConnectionId = ids[0] || null;
  }

  // BC / connection dropdown — only when there's more than one connection.
  const bcWrap = document.getElementById("tiktokBcSelectWrap");
  const bcSelect = document.getElementById("tiktokBcSelect");
  if (tiktokState.connections.length > 1) {
    bcSelect.innerHTML = tiktokState.connections
      .map((c) => `<option value="${c.id}" ${c.id === tiktokState.selectedConnectionId ? "selected" : ""}>${escapeHtml(connBcOptionLabel(c))}</option>`)
      .join("");
    bcWrap.hidden = false;
  } else {
    bcWrap.hidden = true;
  }

  renderSelectedConnection();
}

function renderSelectedConnection() {
  const wrap = document.getElementById("tiktokConnectionsWrap");
  const summaryEl = document.getElementById("tiktokSummary");

  if (!tiktokState.connections.length) {
    summaryEl.innerHTML = "";
    wrap.innerHTML = `<p class="tk-empty">No TikTok accounts connected yet. Click “Connect TikTok Ads” and authorize in this browser profile.</p>`;
    updateSaveButton();
    return;
  }

  const c =
    tiktokState.connections.find((x) => x.id === tiktokState.selectedConnectionId) || tiktokState.connections[0];
  const advs = advsForConnection(c.id);
  const approved = advs.filter((a) => advIsApproved(a)).length;

  summaryEl.innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;

  const bcIdLine = c.bc_id ? `<span class="tk-conn-bcid">BC ${escapeHtml(c.bc_id)}</span>` : "";
  const rows = advs.length
    ? advs.map((a) => tiktokAdvRow(c.id, a)).join("")
    : `<p class="tk-empty">No advertiser accounts found for this connection.</p>`;

  wrap.innerHTML = `
    <div class="tk-conn">
      <div class="tk-conn-head">
        <div>
          <div class="tk-conn-label">${escapeHtml(connBcName(c))}</div>
          <div class="tk-conn-sub">${escapeHtml(c.tiktok_email || c.tiktok_display_name || "")} ${bcIdLine}</div>
        </div>
        <div class="tk-conn-actions">
          <button class="tk-mini" data-tk-refresh="${c.id}">Re-scan</button>
          <button class="tk-mini danger" data-tk-disconnect="${c.id}">Disconnect</button>
        </div>
      </div>
      <div class="tk-adv-list">${rows}</div>
    </div>`;

  updateSaveButton();
}

function tiktokAdvRow(connectionId, a) {
  const meta = [a.advertiser_id, a.currency || null, a.display_timezone || a.timezone || null]
    .filter(Boolean)
    .join(" · ");
  const approved = advIsApproved(a);
  return `
    <label class="tk-adv">
      <input type="checkbox" data-tk-adv data-tk-adv-id="${escapeHtml(a.advertiser_id)}" data-tk-conn-id="${connectionId}" ${isAdvTracked(connectionId, a) ? "checked" : ""} />
      <span class="tk-adv-main">
        <span class="tk-adv-name">${escapeHtml(a.advertiser_name || a.advertiser_id)}</span>
        <span class="tk-adv-meta">${escapeHtml(meta)}</span>
      </span>
      <span class="tk-adv-status ${approved ? "ok" : "warn"}">${advStatusLabel(a)}</span>
    </label>`;
}

// ---- admin password (only for connect + disconnect) ----

function askTiktokPassword({ title, hint }) {
  return new Promise((resolve) => {
    tiktokPwHandler = resolve;
    document.getElementById("tiktokPwTitle").textContent = title || "Dashboard password";
    document.getElementById("tiktokPwHint").textContent = hint || "Enter the dashboard password to continue.";
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

// ---- actions ----

async function connectTiktok() {
  const password = await askTiktokPassword({
    title: "Connect TikTok Ads",
    hint: "Enter the dashboard password. You'll then be sent to TikTok to authorize this browser's logged-in Business account.",
  });
  if (!password) return;
  try {
    const { authorizeUrl } = await startTiktokAuth(password, "");
    if (!authorizeUrl) {
      setStatus("TikTok did not return an authorization URL.", true);
      return;
    }
    // Full-page redirect — survives AdsPower profiles / popup blockers.
    window.location.assign(authorizeUrl);
  } catch (err) {
    setStatus(`Couldn't start TikTok authentication: ${err.message}`, true);
  }
}

// Persists the unsaved checkbox draft (across ALL connections) then auto-syncs
// campaigns. No password.
async function saveTiktokTracked() {
  const selections = Object.entries(tiktokState.trackedDraft).map(([key, tracked]) => {
    const [connection_id, advertiser_id] = key.split("::");
    return { connection_id, advertiser_id, tracked };
  });
  if (!selections.length) return;

  const btn = document.getElementById("tiktokSaveTrackedBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await postTiktokAction({ action: "track", selections });
    tiktokState.trackedDraft = {};
    // Reflect the saved values locally so a re-render shows them ticked.
    for (const s of selections) {
      const a = tiktokState.advertisers.find(
        (x) => x.connection_id === s.connection_id && String(x.advertiser_id) === String(s.advertiser_id)
      );
      if (a) a.tracked = s.tracked;
    }
    const trackedCount = tiktokState.advertisers.filter((a) => a.tracked).length;
    setStatus(`Saved — tracking ${trackedCount} advertiser account(s). Syncing campaigns…`);
    renderSelectedConnection();
    await refreshTiktokData({ silent: true });
  } catch (err) {
    setStatus(`Couldn't save selection: ${err.message}`, true);
  } finally {
    btn.textContent = "Save tracked accounts";
    updateSaveButton();
  }
}

// "Refresh TikTok Data" — re-scan advertisers + re-discover campaigns for every
// tracked account, then re-merge the Detailed Metrics table. Manual fallback;
// not needed for normal operation. No password.
async function refreshTiktokData({ silent } = {}) {
  const btn = document.getElementById("tiktokSyncCampaignsBtn");
  const original = "Refresh TikTok Data";
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  if (!silent) setStatus("Refreshing TikTok data…");
  try {
    const r = await syncTiktokCampaigns();
    await loadTiktokCampaigns();
    loadTiktokBudgets();
    loadMabac();
    if (document.getElementById("accountsModal").classList.contains("open")) {
      await renderTiktokAccounts();
    }
    if (r.note) setStatus(r.note);
    else setStatus(`Refreshed — ${r.campaignCount ?? 0} campaign(s) across ${r.connections ?? 0} connection(s).`);
  } catch (err) {
    setStatus(`Refresh failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Set which affiliate network supplies this connection/BC's campaign earnings.
async function setConnectionAffiliateNetwork(connectionId, network, sel) {
  sel.disabled = true;
  try {
    await setConnectionNetwork(connectionId, network);
    const conn = tiktokState.connections.find((c) => c.id === connectionId);
    if (conn) conn.affiliate_network = network;
    for (const c of state.tiktokCampaigns) {
      if (String(c.connection_id) === String(connectionId)) c.affiliate_network = network;
    }
    rebuildSources();
    setStatus(`Business Center now uses ${network === "MABAC" ? "Mabac" : "Glitchy"} for earnings.`);
  } catch (err) {
    setStatus(`Couldn't change network: ${err.message}`, true);
    renderSelectedConnection(); // revert the select
  } finally {
    sel.disabled = false;
  }
}

// Re-scan ONE connection's advertiser accounts. No password.
async function rescanConnection(connectionId, btn) {
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    const r = await postTiktokAction({ action: "refresh", connection_id: connectionId });
    setStatus(`Re-scanned — ${r.advertiserCount ?? 0} advertiser account(s).`);
    await renderTiktokAccounts();
    loadTiktokBudgets();
  } catch (err) {
    setStatus(`Re-scan failed: ${err.message}`, true);
    btn.disabled = false;
    btn.textContent = "Re-scan";
  }
}

// Disconnect ONE connection — PASSWORD required.
async function disconnectConnection(connectionId) {
  const conn = tiktokState.connections.find((c) => c.id === connectionId);
  const password = await askTiktokPassword({
    title: "Disconnect TikTok connection",
    hint: `Enter the dashboard password to remove “${conn ? connBcName(conn) : "this connection"}” and its tracked accounts.`,
  });
  if (!password) return;
  try {
    await postTiktokAction({ password, action: "disconnect", connection_id: connectionId });
    if (tiktokState.selectedConnectionId === connectionId) tiktokState.selectedConnectionId = null;
    for (const k of Object.keys(tiktokState.trackedDraft)) {
      if (k.startsWith(`${connectionId}::`)) delete tiktokState.trackedDraft[k];
    }
    setStatus("TikTok connection removed.");
    await renderTiktokAccounts();
    await loadTiktokCampaigns();
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

  const newConnId = qp.get("connection");
  history.replaceState({}, "", window.location.pathname);

  if (kind === "connected") {
    if (newConnId) tiktokState.selectedConnectionId = newConnId; // focus the just-added BC
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
