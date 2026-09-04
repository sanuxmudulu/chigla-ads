import {
  fetchGlitchyStats,
  fetchMabacStats,
  fetchDailyTotals,
  loadCache,
  fetchTiktokConnections,
  startTiktokAuth,
  postTiktokAction,
  fetchTiktokCampaigns,
  fetchTiktokMetrics,
  syncTiktokCampaigns,
  fetchCampaignAdGroups,
  setCampaignStatus,
  setAdgroupStatus,
  fetchTiktokBudgets,
  setAdvertiserBudget,
  setConnectionNetwork,
  deleteTiktokCampaign,
  setCampaignPostUrl,
  queueEngagementComments,
  fetchEngagementOrders,
  listCommentTemplates,
  createCommentTemplate,
  updateCommentTemplate,
  deleteCommentTemplate,
  createWhWarmup,
  cleanupWhWarmup,
  fetchWhCountries,
  processCampaignCreatorDuplication,
  listCampaignTemplates,
  saveCampaignTemplate,
  deleteCampaignTemplate,
  campaignCreatorResources,
  runCampaignCreator,
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
const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;
const num = (n) => (n || 0).toLocaleString("en-US");
const signedMoney = (n) => `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`;
// Coerce anything (null / undefined / "" / NaN / Infinity) to a finite number.
const toNum = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
// a / b, but only when b > 0 and the result is finite — else 0. Kills every
// NaN / Infinity path in the derived metrics (CPNC, EPC, ROAS).
const ratio = (a, b) => {
  const r = toNum(a) / toNum(b);
  return toNum(b) > 0 && Number.isFinite(r) ? r : 0;
};

// Smooth ROAS → colour ramp for the ROAS cell. 0 red · 0.5 orange · 1 yellow ·
// 1.5 yellow-green · 2+ strong green (clamped, so 2x and 5x read the same). HSL
// so it interpolates cleanly; lightness kept high enough to stay readable on the
// dark themes.
function roasColor(roas) {
  const r = Math.max(0, Math.min(2, Number(roas) || 0));
  const stops = [
    [0, 0],
    [0.5, 25],
    [1, 55],
    [1.5, 92],
    [2, 142],
  ];
  let hue = 142;
  for (let i = 1; i < stops.length; i++) {
    if (r <= stops[i][0]) {
      const [x0, h0] = stops[i - 1];
      const [x1, h1] = stops[i];
      hue = h0 + ((h1 - h0) * (r - x0)) / (x1 - x0);
      break;
    }
  }
  return `hsl(${Math.round(hue)}, 85%, 62%)`;
}

const state = {
  sources: [],
  glitchyRows: [], // per-source rows from Glitchy (clicks/payout/conversions)
  mabacRows: [], // per-sub1 rows from Mabac (clicks/conversions/revenue)
  mabacConfigured: false,
  tiktokCampaigns: [], // rows from tiktok-campaigns (campaign_name == source)
  campaignMetrics: {}, // campaign_id -> { advertiser_id, spend, cpm, cpa, impressions, clicks, conversions } — today, NY date
  campaignMetricsDate: null, // NY date the metrics belong to
  campaignMetricsStale: false, // last metrics refresh had a partial/total failure
  spendToday: null, // { date, currentHour, cumulative, byHour } — Live Performance Spend series ONLY
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
let refreshInFlight = false; // guards refreshAll() against overlapping runs
let metricsInFlight = false; // guards loadTiktokMetrics() against overlapping runs
let whCleanupInFlight = false; // guards the WH Warmup cleanup poll
let ccDupeInFlight = false; // guards the Campaign-Creator duplication poll
let mainChartCanvas = null;
let openRowMenuFor = null; // campaignId whose ⋮ menu is open, or null
let rowMenuEl = null; // the floating menu element (appended to <body>)
let deleteCampaignTarget = null; // source row pending delete confirmation
let engagementTarget = null; // source row for the open engagement / comments modal
const ENGAGEMENT_SERVICE_ID_KEY = "chigla_engagement_service_id_v1";

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
// on an explicit "Refresh TikTok Data". Runs on load and on the 60s cycle so
// status changes (Active / Rejected / Appeal Under Review / Appeal Rejected)
// that the server derives in the background surface without a manual reload.
let campaignsInFlight = false;
async function loadTiktokCampaigns() {
  if (campaignsInFlight) return;
  campaignsInFlight = true;
  try {
    const data = await fetchTiktokCampaigns();
    state.tiktokCampaigns = data.campaigns || [];
    renderDetailBcSelector();
    rebuildSources();
  } catch (_) {
    /* non-fatal — table still renders from Glitchy data */
  } finally {
    campaignsInFlight = false;
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

// Today's live TikTok campaign metrics (spend / CPM / CPA) for every tracked
// advertiser account. Hits the MCP — runs on load and inside the 60s refresh
// cycle. Guarded so a slow request never overlaps the next tick.
async function loadTiktokMetrics() {
  if (metricsInFlight) return;
  metricsInFlight = true;
  try {
    const data = await fetchTiktokMetrics();
    applyTiktokMetrics(data);
  } catch (_) {
    // Total failure (e.g. function 500 / offline) — keep every last-known value,
    // just flag them as stale. Never zero out real numbers on a failed refresh.
    state.campaignMetricsStale = true;
  } finally {
    metricsInFlight = false;
  }
}

// WH Warmup auto-cleanup — deletes warmup campaigns once they reach Active.
// Piggybacks the existing ~60s refresh. Fire-and-forget, fully server-side,
// guarded against overlap. Nothing it does touches the Detailed Metrics table.
async function runWhWarmupCleanup() {
  if (whCleanupInFlight) return;
  whCleanupInFlight = true;
  try {
    await cleanupWhWarmup();
  } catch (_) {
    /* non-fatal — next cycle retries */
  } finally {
    whCleanupInFlight = false;
  }
}

// Campaign Creator — auto-duplicate the initial ad group once Active. Piggybacks
// the ~60s refresh, guarded. No-op while campaign_creator_campaigns is empty
// (nothing registers campaigns until the Campaign Creator tool is built).
async function runCampaignCreatorDuplication() {
  if (ccDupeInFlight) return;
  ccDupeInFlight = true;
  try {
    await processCampaignCreatorDuplication();
  } catch (_) {
    /* non-fatal — next cycle retries */
  } finally {
    ccDupeInFlight = false;
  }
}

// Merge a metrics snapshot into state. For advertiser accounts that reported OK
// this round we REPLACE their campaigns' metrics (so a campaign that genuinely
// spent $0 today, or is gone, drops to 0 rather than keeping a stale value).
// For advertiser accounts missing from `okAdvertiserIds` (their report failed)
// we KEEP the previous values — a failed request must not look like real $0.
function applyTiktokMetrics(data) {
  if (!data || typeof data !== "object") return;
  const fresh = data.metrics || {};
  const okAdv = new Set((data.okAdvertiserIds || []).map(String));

  // NY day rolled over since our cached metrics belong to → do NOT carry any
  // stale value into the new day, not even for advertisers whose report failed.
  const dayChanged = !!(data.date && state.campaignMetricsDate && data.date !== state.campaignMetricsDate);

  const merged = {};
  if (!dayChanged) {
    for (const [cid, m] of Object.entries(state.campaignMetrics)) {
      if (!okAdv.has(String(m && m.advertiser_id))) merged[cid] = m; // stale, but its account didn't refresh
    }
  }
  for (const [cid, m] of Object.entries(fresh)) merged[cid] = m;

  state.campaignMetrics = merged;
  state.campaignMetricsDate = data.date || null;
  state.campaignMetricsStale = !!(data.errors && Object.keys(data.errors).length);
  // Live Performance Spend series only — keep the last snapshot if this cycle
  // didn't return one (e.g. the spend-snapshot table isn't migrated yet).
  if (data.spendToday) state.spendToday = data.spendToday;
  rebuildSources();
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
  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll());

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
  wireWhWarmupEvents();
  wireCampaignCreatorEvents();

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

  // ---- ⋮ row menu: close on outside click / scroll / Escape ----
  document.addEventListener("click", (e) => {
    if (!openRowMenuFor) return;
    if (e.target.closest(".rowmenu") || e.target.closest("[data-row-menu]")) return;
    closeRowMenu();
  });
  window.addEventListener("scroll", () => closeRowMenu(), true);
  window.addEventListener("resize", () => closeRowMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRowMenu();
  });

  // ---- delete campaign modal ----
  document.getElementById("closeDeleteCampaignModal").addEventListener("click", closeDeleteCampaignModal);
  document.getElementById("cancelDeleteCampaignBtn").addEventListener("click", closeDeleteCampaignModal);
  document.getElementById("deleteCampaignModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteCampaignModal") closeDeleteCampaignModal();
  });
  document.getElementById("confirmDeleteCampaignBtn").addEventListener("click", confirmDeleteCampaign);

  // ---- engagement: Add comments modal (foundation) ----
  document.getElementById("closeEngagementCommentsModal").addEventListener("click", closeEngagementCommentsModal);
  document.getElementById("cancelEngagementCommentsBtn").addEventListener("click", closeEngagementCommentsModal);
  document.getElementById("engagementCommentsModal").addEventListener("click", (e) => {
    if (e.target.id === "engagementCommentsModal") closeEngagementCommentsModal();
  });
  document.getElementById("submitEngagementCommentsBtn").addEventListener("click", submitEngagementComments);
  wireCommentTemplateEvents();

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
    // Far-right ⋮ campaign action menu — must NOT toggle the row.
    const menuBtn = e.target.closest("[data-row-menu]");
    if (menuBtn) {
      e.stopPropagation();
      toggleRowMenu(menuBtn);
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

// One refresh cycle: Glitchy (primary affiliate) + Mabac (optional affiliate) +
// live TikTok campaign metrics. Runs on load and every 60s. Guarded so that if a
// cycle is still running when the interval fires, the new one is skipped rather
// than stacked.
async function refreshAll() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.classList.add("spinning");
  try {
    const today = todayStr();

    // Glitchy is the primary affiliate source and must not be blocked by Mabac
    // or TikTok. Fetch it first; the other two run alongside and never throw
    // out of here (each keeps its own last-known data on failure).
    let glitchyErr = null;
    const [g] = await Promise.allSettled([fetchGlitchyStats(today, today)]);
    if (g.status === "fulfilled") {
      applyGlitchyResponse(g.value, { flagNewConversions: state.hasFetchedOnce });
      state.hasFetchedOnce = true;
      lastUpdatedAt = Date.now();
    } else {
      glitchyErr = g.reason;
    }

    await Promise.allSettled([
      loadMabac(),
      loadTiktokMetrics(),
      loadTiktokCampaigns(),
      runWhWarmupCleanup(),
      runCampaignCreatorDuplication(),
    ]);

    if (glitchyErr) {
      setStatus(`Couldn't reach Glitchy: ${glitchyErr.message} — showing last known data.`, true);
    } else if (state.campaignMetricsStale) {
      setStatus("Some TikTok campaign metrics couldn't be refreshed — showing last known values for those.");
    } else {
      setStatus(null);
    }
  } finally {
    refreshBtn.classList.remove("spinning");
    refreshInFlight = false;
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

    // Affiliate-network figures (clicks / earnings) — from the ONE owning
    // network only, joined by name (Glitchy source == Mabac sub1 == campaign).
    const aff = network === "MABAC" ? m : g;
    const clicks = toNum(network === "MABAC" ? aff?.clicks : aff?.clicks);
    const conversions = toNum(network === "MABAC" ? aff?.conversions : aff?.conversions);
    const payout = toNum(network === "MABAC" ? aff?.revenue : aff?.payout);

    // TikTok-side campaign metrics for TODAY (NY date), matched by campaign_id —
    // NOT by name. Absent => genuinely no TikTok data for this campaign yet
    // (either untracked, or a tracked campaign with zero delivery so far), which
    // correctly reads as 0. state.campaignMetrics keeps last-known values when a
    // report request fails (see applyTiktokMetrics).
    const mx = tk && tk.campaign_id ? state.campaignMetrics[String(tk.campaign_id)] : null;
    const spend = mx ? toNum(mx.spend) : 0;
    const cpm = mx ? toNum(mx.cpm) : 0;
    const cpa = mx ? toNum(mx.cpa) : 0;
    const impressions = mx ? toNum(mx.impressions) : 0;

    // Derived — every division guarded (0 when the denominator is 0 / missing).
    const roas = ratio(payout, spend); // affiliate earnings ÷ TikTok spend
    const cpnc = ratio(spend, clicks); // TikTok spend ÷ affiliate clicks
    const epc = ratio(payout, clicks); // affiliate earnings ÷ affiliate clicks
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
      impressions,
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
      tiktokPostUrl: tk ? tk.tiktok_post_url || null : null,
      engagementStatus: tk ? tk.engagement_status || "PENDING" : null,
      isWhWarmup: tk ? !!tk.is_wh_warmup : false,
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
  // Totals over the currently displayed rows (respects the Business Center view
  // filter, same as the table). Overall ROAS is total ÷ total — NEVER an average
  // of the per-row ROAS values.
  const totalSpend = toNum(state.baseSpendTotal);
  const totalEarnings = toNum(state.baseEarningsTotal);
  const netProfit = totalEarnings - totalSpend;
  const roas = ratio(totalEarnings, totalSpend);

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
  closeRowMenu(); // any re-render invalidates the floating menu's anchor
  tbody.innerHTML = "";

  // Winners first: highest ROAS, then (tie-break) highest spend. Re-sorted on
  // every rebuild so the table re-orders itself as fresh metrics land.
  const sorted = [...state.sources].sort((a, b) => b.roas - a.roas || b.spend - a.spend);
  // Crown the single best-ROAS row — but only once at least one row has a real
  // (> 0) ROAS, so rows with no TikTok spend yet don't get an arbitrary crown.
  const bestRoas = sorted.reduce((best, s) => (s.roas > (best?.roas ?? 0) ? s : best), null);

  sorted.forEach((s) => {
    const tr = document.createElement("tr");
    tr.className = "source-row " + (s.profit >= 0 ? "profit-positive" : "profit-negative");
    // Premium winner highlight: golden border at 2x+, add an animated glow at 3x+.
    if (s.roas >= 3) tr.classList.add("roas-gold", "roas-fire");
    else if (s.roas >= 2) tr.classList.add("roas-gold");
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
      <td class="num roas-cell" style="color:${roasColor(s.roas)}">${s.roas.toFixed(2)}x</td>
      <td class="budget-cell">${budgetCell(s)}</td>
      <td class="row-action-cell">${actionMenuCell(s)}</td>
    `;
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "row-detail";
    detailTr.innerHTML = `<td colspan="13"><div class="row-detail-inner"><div class="adgroups-panel" data-adgroups-for="${escapeHtml(s.campaignId || "")}"></div></div></td>`;
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
  if (b.capped) {
    // remaining >= $3 green · >$1 and <$3 yellow · <=$1 red
    const rem = toNum(b.remaining);
    const leftTone = rem >= 3 ? "ok" : rem > 1 ? "warn" : "bad";
    return `
      <div class="bud${pending ? " busy" : ""}" title="Spent ${money(b.spent)} of ${money(b.cap)}">
        <span class="bud-left ${leftTone}">${money(b.remaining)} left</span>
        <span class="bud-sub">of ${money(b.cap)} cap</span>
      </div>`;
  }
  return `
    <div class="bud${pending ? " busy" : ""}" title="No spend cap on this ad account">
      <span class="bud-left muted">Uncapped</span>
      <span class="bud-sub">bal ${money(b.account_balance)}</span>
    </div>`;
}

// Far-right 3-dot menu trigger. Only for rows backed by a tracked TikTok
// campaign — the menu (Edit budget / Delete campaign) is built on open.
function actionMenuCell(s) {
  if (!s.hasTiktok || !s.campaignId) return "";
  const open = openRowMenuFor === String(s.campaignId);
  return `<button type="button" class="rowmenu-btn${open ? " active" : ""}" data-row-menu="${escapeHtml(s.campaignId)}" aria-label="Campaign actions" title="Campaign actions">⋮</button>`;
}

// ---- far-right ⋮ campaign action menu ----

function closeRowMenu() {
  openRowMenuFor = null;
  if (rowMenuEl) {
    rowMenuEl.remove();
    rowMenuEl = null;
  }
  document.querySelectorAll(".rowmenu-btn.active").forEach((b) => b.classList.remove("active"));
}

function toggleRowMenu(btn) {
  const campaignId = String(btn.dataset.rowMenu || "");
  if (openRowMenuFor === campaignId) {
    closeRowMenu();
    return;
  }
  closeRowMenu();

  const s = state.sources.find((x) => String(x.campaignId) === campaignId);
  if (!s) return;

  openRowMenuFor = campaignId;
  btn.classList.add("active");

  const menu = document.createElement("div");
  menu.className = "rowmenu";
  // WH Warmup campaigns appear in Detailed Metrics but never enter engagement.
  const addComments = s.isWhWarmup
    ? ""
    : `<button type="button" class="rowmenu-item" data-menu-action="add-comments">Add comments</button>`;
  menu.innerHTML = `
    <button type="button" class="rowmenu-item" data-menu-action="edit-budget">Edit budget</button>
    ${addComments}
    <button type="button" class="rowmenu-item danger" data-menu-action="delete-campaign">Delete campaign</button>`;
  document.body.appendChild(menu);
  rowMenuEl = menu;

  const r = btn.getBoundingClientRect();
  let left = r.right + window.scrollX - menu.offsetWidth;
  if (left < 8) left = 8;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${left}px`;

  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-menu-action]");
    if (!item) return;
    const act = item.dataset.menuAction;
    const src = state.sources.find((x) => String(x.campaignId) === campaignId);
    closeRowMenu();
    if (!src) return;
    if (act === "edit-budget") {
      if (src.advertiserId) openBudgetModal(src.advertiserId);
      else setStatus("No ad-account budget is available for this campaign.", true);
    } else if (act === "add-comments") {
      openEngagementCommentsModal(src);
    } else if (act === "delete-campaign") {
      openDeleteCampaignModal(src);
    }
  });
}

// ---- delete campaign (always confirmed first) ----

function openDeleteCampaignModal(s) {
  deleteCampaignTarget = s;
  document.getElementById("deleteCampaignName").textContent = s.source;
  document.getElementById("deleteCampaignError").textContent = "";
  const btn = document.getElementById("confirmDeleteCampaignBtn");
  btn.disabled = false;
  btn.textContent = "Delete Campaign";
  document.getElementById("deleteCampaignModal").classList.add("open");
}

function closeDeleteCampaignModal() {
  document.getElementById("deleteCampaignModal").classList.remove("open");
  deleteCampaignTarget = null;
}

async function confirmDeleteCampaign() {
  if (!deleteCampaignTarget) return;
  const s = deleteCampaignTarget;
  const btn = document.getElementById("confirmDeleteCampaignBtn");
  const errEl = document.getElementById("deleteCampaignError");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Deleting…";
  try {
    const res = await deleteTiktokCampaign(s.campaignId);
    // Remove locally right away — whether TikTok deleted it or we hid it, it
    // should leave the table now. A background reload confirms.
    state.tiktokCampaigns = state.tiktokCampaigns.filter((c) => String(c.campaign_id) !== String(s.campaignId));
    delete state.adGroupsByCampaign[s.campaignId];
    delete state.campaignMetrics[String(s.campaignId)];
    state.expandedSources.delete(s.source);
    renderDetailBcSelector();
    rebuildSources();
    closeDeleteCampaignModal();
    setStatus(
      res.message ||
        (res.outcome === "hidden"
          ? "Campaign hidden from Chigla Ads."
          : "Campaign deleted from TikTok."),
      false
    );
    loadTiktokCampaigns();
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Delete Campaign";
  }
}

// ---- engagement FOUNDATION: "Add comments" ----
// No external artificial-engagement / SMM service is ever contacted. This modal
// only stages a comment batch server-side (against the campaign's OWN stored
// tiktok_post_url) for a future APPROVED provider integration. There is no
// manual "attach URL" step — the URL comes from Campaign Creation Automation.

function currentEngagementCampaign() {
  if (!engagementTarget) return null;
  return state.sources.find((x) => String(x.campaignId) === String(engagementTarget)) || null;
}

// Global reusable comment templates (Supabase `comment_templates`). Never
// touched by any cleanup. Selecting one loads its comments into the textarea;
// the textarea stays freely editable for this one order.
const ecState = { templates: [], selectedId: null, confirmDeleteId: null, editId: null };

// THE shared comment-counting rule: one comment per non-empty trimmed line.
// Accepts a raw textarea string OR an array (stored template.comments). Blank
// and whitespace-only lines never count. Used by the live counter, the template
// list count, Save validation, and the selected-template comments sent to the
// order — so every surface agrees on the number.
function commentLines(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean);
}
function commentCountLabel(input) {
  const n = commentLines(input).length;
  return `${n} comment${n === 1 ? "" : "s"}`;
}

function wireCommentTemplateEvents() {
  document.getElementById("ecTplAddBtn").addEventListener("click", () => openTemplateForm(null));
  document.getElementById("ecTplCancelBtn").addEventListener("click", () => showEcView("main"));
  document.getElementById("ecTplSaveBtn").addEventListener("click", saveTemplateForm);

  const cInput = document.getElementById("ecTplCommentsInput");
  cInput.addEventListener("input", updateTemplateCommentCount);

  document.getElementById("ecTplList").addEventListener("click", (e) => {
    const sel = e.target.closest("[data-tpl-select]");
    if (sel) return selectTemplate(sel.dataset.tplSelect);
    const edit = e.target.closest("[data-tpl-edit]");
    if (edit) return openTemplateForm(edit.dataset.tplEdit);
    const del = e.target.closest("[data-tpl-del]");
    if (del) {
      ecState.confirmDeleteId = del.dataset.tplDel;
      renderTemplateList();
      return;
    }
    if (e.target.closest("[data-tpl-del-cancel]")) {
      ecState.confirmDeleteId = null;
      renderTemplateList();
      return;
    }
    const confirmDel = e.target.closest("[data-tpl-del-confirm]");
    if (confirmDel) confirmTemplateDelete(confirmDel.dataset.tplDelConfirm);
  });
}

function updateTemplateCommentCount() {
  const el = document.getElementById("ecTplCommentsCount");
  if (el) el.textContent = commentCountLabel(document.getElementById("ecTplCommentsInput").value);
}

function showEcView(which) {
  document.getElementById("ecMain").hidden = which !== "main";
  document.getElementById("ecTemplateForm").hidden = which !== "form";
  document.getElementById("engagementCommentsTitle").textContent =
    which === "form" ? (ecState.editId ? "Edit template" : "New template") : "Add comments";
}

async function loadCommentTemplates() {
  const listEl = document.getElementById("ecTplList");
  try {
    const data = await listCommentTemplates();
    ecState.templates = (data.templates || []).map((t) => ({
      ...t,
      comments: Array.isArray(t.comments) ? t.comments : [],
    }));
  } catch (_) {
    ecState.templates = [];
  }
  renderTemplateList();
  void listEl;
}

function renderTemplateList() {
  const el = document.getElementById("ecTplList");
  if (!ecState.templates.length) {
    el.innerHTML = `<div class="ec-tpl-empty">No templates yet — click + to create one.</div>`;
    return;
  }
  el.innerHTML = ecState.templates
    .map((t) => {
      const selected = String(ecState.selectedId) === String(t.id);
      const right =
        String(ecState.confirmDeleteId) === String(t.id)
          ? `<div class="ec-tpl-confirm">Can't be undone.
               <button type="button" data-tpl-del-confirm="${escapeHtml(t.id)}">Confirm</button>
               <button type="button" data-tpl-del-cancel title="Cancel">✕</button>
             </div>`
          : `<div class="ec-tpl-actions">
               <button type="button" data-tpl-edit="${escapeHtml(t.id)}" title="Edit">✎</button>
               <button type="button" data-tpl-del="${escapeHtml(t.id)}" title="Delete">🗑</button>
             </div>`;
      const label = `${t.name} — ${commentCountLabel(t.comments)}`;
      return `<div class="ec-tpl-row${selected ? " selected" : ""}" data-tpl-id="${escapeHtml(t.id)}">
        <button type="button" class="ec-tpl-name" data-tpl-select="${escapeHtml(t.id)}">${escapeHtml(label)}</button>
        ${right}
      </div>`;
    })
    .join("");
}

function selectTemplate(id) {
  const t = ecState.templates.find((x) => String(x.id) === String(id));
  if (!t) return;
  ecState.selectedId = String(id);
  ecState.confirmDeleteId = null;
  document.getElementById("engagementCommentsError").textContent = "";
  renderTemplateList();
}

function selectedTemplateComments() {
  const t = ecState.templates.find((x) => String(x.id) === String(ecState.selectedId));
  return t ? commentLines(t.comments) : [];
}

function openTemplateForm(id) {
  ecState.editId = id ? String(id) : null;
  const t = id ? ecState.templates.find((x) => String(x.id) === String(id)) : null;
  document.getElementById("ecTplFormTitle").textContent = id ? "Edit template" : "New template";
  document.getElementById("ecTplNameInput").value = t ? t.name : "";
  document.getElementById("ecTplCommentsInput").value = t ? commentLines(t.comments).join("\n") : "";
  document.getElementById("ecTplFormError").textContent = "";
  updateTemplateCommentCount();
  const btn = document.getElementById("ecTplSaveBtn");
  btn.disabled = false;
  btn.textContent = "Save";
  showEcView("form");
  document.getElementById("ecTplNameInput").focus();
}

async function saveTemplateForm() {
  const name = document.getElementById("ecTplNameInput").value.trim();
  const comments = commentLines(document.getElementById("ecTplCommentsInput").value);
  const errEl = document.getElementById("ecTplFormError");
  errEl.textContent = "";
  if (!name) return (errEl.textContent = "Enter a template name.");
  if (!comments.length) return (errEl.textContent = "Enter at least one comment (one per line).");

  const btn = document.getElementById("ecTplSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const res = ecState.editId
      ? await updateCommentTemplate(ecState.editId, name, comments)
      : await createCommentTemplate(name, comments);
    const saved = { ...res.template, comments: Array.isArray(res.template.comments) ? res.template.comments : comments };
    if (ecState.editId) {
      const i = ecState.templates.findIndex((x) => String(x.id) === String(ecState.editId));
      if (i >= 0) ecState.templates[i] = saved;
    } else {
      ecState.templates.push(saved);
    }
    ecState.templates.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // A just-created / just-edited template becomes the selected one.
    ecState.selectedId = String(saved.id);
    renderTemplateList();
    showEcView("main");
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function confirmTemplateDelete(id) {
  try {
    await deleteCommentTemplate(id);
  } catch (err) {
    setStatus(`Couldn't delete template: ${err.message}`, true);
    return;
  }
  ecState.templates = ecState.templates.filter((x) => String(x.id) !== String(id));
  if (String(ecState.selectedId) === String(id)) ecState.selectedId = null;
  ecState.confirmDeleteId = null;
  renderTemplateList();
}

// The TikTok Post URL is prefilled from the campaign's stored tiktok_post_url
// (Campaign Creation Automation will usually have set it), but stays editable.
// Editing it here saves back to the campaign's tiktok_post_url before staging.
// Exactly one saved template must be selected — there is no manual comments box.
function openEngagementCommentsModal(s) {
  if (!s || !s.campaignId) return;
  engagementTarget = String(s.campaignId);

  ecState.selectedId = null;
  ecState.confirmDeleteId = null;
  ecState.editId = null;
  showEcView("main");

  document.getElementById("engagementCommentsCampaignName").textContent = s.source;
  document.getElementById("engagementCommentsUrl").value = s.tiktokPostUrl || "";
  document.getElementById("engagementServiceIdInput").value = loadServiceId();
  const resultEl = document.getElementById("engagementCommentsResult");
  resultEl.textContent = "";
  resultEl.className = "eng-placeholder";
  document.getElementById("engagementCommentsError").textContent = "";

  const btn = document.getElementById("submitEngagementCommentsBtn");
  btn.disabled = false;
  btn.textContent = "Add comments";
  document.getElementById("engagementCommentsModal").classList.add("open");

  document.getElementById("ecTplList").innerHTML = `<div class="ec-tpl-empty">Loading templates…</div>`;
  loadCommentTemplates();
  loadEngagementOrders(String(s.campaignId));
}

// Shows what the Active-trigger auto-placed for this campaign (likes / saves)
// and any prior comment batch. Read-only.
async function loadEngagementOrders(campaignId) {
  const el = document.getElementById("ecAutoOrders");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
  let orders = [];
  try {
    const data = await fetchEngagementOrders(campaignId);
    orders = data.orders || [];
  } catch (_) {
    return;
  }
  if (engagementTarget !== String(campaignId)) return; // modal moved on
  if (!orders.length) return;

  const latest = {};
  for (const o of orders) if (!latest[o.kind]) latest[o.kind] = o; // orders come newest-first
  const tone = (s) => {
    const u = String(s || "").toUpperCase();
    if (["SUBMITTED", "COMPLETED"].includes(u) || /progress|complete|process/i.test(s)) return "ok";
    if (u === "FAILED" || /cancel|error/i.test(s)) return "bad";
    return "warn";
  };
  const rows = ["LIKES", "SAVES", "COMMENTS"]
    .filter((k) => latest[k])
    .map((k) => {
      const o = latest[k];
      const qty = o.quantity ? `${o.quantity} ` : "";
      const ref = o.provider_ref ? ` · #${escapeHtml(String(o.provider_ref))}` : "";
      const label = o.status === "SUBMITTED" ? "ordered" : (o.status || "").toLowerCase();
      return `<div class="ec-auto-row ${tone(o.status)}">${qty}${k.toLowerCase()} — ${escapeHtml(label)}${ref}</div>`;
    })
    .join("");
  el.innerHTML = rows;
  el.hidden = !rows;
}

function closeEngagementCommentsModal() {
  document.getElementById("engagementCommentsModal").classList.remove("open");
  engagementTarget = null;
  showEcView("main"); // never leave the modal parked on the template form
}

const DEFAULT_SERVICE_ID = "5824";
function loadServiceId() {
  try {
    return localStorage.getItem(ENGAGEMENT_SERVICE_ID_KEY) || DEFAULT_SERVICE_ID;
  } catch (_) {
    return DEFAULT_SERVICE_ID;
  }
}
function saveServiceId(v) {
  try {
    if (v) localStorage.setItem(ENGAGEMENT_SERVICE_ID_KEY, v);
  } catch (_) {}
}

async function submitEngagementComments() {
  const s = currentEngagementCampaign();
  if (!s) return;
  const errEl = document.getElementById("engagementCommentsError");
  const resultEl = document.getElementById("engagementCommentsResult");
  const btn = document.getElementById("submitEngagementCommentsBtn");
  errEl.textContent = "";
  resultEl.textContent = "";
  resultEl.className = "eng-placeholder";

  const url = document.getElementById("engagementCommentsUrl").value.trim();
  if (!url) {
    errEl.textContent = "Enter the TikTok post URL for this campaign.";
    return;
  }
  const serviceId = document.getElementById("engagementServiceIdInput").value.trim();
  if (!serviceId) {
    errEl.textContent = "Enter a Service ID.";
    return;
  }
  if (!ecState.selectedId) {
    errEl.textContent = "Select a comment template.";
    return;
  }
  const lines = selectedTemplateComments();
  if (!lines.length) {
    errEl.textContent = "That template has no comments — edit it first.";
    return;
  }

  saveServiceId(serviceId);
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    // If the URL was edited (or the campaign had none), persist it to the
    // campaign's tiktok_post_url first so the rest of the app stays in sync.
    if (url !== (s.tiktokPostUrl || "")) {
      const r = await setCampaignPostUrl(s.campaignId, url);
      const tk = state.tiktokCampaigns.find((c) => String(c.campaign_id) === String(s.campaignId));
      if (tk) tk.tiktok_post_url = r.tiktok_post_url ?? url;
      rebuildSources();
    }
    const res = await queueEngagementComments(s.campaignId, serviceId, lines);
    resultEl.classList.add("ok");
    resultEl.textContent =
      res.message ||
      `${res.count || lines.length} comment(s) staged for campaign “${s.source}”. Ready for an approved provider integration — nothing was sent.`;
    btn.textContent = "Done";
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Add comments";
  }
}

// ============================== WH WARMUP ==============================
// Bulk temporary Traffic-CBO warmup campaigns that auto-delete once Active.
// Reuses the TikTok connection/advertiser data already fetched for the TikTok
// Ads modal (tiktokState). All creation + cleanup is server-side.

const whState = {
  connectionId: null,
  selected: new Set(), // advertiser_ids chosen on step 1
  step: 1,
  countries: [], // [{ location_id, name, code }] — from TikTok for the picked advertiser
  countriesForAdv: null, // advertiser_id the country list was fetched for
  countryLoading: false,
  selectedCountry: null, // { location_id, name } — a confirmed pick; required to create
  suggestActive: -1, // keyboard-highlighted suggestion index
};

function wireWhWarmupEvents() {
  document.getElementById("toolsWhWarmupBtn").addEventListener("click", openWhWarmupModal);
  document.getElementById("closeWhWarmupModal").addEventListener("click", closeWhWarmupModal);
  document.getElementById("whWarmupModal").addEventListener("click", (e) => {
    if (e.target.id === "whWarmupModal") closeWhWarmupModal();
  });
  document.getElementById("whCancelBtn1").addEventListener("click", closeWhWarmupModal);
  document.getElementById("whCancelBtn2").addEventListener("click", closeWhWarmupModal);
  document.getElementById("whDoneBtn").addEventListener("click", closeWhWarmupModal);
  document.getElementById("whBackBtn").addEventListener("click", () => whGoToStep(1));
  document.getElementById("whNextBtn").addEventListener("click", () => whGoToStep(2));
  document.getElementById("whCreateBtn").addEventListener("click", submitWhWarmup);

  document.getElementById("whBcSelect").addEventListener("change", (e) => {
    whState.connectionId = e.target.value;
    whState.selected.clear();
    renderWhAdvertisers();
  });
  document.getElementById("whSelectAll").addEventListener("change", (e) => {
    const approved = whAdvsForConnection().filter((a) => advIsApproved(a));
    if (e.target.checked) approved.forEach((a) => whState.selected.add(String(a.advertiser_id)));
    else approved.forEach((a) => whState.selected.delete(String(a.advertiser_id)));
    renderWhAdvertisers();
  });
  document.getElementById("whAdvList").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-wh-adv]');
    if (!cb) return;
    const id = String(cb.dataset.whAdv);
    if (cb.checked) whState.selected.add(id);
    else whState.selected.delete(id);
    syncWhSelectAll();
    updateWhNextButton();
  });

  // ---- Target country autocomplete ----
  const cIn = document.getElementById("whCountryInput");
  cIn.addEventListener("input", () => {
    // Any keystroke invalidates a previous pick — a valid suggestion must be chosen.
    whState.selectedCountry = null;
    document.getElementById("whCountryOk").textContent = "";
    renderCountrySuggest(cIn.value);
  });
  cIn.addEventListener("focus", () => renderCountrySuggest(cIn.value));
  cIn.addEventListener("keydown", (e) => {
    const box = document.getElementById("whCountrySuggest");
    if (box.hidden) return;
    const opts = [...box.querySelectorAll("button")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      whState.suggestActive = Math.max(0, Math.min(opts.length - 1, whState.suggestActive + (e.key === "ArrowDown" ? 1 : -1)));
      opts.forEach((o, i) => o.classList.toggle("active", i === whState.suggestActive));
    } else if (e.key === "Enter" && opts[whState.suggestActive]) {
      e.preventDefault();
      pickCountry(opts[whState.suggestActive].dataset.locId, opts[whState.suggestActive].dataset.name);
    } else if (e.key === "Escape") {
      hideCountrySuggest();
    }
  });
  cIn.addEventListener("blur", () => setTimeout(hideCountrySuggest, 150)); // let a click land first
  document.getElementById("whCountrySuggest").addEventListener("mousedown", (e) => {
    const b = e.target.closest("button[data-loc-id]");
    if (b) {
      e.preventDefault();
      pickCountry(b.dataset.locId, b.dataset.name);
    }
  });
}

function hideCountrySuggest() {
  const box = document.getElementById("whCountrySuggest");
  box.hidden = true;
  box.innerHTML = "";
  whState.suggestActive = -1;
}

function renderCountrySuggest(query) {
  const box = document.getElementById("whCountrySuggest");
  whState.suggestActive = -1;

  if (whState.countryLoading) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">Loading countries…</div>`;
    return;
  }
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    hideCountrySuggest();
    return;
  }
  if (!whState.countries.length) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">No country list — pick an account first.</div>`;
    return;
  }

  const starts = [];
  const contains = [];
  for (const c of whState.countries) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q) || c.code.toLowerCase() === q) starts.push(c);
    else if (n.includes(q)) contains.push(c);
  }
  const hits = [...starts, ...contains].slice(0, 8);
  if (!hits.length) {
    box.hidden = false;
    box.innerHTML = `<div class="wh-country-none">No TikTok country matches “${escapeHtml(query)}”.</div>`;
    return;
  }
  box.hidden = false;
  box.innerHTML = hits
    .map(
      (c) =>
        `<button type="button" data-loc-id="${escapeHtml(c.location_id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
}

function pickCountry(locationId, name) {
  whState.selectedCountry = { location_id: String(locationId), name: String(name) };
  document.getElementById("whCountryInput").value = name;
  document.getElementById("whCountryOk").textContent = `✓ ${name}`;
  hideCountrySuggest();
}

async function loadWhCountries(advertiserId) {
  if (!advertiserId) return;
  if (whState.countriesForAdv === advertiserId && whState.countries.length) return; // cached for this advertiser
  whState.countryLoading = true;
  whState.countries = [];
  whState.countriesForAdv = advertiserId;
  renderCountrySuggest(document.getElementById("whCountryInput").value);
  try {
    const data = await fetchWhCountries(whState.connectionId, advertiserId);
    whState.countries = data.countries || [];
  } catch (_) {
    whState.countries = [];
  } finally {
    whState.countryLoading = false;
    renderCountrySuggest(document.getElementById("whCountryInput").value);
  }
}

function whAdvsForConnection() {
  return tiktokState.advertisers
    .filter((a) => a.connection_id === whState.connectionId)
    .slice()
    .sort(
      (a, b) =>
        advApprovedRank(a) - advApprovedRank(b) ||
        String(a.advertiser_name || a.advertiser_id).localeCompare(String(b.advertiser_name || b.advertiser_id))
    );
}

async function openWhWarmupModal() {
  closeToolsDrawer();
  whState.selected.clear();
  whState.step = 1;
  whState.countries = [];
  whState.countriesForAdv = null;
  whState.selectedCountry = null;
  document.getElementById("whCountryInput").value = "";
  document.getElementById("whCountryOk").textContent = "";
  document.getElementById("whSparkInput").value = "";
  document.getElementById("whWarmupModal").classList.add("open");
  whGoToStep(1);
  document.getElementById("whAdvList").innerHTML = `<p class="tk-loading">Loading accounts…</p>`;
  document.getElementById("whStep1Error").textContent = "";

  try {
    const data = await fetchTiktokConnections();
    tiktokState.connections = data.connections || [];
    tiktokState.advertisers = data.advertisers || [];
  } catch (err) {
    document.getElementById("whAdvList").innerHTML = `<p class="tk-error">Couldn't load connections: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const sel = document.getElementById("whBcSelect");
  if (!tiktokState.connections.length) {
    sel.innerHTML = "";
    document.getElementById("whAdvList").innerHTML = `<p class="tk-empty">No TikTok Business Centers connected. Add one under Tools → TikTok Ads first.</p>`;
    document.getElementById("whSummary").innerHTML = "";
    return;
  }
  sel.innerHTML = tiktokState.connections
    .map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`)
    .join("");
  whState.connectionId = tiktokState.connections[0].id;
  sel.value = whState.connectionId;
  renderWhAdvertisers();
}

function closeWhWarmupModal() {
  document.getElementById("whWarmupModal").classList.remove("open");
}

function whGoToStep(n) {
  whState.step = n;
  document.getElementById("whStep1").hidden = n !== 1;
  document.getElementById("whStep2").hidden = n !== 2;
  document.getElementById("whStep3").hidden = n !== 3;
  if (n === 1) {
    // Re-picking accounts invalidates the country list (it's per-advertiser).
    whState.selectedCountry = null;
    document.getElementById("whCountryOk").textContent = "";
  }
  document.getElementById("whWarmupTitle").textContent =
    n === 1 ? "WH Warmup — accounts" : n === 2 ? "WH Warmup — settings" : "WH Warmup — results";
  if (n === 2) {
    const count = whState.selected.size;
    document.getElementById("whSelCount").innerHTML = `Creating for <strong>${count}</strong> Approved account${count === 1 ? "" : "s"}.`;
    document.getElementById("whStep2Error").textContent = "";
    document.getElementById("whCreateProgress").textContent = "";
    document.getElementById("whCreateProgress").className = "eng-placeholder";
    const btn = document.getElementById("whCreateBtn");
    btn.disabled = false;
    btn.textContent = "Create WH Warmup";
    // Country list comes from ONE selected advertiser's own valid TikTok regions.
    loadWhCountries([...whState.selected][0] || null);
  }
}

function renderWhAdvertisers() {
  const advs = whAdvsForConnection();
  const approved = advs.filter((a) => advIsApproved(a)).length;
  document.getElementById("whSummary").innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;

  const wrap = document.getElementById("whAdvList");
  wrap.innerHTML = advs.length
    ? advs.map((a) => whAdvRow(a)).join("")
    : `<p class="tk-empty">No advertiser accounts under this Business Center.</p>`;

  syncWhSelectAll();
  updateWhNextButton();
}

function whAdvRow(a) {
  const ok = advIsApproved(a);
  const id = String(a.advertiser_id);
  const meta = [id, a.currency || null, a.display_timezone || a.timezone || null].filter(Boolean).join(" · ");
  return `
    <label class="tk-adv${ok ? "" : " disabled"}" title="${ok ? "" : "Suspended accounts can't be used — campaign creation would fail."}">
      <input type="checkbox" data-wh-adv="${escapeHtml(id)}" ${whState.selected.has(id) ? "checked" : ""} ${ok ? "" : "disabled"} />
      <span class="tk-adv-main">
        <span class="tk-adv-name">${escapeHtml(a.advertiser_name || id)}</span>
        <span class="tk-adv-meta">${escapeHtml(meta)}</span>
      </span>
      <span class="tk-adv-status ${ok ? "ok" : "warn"}">${ok ? "Approved" : "Suspended"}</span>
    </label>`;
}

function syncWhSelectAll() {
  const approved = whAdvsForConnection().filter((a) => advIsApproved(a));
  const all = approved.length > 0 && approved.every((a) => whState.selected.has(String(a.advertiser_id)));
  const cb = document.getElementById("whSelectAll");
  cb.checked = all;
  cb.disabled = approved.length === 0;
}

function updateWhNextButton() {
  document.getElementById("whNextBtn").disabled = whState.selected.size === 0;
}

async function submitWhWarmup() {
  const typed = document.getElementById("whCountryInput").value.trim();
  const spark = document.getElementById("whSparkInput").value.trim();
  const errEl = document.getElementById("whStep2Error");
  const progressEl = document.getElementById("whCreateProgress");
  const btn = document.getElementById("whCreateBtn");
  errEl.textContent = "";

  const picked = whState.selectedCountry;
  if (!picked || picked.name.toLowerCase() !== typed.toLowerCase()) {
    return (errEl.textContent = "Pick a target country from the suggestions.");
  }
  if (!spark) return (errEl.textContent = "Enter a Spark code.");
  const ids = [...whState.selected];
  if (!ids.length) return whGoToStep(1);

  btn.disabled = true;
  btn.textContent = "Creating…";
  progressEl.className = "eng-placeholder busy";
  progressEl.textContent = `Creating ${ids.length} warmup campaign${ids.length === 1 ? "" : "s"}… this can take a minute.`;

  try {
    const res = await createWhWarmup(whState.connectionId, ids, picked.name, spark, picked.location_id);
    renderWhResults(res.results || [], res.warning);
    whGoToStep(3);
    // Kick a cleanup pass so newly-Active ones start deleting promptly.
    runWhWarmupCleanup();
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Create WH Warmup";
    progressEl.textContent = "";
    progressEl.className = "eng-placeholder";
  }
}

function renderWhResults(results, warning) {
  const el = document.getElementById("whResults");
  const tone = (s) => (s === "Created" ? "ok" : s === "Skipped" ? "warn" : "bad");
  el.innerHTML =
    (warning ? `<div class="wh-result-row bad"><span class="wh-r-detail">${escapeHtml(warning)}</span></div>` : "") +
    (results.length
      ? results
          .map(
            (r) => `
      <div class="wh-result-row ${tone(r.status)}">
        <span class="wh-r-name">${escapeHtml(r.advertiser_name || r.advertiser_id)}</span>
        <span class="wh-r-status">${escapeHtml(r.status)}${r.error ? ` <span class="wh-r-detail">— ${escapeHtml(r.error)}</span>` : ""}</span>
      </div>`
          )
          .join("")
      : `<p class="tk-empty">No accounts processed.</p>`);
}

// ============================== CAMPAIGN CREATOR ==============================
// Template-based launches. Templates hold reusable settings only; per-launch
// values are collected in the runtime wizard. Creation + registration is 100%
// server-side (campaign-creator-run.js). Reuses the WH account selector, the
// country autocomplete, and the existing duplication/appeal monitoring.

const CC_AGE_OPTS = [
  { v: "AGE_18_24", l: "18–24" },
  { v: "AGE_25_34", l: "25–34" },
  { v: "AGE_35_44", l: "35–44" },
  { v: "AGE_45_54", l: "45–54" },
  { v: "AGE_55_100", l: "55+" },
];
const CC_CTA_OPTS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "DOWNLOAD_NOW", "INSTALL_NOW", "PLAY_GAME",
  "ORDER_NOW", "CONTACT_US", "BOOK_NOW", "APPLY_NOW", "GET_QUOTE", "READ_MORE", "VIEW_NOW", "SUBSCRIBE",
];
const ccCtaLabel = (v) => v.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");

const ccState = {
  view: "home", // home | tpl | run
  templates: [],
  loaded: false,
  tpl: {
    id: null,
    step: 1,
    name: "",
    type: "LEAD_GENERATION",
    cbo: true,
    budget: "",
    locations: [], // [{ id, name }]
    ages: new Set(CC_AGE_OPTS.map((o) => o.v)),
    gender: "GENDER_UNLIMITED",
    cta: "LEARN_MORE",
    text: "",
    cardEnabled: false,
    cardUrl: "",
    countries: [],
    countriesLoading: false,
    suggestActive: -1,
  },
  run: {
    template: null,
    connectionId: null,
    selected: new Set(),
    step: 1,
    base: "",
    hour: 8,
    minute: 0,
    spark: "",
    links: "",
    resources: null,
    resLoading: false,
    identityId: "__AUTO__",
    identityType: "AUTO",
    formId: "", // Instant Form page_id (dropdown or manual)
    formLabel: "", // display name for review
    salesEvent: "",
  },
  minimized: false, // true = modal hidden but the draft is kept for resume
};

function wireCampaignCreatorEvents() {
  document.getElementById("toolsCampaignCreatorBtn").addEventListener("click", openCampaignCreatorModal);
  // X and backdrop MINIMIZE (keep the draft) — Cancel is the explicit discard.
  document.getElementById("closeCampaignCreatorModal").addEventListener("click", minimizeCampaignCreator);
  const minBtn = document.getElementById("ccMinimizeModal");
  if (minBtn) minBtn.addEventListener("click", minimizeCampaignCreator);
  document.getElementById("campaignCreatorModal").addEventListener("click", (e) => {
    if (e.target.id === "campaignCreatorModal") minimizeCampaignCreator();
  });

  // Home
  document.getElementById("ccNewTemplateBtn").addEventListener("click", () => openTplWizard(null));
  document.getElementById("ccTemplateList").addEventListener("click", onCcTemplateListClick);

  // Template wizard nav — Cancel discards the template draft.
  const closeToHome = () => { ccResetTplDraft(); ccShowView("home"); };
  document.getElementById("ccTplCancel1").addEventListener("click", closeToHome);
  document.getElementById("ccTplCancel2").addEventListener("click", closeToHome);
  document.getElementById("ccTplCancel3").addEventListener("click", closeToHome);
  document.getElementById("ccTplNext1").addEventListener("click", () => tplGoStep(2));
  document.getElementById("ccTplNext2").addEventListener("click", () => tplGoStep(3));
  document.getElementById("ccTplBack2").addEventListener("click", () => tplGoStep(1));
  document.getElementById("ccTplBack3").addEventListener("click", () => tplGoStep(2));
  document.getElementById("ccTplSave").addEventListener("click", saveTplWizard);

  document.getElementById("ccTplType").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    ccState.tpl.type = b.dataset.type;
    syncTplTypeToggle();
  });
  document.getElementById("ccTplCard").addEventListener("change", (e) => {
    ccState.tpl.cardEnabled = e.target.checked;
    document.getElementById("ccTplCardWrap").hidden = !e.target.checked;
  });
  document.getElementById("ccTplAge").addEventListener("click", (e) => {
    const chip = e.target.closest(".cc-chip[data-age]");
    if (!chip) return;
    const v = chip.dataset.age;
    if (ccState.tpl.ages.has(v)) ccState.tpl.ages.delete(v);
    else ccState.tpl.ages.add(v);
    renderTplAgeChips();
  });
  document.getElementById("ccTplLocChips").addEventListener("click", (e) => {
    const x = e.target.closest("[data-loc-remove]");
    if (!x) return;
    ccState.tpl.locations = ccState.tpl.locations.filter((l) => l.id !== x.dataset.locRemove);
    renderTplLocChips();
  });

  // Template location autocomplete (reuses the WH country list endpoint)
  const li = document.getElementById("ccTplLocInput");
  li.addEventListener("input", () => renderTplLocSuggest(li.value));
  li.addEventListener("focus", () => renderTplLocSuggest(li.value));
  li.addEventListener("blur", () => setTimeout(() => (document.getElementById("ccTplLocSuggest").hidden = true), 150));
  document.getElementById("ccTplLocSuggest").addEventListener("mousedown", (e) => {
    const b = e.target.closest("button[data-loc-id]");
    if (!b) return;
    e.preventDefault();
    if (!ccState.tpl.locations.some((l) => l.id === b.dataset.locId)) {
      ccState.tpl.locations.push({ id: b.dataset.locId, name: b.dataset.name });
    }
    li.value = "";
    document.getElementById("ccTplLocSuggest").hidden = true;
    renderTplLocChips();
  });

  // Runtime wizard nav — Cancel discards the run draft.
  const runCancel = () => { ccResetRunDraft(); ccShowView("home"); };
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const c = document.getElementById(`ccRunCancel${n}`);
    if (c) c.addEventListener("click", runCancel);
    const b = document.getElementById(`ccRunBack${n}`);
    if (b) b.addEventListener("click", () => runGoStep(n - 1));
  }
  document.getElementById("ccRunNext1").addEventListener("click", () => runGoStep(2));
  document.getElementById("ccRunNext2").addEventListener("click", () => runGoStep(3));
  document.getElementById("ccRunNext3").addEventListener("click", () => runGoStep(4));
  document.getElementById("ccRunNext4").addEventListener("click", () => runGoStep(5));
  document.getElementById("ccRunNext5").addEventListener("click", () => runGoStep(6));
  document.getElementById("ccRunCreate").addEventListener("click", submitCampaignCreator);
  document.getElementById("ccRunDone").addEventListener("click", () => { ccResetRunDraft(); closeCampaignCreatorModal(); });

  document.getElementById("ccRunBcSelect").addEventListener("change", (e) => {
    ccState.run.connectionId = e.target.value;
    ccState.run.selected.clear();
    renderCcRunAdvertisers();
  });
  document.getElementById("ccRunSelectAll").addEventListener("change", (e) => {
    const approved = ccRunAdvs().filter((a) => advIsApproved(a));
    if (e.target.checked) approved.forEach((a) => ccState.run.selected.add(String(a.advertiser_id)));
    else approved.forEach((a) => ccState.run.selected.delete(String(a.advertiser_id)));
    renderCcRunAdvertisers();
  });
  document.getElementById("ccRunAdvList").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-cc-adv]');
    if (!cb) return;
    const id = String(cb.dataset.ccAdv);
    if (cb.checked) ccState.run.selected.add(id);
    else ccState.run.selected.delete(id);
    document.getElementById("ccRunNext1").disabled = ccState.run.selected.size === 0;
    syncCcRunSelectAll();
  });
  document.getElementById("ccRunBase").addEventListener("input", (e) => {
    ccState.run.base = e.target.value;
    renderCcNamePreview();
  });
  document.getElementById("ccRunHour").addEventListener("change", (e) => { ccState.run.hour = +e.target.value; renderCcTzList(); });
  document.getElementById("ccRunMinute").addEventListener("change", (e) => { ccState.run.minute = +e.target.value; renderCcTzList(); });
  document.getElementById("ccRunSpark").addEventListener("input", (e) => { ccState.run.spark = e.target.value; renderCcSparkCounts(); });
  document.getElementById("ccRunLinks").addEventListener("input", (e) => { ccState.run.links = e.target.value; renderCcSparkCounts(); });
  document.getElementById("ccRunIdentity").addEventListener("change", (e) => {
    ccState.run.identityId = e.target.value;
    ccState.run.identityType = e.target.selectedOptions[0]?.dataset.type || "AUTO";
    syncCcRunNext5();
  });
  document.getElementById("ccRunForm").addEventListener("change", (e) => {
    if (document.getElementById("ccRunFormId").value.trim()) return; // manual id wins
    ccState.run.formId = e.target.value;
    ccState.run.formLabel = e.target.selectedOptions[0]?.textContent || e.target.value;
    syncCcRunNext5();
  });
  document.getElementById("ccRunFormId").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    if (v) {
      ccState.run.formId = v;
      ccState.run.formLabel = `Form ID ${v}`;
    } else {
      const fs = document.getElementById("ccRunForm");
      ccState.run.formId = fs.value || "";
      ccState.run.formLabel = fs.selectedOptions[0]?.textContent || fs.value || "";
    }
    syncCcRunNext5();
  });
  document.getElementById("ccRunEvent").addEventListener("change", (e) => { ccState.run.salesEvent = e.target.value; syncCcRunNext5(); });

  // hour / minute options
  const hs = document.getElementById("ccRunHour");
  const ms = document.getElementById("ccRunMinute");
  hs.innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}</option>`).join("");
  ms.innerHTML = Array.from({ length: 60 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}</option>`).join("");
  hs.value = "8";
  ms.value = "0";

  // CTA options
  document.getElementById("ccTplCta").innerHTML = CC_CTA_OPTS.map((v) => `<option value="${v}">${ccCtaLabel(v)}</option>`).join("");
}

// ---- modal / view plumbing ----

// Reopen: if the user minimized mid-flow, resume exactly where they were.
async function openCampaignCreatorModal() {
  closeToolsDrawer();
  document.getElementById("campaignCreatorModal").classList.add("open");

  if (ccState.minimized) {
    ccState.minimized = false;
    ccRestoreDom();
    return;
  }

  ccShowView("home");
  document.getElementById("ccTemplateList").innerHTML = `<p class="cc-empty">Loading templates…</p>`;
  try {
    const [tpls, conns] = await Promise.all([
      listCampaignTemplates(),
      fetchTiktokConnections(),
    ]);
    ccState.templates = tpls.templates || [];
    tiktokState.connections = conns.connections || [];
    tiktokState.advertisers = conns.advertisers || [];
    ccState.loaded = true;
  } catch (err) {
    document.getElementById("ccTemplateList").innerHTML = `<p class="tk-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderCcTemplateList();
}

function closeCampaignCreatorModal() {
  document.getElementById("campaignCreatorModal").classList.remove("open");
}

// Minimize — hide the modal but keep the full draft (step, template, accounts,
// name, schedule, spark codes, post links, identity, form, template inputs).
// Session only; reopening from Tools resumes it.
function minimizeCampaignCreator() {
  if (ccState.view !== "home") {
    ccSnapshotDom();
    ccState.minimized = true;
  }
  document.getElementById("campaignCreatorModal").classList.remove("open");
}

function ccResetRunDraft() {
  ccState.minimized = false;
  ccState.run = {
    template: null, connectionId: null, selected: new Set(), step: 1, base: "",
    hour: 8, minute: 0, spark: "", links: "", resources: null, resLoading: false,
    identityId: "__AUTO__", identityType: "AUTO", formId: "", formLabel: "", salesEvent: "",
  };
}
function ccResetTplDraft() {
  ccState.minimized = false;
  ccState.tpl.id = null;
}

// Read every live input into ccState so the draft survives a minimize.
function ccSnapshotDom() {
  const g = (id) => document.getElementById(id);
  if (ccState.view === "tpl") {
    const d = ccState.tpl;
    d.name = g("ccTplName").value.trim();
    d.cbo = g("ccTplCbo").checked;
    d.budget = g("ccTplBudget").value;
    d.gender = g("ccTplGender").value;
    d.cta = g("ccTplCta").value;
    d.text = g("ccTplText").value;
    d.cardEnabled = g("ccTplCard").checked;
    d.cardUrl = g("ccTplCardUrl").value.trim();
    d.step = ccState.tpl.step;
  } else if (ccState.view === "run") {
    const r = ccState.run;
    r.base = g("ccRunBase").value;
    r.hour = +g("ccRunHour").value;
    r.minute = +g("ccRunMinute").value;
    r.spark = g("ccRunSpark").value;
    r.links = g("ccRunLinks").value;
    if (!g("ccRunIdentity").disabled && g("ccRunIdentity").value) {
      r.identityId = g("ccRunIdentity").value;
      r.identityType = g("ccRunIdentity").selectedOptions[0]?.dataset.type || "AUTO";
    }
    const manualId = g("ccRunFormId").value.trim();
    if (manualId) { r.formId = manualId; r.formLabel = `Form ID ${manualId}`; }
    else if (g("ccRunForm").value) { r.formId = g("ccRunForm").value; r.formLabel = g("ccRunForm").selectedOptions[0]?.textContent || r.formId; }
  }
}

// Rebuild the DOM from ccState after a resume.
function ccRestoreDom() {
  if (ccState.view === "tpl") {
    const d = ccState.tpl;
    const g = (id) => document.getElementById(id);
    g("ccTplName").value = d.name;
    g("ccTplCbo").checked = d.cbo;
    g("ccTplBudget").value = d.budget;
    g("ccTplGender").value = d.gender;
    g("ccTplCta").value = d.cta;
    g("ccTplText").value = d.text;
    g("ccTplCard").checked = d.cardEnabled;
    g("ccTplCardWrap").hidden = !d.cardEnabled;
    g("ccTplCardUrl").value = d.cardUrl;
    syncTplTypeToggle();
    renderTplAgeChips();
    renderTplLocChips();
    ccShowView("tpl");
    tplGoBack(d.step || 1);
  } else if (ccState.view === "run") {
    const r = ccState.run;
    ccShowView("run");
    if (r.template) {
      document.getElementById("ccRunTplLabel").innerHTML =
        `Template: <strong>${escapeHtml(r.template.name)}</strong> · ${r.template.campaign_type === "SALES" ? "Sales" : "Lead Generation"}`;
    }
    const sel = document.getElementById("ccRunBcSelect");
    sel.innerHTML = tiktokState.connections.map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`).join("");
    if (r.connectionId) sel.value = r.connectionId;
    renderCcRunAdvertisers();
    document.getElementById("ccRunBase").value = r.base;
    document.getElementById("ccRunHour").value = String(r.hour);
    document.getElementById("ccRunMinute").value = String(r.minute);
    document.getElementById("ccRunSpark").value = r.spark;
    document.getElementById("ccRunLinks").value = r.links;
    // Restore a manually-typed Form ID before the resources step re-renders.
    document.getElementById("ccRunFormId").value = /^Form ID /.test(r.formLabel || "") ? r.formId : "";
    const step = r.step || 1;
    if (step >= 5 && r.resources) renderCcResourcesFromState();
    runGoStepShow(step);
    if (step === 2) renderCcNamePreview();
    if (step === 3) renderCcTzList();
    if (step === 4) renderCcSparkCounts();
    if (step === 6) renderCcReview();
  } else {
    ccShowView("home");
    renderCcTemplateList();
  }
}

function ccShowView(v) {
  ccState.view = v;
  document.getElementById("ccHome").hidden = v !== "home";
  document.getElementById("ccTplWizard").hidden = v !== "tpl";
  document.getElementById("ccRun").hidden = v !== "run";
  document.getElementById("ccTitle").textContent =
    v === "tpl" ? (ccState.tpl.id ? "Edit Template" : "New Template") : v === "run" ? "Run Template" : "Campaign Creator";
}

function ccSteps(containerId, current, total) {
  const spans = document.querySelectorAll(`#${containerId} span[data-step]`);
  spans.forEach((s) => {
    const n = +s.dataset.step;
    s.classList.toggle("active", n === current);
    s.classList.toggle("done", n < current);
  });
  void total;
}

// ---- home: template list ----

function renderCcTemplateList() {
  const el = document.getElementById("ccTemplateList");
  if (!ccState.templates.length) {
    el.innerHTML = `<p class="cc-empty">No templates yet. Create one to get started.</p>`;
    return;
  }
  el.innerHTML = ccState.templates
    .map((t) => {
      const c = t.config || {};
      const sub = `${t.campaign_type === "SALES" ? "Sales" : "Lead Gen"} · $${Number(c.daily_budget || 0)}/day · ${(c.location_labels || []).join(", ") || (c.location_ids || []).length + " location(s)"}`;
      return `<div class="cc-tpl-card" data-tpl-id="${t.id}">
        <div><div class="cc-tpl-name">${escapeHtml(t.name)}</div><div class="cc-tpl-sub">${escapeHtml(sub)}</div></div>
        <div class="cc-tpl-actions">
          <button class="icon-btn primary" data-tpl-use="${t.id}">Use</button>
          <button class="icon-btn" data-tpl-edit="${t.id}">Edit</button>
          <button class="icon-btn danger" data-tpl-del="${t.id}">Delete</button>
        </div></div>`;
    })
    .join("");
}

async function onCcTemplateListClick(e) {
  const use = e.target.closest("[data-tpl-use]");
  const edit = e.target.closest("[data-tpl-edit]");
  const del = e.target.closest("[data-tpl-del]");
  if (use) return openRunWizard(ccState.templates.find((t) => t.id === use.dataset.tplUse));
  if (edit) return openTplWizard(ccState.templates.find((t) => t.id === edit.dataset.tplEdit));
  if (del) {
    const t = ccState.templates.find((x) => x.id === del.dataset.tplDel);
    if (!t || !confirm(`Delete template “${t.name}”? Campaigns already created from it are unaffected.`)) return;
    try {
      await deleteCampaignTemplate(t.id);
      ccState.templates = ccState.templates.filter((x) => x.id !== t.id);
      renderCcTemplateList();
    } catch (err) {
      alert(err.message);
    }
  }
}

// ---- template wizard ----

function openTplWizard(tpl) {
  const d = ccState.tpl;
  d.id = tpl ? tpl.id : null;
  const c = (tpl && tpl.config) || {};
  d.name = tpl ? tpl.name : "";
  d.type = tpl ? tpl.campaign_type : "LEAD_GENERATION";
  d.cbo = c.cbo === undefined ? true : !!c.cbo;
  d.budget = c.daily_budget != null ? String(c.daily_budget) : "";
  d.locations = (c.location_ids || []).map((id, i) => ({ id: String(id), name: (c.location_labels || [])[i] || String(id) }));
  d.ages = new Set((c.age_groups && c.age_groups.length ? c.age_groups : CC_AGE_OPTS.map((o) => o.v)));
  d.gender = c.gender || "GENDER_UNLIMITED";
  d.cta = c.cta || "LEARN_MORE";
  d.text = c.ad_text || "";
  d.cardEnabled = !!(c.interactive_card && c.interactive_card.enabled);
  d.cardUrl = (c.interactive_card && c.interactive_card.image_url) || "";
  d.countries = [];
  d.step = 1;

  ccShowView("tpl");
  document.getElementById("ccTplName").value = d.name;
  document.getElementById("ccTplCbo").checked = d.cbo;
  document.getElementById("ccTplBudget").value = d.budget;
  document.getElementById("ccTplGender").value = d.gender;
  document.getElementById("ccTplCta").value = d.cta;
  document.getElementById("ccTplText").value = d.text;
  document.getElementById("ccTplCard").checked = d.cardEnabled;
  document.getElementById("ccTplCardWrap").hidden = !d.cardEnabled;
  document.getElementById("ccTplCardUrl").value = d.cardUrl;
  document.getElementById("ccTplLocInput").value = "";
  syncTplTypeToggle();
  renderTplAgeChips();
  renderTplLocChips();
  tplGoStep(1);
  loadTplCountries();
}

function syncTplTypeToggle() {
  document.querySelectorAll("#ccTplType button").forEach((b) => b.classList.toggle("active", b.dataset.type === ccState.tpl.type));
}
function renderTplAgeChips() {
  document.getElementById("ccTplAge").innerHTML = CC_AGE_OPTS.map(
    (o) => `<span class="cc-chip${ccState.tpl.ages.has(o.v) ? " on" : ""}" data-age="${o.v}">${o.l}</span>`
  ).join("");
}
function renderTplLocChips() {
  const el = document.getElementById("ccTplLocChips");
  el.innerHTML = ccState.tpl.locations
    .map((l) => `<span class="cc-chip on">${escapeHtml(l.name)} <span class="x" data-loc-remove="${escapeHtml(l.id)}">✕</span></span>`)
    .join("");
}

async function loadTplCountries() {
  const d = ccState.tpl;
  const hint = document.getElementById("ccTplLocHint");
  const conn = tiktokState.connections[0];
  const adv = conn ? advsForConnection(conn.id).find((a) => advIsApproved(a)) : null;
  if (!conn || !adv) {
    hint.textContent = "Connect a TikTok Business Center with an Approved account to load the location list.";
    return;
  }
  hint.textContent = "Loading TikTok location list…";
  d.countriesLoading = true;
  try {
    const data = await fetchWhCountries(conn.id, adv.advertiser_id);
    d.countries = data.countries || [];
    hint.textContent = d.countries.length ? "" : "TikTok returned no locations for this account.";
  } catch (err) {
    hint.textContent = `Couldn't load locations: ${err.message}`;
  } finally {
    d.countriesLoading = false;
  }
}

function renderTplLocSuggest(query) {
  const box = document.getElementById("ccTplLocSuggest");
  const q = String(query || "").trim().toLowerCase();
  if (!q || !ccState.tpl.countries.length) {
    box.hidden = true;
    return;
  }
  const hits = ccState.tpl.countries
    .filter((c) => c.name.toLowerCase().includes(q) || String(c.code || "").toLowerCase() === q)
    .slice(0, 8);
  box.hidden = !hits.length;
  box.innerHTML = hits
    .map((c) => `<button type="button" data-loc-id="${escapeHtml(c.location_id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`)
    .join("");
}

function tplGoStep(n) {
  ccState.tpl.step = n;
  document.getElementById("ccTplStep1").hidden = n !== 1;
  document.getElementById("ccTplStep2").hidden = n !== 2;
  document.getElementById("ccTplStep3").hidden = n !== 3;
  ccSteps("ccTplSteps", n);
  ["ccTplErr1", "ccTplErr2", "ccTplErr3"].forEach((id) => (document.getElementById(id).textContent = ""));

  if (n === 2) {
    // pull step-1 values into the draft
    ccState.tpl.name = document.getElementById("ccTplName").value.trim();
    ccState.tpl.cbo = document.getElementById("ccTplCbo").checked;
    ccState.tpl.budget = document.getElementById("ccTplBudget").value;
    const err = document.getElementById("ccTplErr1");
    if (!ccState.tpl.name) return (tplGoBack(1), (err.textContent = "Enter a template name."));
    if (!(Number(ccState.tpl.budget) > 0)) return (tplGoBack(1), (err.textContent = "Enter a daily budget greater than 0."));
  }
  if (n === 3) {
    ccState.tpl.gender = document.getElementById("ccTplGender").value;
    if (!ccState.tpl.locations.length) return (tplGoBack(2), (document.getElementById("ccTplErr2").textContent = "Add at least one location."));
    if (!ccState.tpl.ages.size) return (tplGoBack(2), (document.getElementById("ccTplErr2").textContent = "Select at least one age range."));
  }
}
function tplGoBack(n) {
  ccState.tpl.step = n;
  document.getElementById("ccTplStep1").hidden = n !== 1;
  document.getElementById("ccTplStep2").hidden = n !== 2;
  document.getElementById("ccTplStep3").hidden = n !== 3;
  ccSteps("ccTplSteps", n);
}

async function saveTplWizard() {
  const d = ccState.tpl;
  d.cta = document.getElementById("ccTplCta").value;
  d.text = document.getElementById("ccTplText").value.trim();
  d.cardEnabled = document.getElementById("ccTplCard").checked;
  d.cardUrl = document.getElementById("ccTplCardUrl").value.trim();
  const err = document.getElementById("ccTplErr3");
  err.textContent = "";
  if (d.cardEnabled && !d.cardUrl) return (err.textContent = "Add the card image link or turn Interactive Card off.");

  const config = {
    cbo: d.cbo,
    daily_budget: Number(d.budget),
    location_ids: d.locations.map((l) => l.id),
    location_labels: d.locations.map((l) => l.name),
    age_groups: CC_AGE_OPTS.map((o) => o.v).filter((v) => d.ages.has(v)),
    gender: d.gender,
    cta: d.cta,
    ad_text: d.text,
    interactive_card: { enabled: d.cardEnabled, image_url: d.cardUrl },
  };
  const btn = document.getElementById("ccTplSave");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const payload = { action: d.id ? "update" : "create", name: d.name, campaign_type: d.type, config };
    if (d.id) payload.id = d.id;
    const res = await saveCampaignTemplate(payload);
    const saved = res.template;
    const i = ccState.templates.findIndex((t) => t.id === saved.id);
    if (i >= 0) ccState.templates[i] = saved;
    else ccState.templates.push(saved);
    ccState.templates.sort((a, b) => a.name.localeCompare(b.name));
    ccShowView("home");
    renderCcTemplateList();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Template";
  }
}

// ---- runtime wizard ----

function ccRunAdvs() {
  return advsForConnection(ccState.run.connectionId);
}
function ccSelectedAdvs() {
  return ccRunAdvs().filter((a) => ccState.run.selected.has(String(a.advertiser_id)));
}

function openRunWizard(tpl) {
  if (!tpl) return;
  ccResetRunDraft();
  const r = ccState.run;
  r.template = tpl;
  ccShowView("run");
  document.getElementById("ccRunTplLabel").innerHTML =
    `Template: <strong>${escapeHtml(tpl.name)}</strong> · ${tpl.campaign_type === "SALES" ? "Sales" : "Lead Generation"} · $${Number((tpl.config || {}).daily_budget || 0)}/day`;
  document.getElementById("ccRunBase").value = "";
  document.getElementById("ccRunSpark").value = "";
  document.getElementById("ccRunLinks").value = "";
  document.getElementById("ccRunFormId").value = "";

  const sel = document.getElementById("ccRunBcSelect");
  if (!tiktokState.connections.length) {
    sel.innerHTML = "";
    document.getElementById("ccRunAdvList").innerHTML = `<p class="tk-empty">No TikTok Business Centers connected. Add one under Tools → TikTok Ads first.</p>`;
    document.getElementById("ccRunSummary").innerHTML = "";
  } else {
    sel.innerHTML = tiktokState.connections.map((c) => `<option value="${c.id}">${escapeHtml(connBcOptionLabel(c))}</option>`).join("");
    r.connectionId = tiktokState.connections[0].id;
    sel.value = r.connectionId;
    renderCcRunAdvertisers();
  }
  runGoStep(1);
}

function renderCcRunAdvertisers() {
  const advs = ccRunAdvs();
  const approved = advs.filter((a) => advIsApproved(a)).length;
  document.getElementById("ccRunSummary").innerHTML = `
    <span class="tk-sum-item"><strong>${advs.length}</strong> account${advs.length === 1 ? "" : "s"}</span>
    <span class="tk-sum-item ok"><strong>${approved}</strong> Approved</span>
    <span class="tk-sum-item warn"><strong>${advs.length - approved}</strong> Suspended</span>`;
  const wrap = document.getElementById("ccRunAdvList");
  wrap.innerHTML = advs.length
    ? advs.map((a) => {
        const ok = advIsApproved(a);
        const id = String(a.advertiser_id);
        const meta = [id, a.currency || null, a.display_timezone || a.timezone || null].filter(Boolean).join(" · ");
        return `<label class="tk-adv${ok ? "" : " disabled"}">
          <input type="checkbox" data-cc-adv="${escapeHtml(id)}" ${ccState.run.selected.has(id) ? "checked" : ""} ${ok ? "" : "disabled"} />
          <span class="tk-adv-main"><span class="tk-adv-name">${escapeHtml(a.advertiser_name || id)}</span><span class="tk-adv-meta">${escapeHtml(meta)}</span></span>
          <span class="tk-adv-status ${ok ? "ok" : "warn"}">${ok ? "Approved" : "Suspended"}</span>
        </label>`;
      }).join("")
    : `<p class="tk-empty">No advertiser accounts under this Business Center.</p>`;
  syncCcRunSelectAll();
  document.getElementById("ccRunNext1").disabled = ccState.run.selected.size === 0;
}
function syncCcRunSelectAll() {
  const approved = ccRunAdvs().filter((a) => advIsApproved(a));
  const cb = document.getElementById("ccRunSelectAll");
  cb.checked = approved.length > 0 && approved.every((a) => ccState.run.selected.has(String(a.advertiser_id)));
  cb.disabled = approved.length === 0;
}

function renderCcNamePreview() {
  const advs = ccSelectedAdvs();
  const base = ccState.run.base.trim();
  document.getElementById("ccRunNamePreview").innerHTML = advs
    .map((a, i) => `<div class="row"><span>${escapeHtml(a.advertiser_name || a.advertiser_id)}</span><strong>${base ? escapeHtml(base + (i + 1)) : "—"}</strong></div>`)
    .join("");
}

function ccLocalTime(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date());
  } catch (_) {
    return "—";
  }
}
function renderCcTzList() {
  const advs = ccSelectedAdvs();
  const zones = new Set(advs.map((a) => a.timezone || a.display_timezone || "America/New_York"));
  const hh = String(ccState.run.hour).padStart(2, "0");
  const mm = String(ccState.run.minute).padStart(2, "0");
  const multi = zones.size > 1
    ? `<div class="row"><span>Note</span><strong>${zones.size} timezones — ${hh}:${mm} is applied in each account's own zone</strong></div>`
    : "";
  document.getElementById("ccRunTzList").innerHTML =
    multi +
    advs.map((a) => {
      const tz = a.timezone || a.display_timezone || "America/New_York";
      return `<div class="row"><span>${escapeHtml(a.advertiser_name || a.advertiser_id)}</span><strong>${escapeHtml(tz)} · now ${escapeHtml(ccLocalTime(tz))} · starts ${hh}:${mm}</strong></div>`;
    }).join("");
}

function renderCcSparkCounts() {
  const n = ccSelectedAdvs().length;
  const sc = ccState.run.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  const lc = ccState.run.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  const mark = (c) => (c === n ? "✓" : "✗");
  document.getElementById("ccRunSparkCount").textContent = `${sc} spark code${sc === 1 ? "" : "s"} ${mark(sc)}  (need ${n})`;
  document.getElementById("ccRunLinksCount").textContent = `${lc} post link${lc === 1 ? "" : "s"} ${mark(lc)}  (need ${n})`;
}

async function runGoStep(n) {
  if (n < 1) return ccShowView("home");
  const r = ccState.run;
  r.step = n;
  for (const s of [1, 2, 3, 4, 5, 6, 7]) document.getElementById(`ccRunStep${s}`).hidden = s !== n;
  ccSteps("ccRunSteps", Math.min(n, 6));
  for (const id of ["ccRunErr1", "ccRunErr2", "ccRunErr3", "ccRunErr4", "ccRunErr5", "ccRunErr6"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }

  if (n === 2) {
    if (!ccState.run.selected.size) return runGoStep(1);
    renderCcNamePreview();
  }
  if (n === 3) {
    r.base = document.getElementById("ccRunBase").value.trim();
    if (!r.base) { document.getElementById("ccRunErr2").textContent = "Enter a campaign name base."; return runGoStepShow(2); }
    renderCcTzList();
  }
  if (n === 4) renderCcSparkCounts();
  if (n === 5) {
    const need = ccSelectedAdvs().length;
    const sc = r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const lc = r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (sc.length !== need || lc.length !== need) {
      document.getElementById("ccRunErr4").textContent = `Need exactly ${need} spark codes and ${need} post links (one per line).`;
      return runGoStepShow(4);
    }
    await loadCcResources();
  }
  if (n === 6) renderCcReview();
}
function runGoStepShow(n) {
  ccState.run.step = n;
  for (const s of [1, 2, 3, 4, 5, 6, 7]) document.getElementById(`ccRunStep${s}`).hidden = s !== n;
  ccSteps("ccRunSteps", Math.min(n, 6));
}

async function loadCcResources() {
  const r = ccState.run;
  const type = r.template.campaign_type;
  document.getElementById("ccRunResLoading").hidden = false;
  document.getElementById("ccRunResBody").hidden = true;
  document.getElementById("ccRunNext5").disabled = true;
  try {
    r.resources = await campaignCreatorResources(r.connectionId, type, ccSelectedAdvs().map((a) => String(a.advertiser_id)));
  } catch (err) {
    document.getElementById("ccRunResLoading").hidden = true;
    document.getElementById("ccRunErr5").textContent = err.message;
    return;
  }
  // A fresh preflight resets the identity/form picks so stale values can't carry.
  r.identityId = "__AUTO__";
  r.identityType = "AUTO";
  r.formId = "";
  r.formLabel = "";
  renderCcResourcesFromState();
}

// Render step-5 controls purely from ccState.run.resources (also used on resume).
function renderCcResourcesFromState() {
  const r = ccState.run;
  const res = r.resources || {};
  const type = r.template.campaign_type;
  const isLead = type === "LEAD_GENERATION";

  document.getElementById("ccRunResLoading").hidden = true;
  document.getElementById("ccRunResBody").hidden = false;

  const idSel = document.getElementById("ccRunIdentity");
  idSel.innerHTML = (res.identities || [])
    .map((x) => {
      const cov = x.total && x.count < x.total ? ` (in ${x.count}/${x.total})` : "";
      return `<option value="${escapeHtml(x.identity_id)}" data-type="${escapeHtml(x.identity_type || "AUTO")}">${escapeHtml(x.name || x.identity_id)}${escapeHtml(cov)}</option>`;
    })
    .join("");
  if (![...idSel.options].some((o) => o.value === r.identityId)) r.identityId = idSel.value || "__AUTO__";
  idSel.value = r.identityId;
  r.identityType = idSel.selectedOptions[0]?.dataset.type || "AUTO";

  document.getElementById("ccRunFormWrap").hidden = !isLead;
  document.getElementById("ccRunEventWrap").hidden = isLead;

  if (isLead) {
    const fs = document.getElementById("ccRunForm");
    const forms = res.forms || [];
    fs.innerHTML = forms.length
      ? [`<option value="">— select a form —</option>`]
          .concat(
            forms.map((f) => {
              const tag = f.source === "account" ? " (account)" : "";
              return `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name || f.id)}${escapeHtml(tag)}</option>`;
            })
          )
          .join("")
      : `<option value="">— none found via API — paste a Form ID below —</option>`;
    const manual = document.getElementById("ccRunFormId");
    // Keep an existing pick if it still matches a dropdown option or a manual id.
    if (manual.value.trim()) {
      r.formId = manual.value.trim();
      r.formLabel = `Form ID ${r.formId}`;
    } else if ([...fs.options].some((o) => o.value === r.formId) && r.formId) {
      fs.value = r.formId;
    } else {
      r.formId = "";
      r.formLabel = "";
      fs.value = "";
    }
  } else {
    const es = document.getElementById("ccRunEvent");
    const events = res.sales_events || [];
    es.innerHTML = events.length
      ? events.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("")
      : `<option value="">— no conversion event available —</option>`;
    if (![...es.options].some((o) => o.value === r.salesEvent)) r.salesEvent = es.value || "";
    es.value = r.salesEvent;
  }

  const notes = [];
  for (const b of res.blockers || []) notes.push(`<div class="note bad">✖ ${escapeHtml(b)}</div>`);
  for (const a of res.advertisers || []) {
    for (const nt of a.notes || []) notes.push(`<div class="note">⚠ ${escapeHtml(a.advertiser_name)}: ${escapeHtml(nt)}</div>`);
  }
  document.getElementById("ccRunResNotes").innerHTML = notes.join("");
  syncCcRunNext5();
}

function syncCcRunNext5() {
  const r = ccState.run;
  const res = r.resources || {};
  const isLead = r.template.campaign_type === "LEAD_GENERATION";
  const hardBlock = (res.blockers || []).length > 0;
  // Identity is never a blocker (Auto always works). Lead Gen needs a form name.
  const ok = !hardBlock && (isLead ? !!r.formId : !!r.salesEvent);
  document.getElementById("ccRunNext5").disabled = !ok;
}

function renderCcReview() {
  const r = ccState.run;
  const advs = ccSelectedAdvs();
  const base = r.base.trim();
  const sc = r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const lc = r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const isLead = r.template.campaign_type === "LEAD_GENERATION";
  const idName = document.getElementById("ccRunIdentity").selectedOptions[0]?.textContent || r.identityId;
  const pageByAdv = new Map((r.resources?.advertisers || []).map((a) => [String(a.advertiser_id), a.instant_page]));
  const hh = String(r.hour).padStart(2, "0");
  const mm = String(r.minute).padStart(2, "0");

  document.getElementById("ccRunReview").innerHTML =
    `<div class="row"><span>Identity</span><strong>${escapeHtml(idName)}</strong></div>` +
    `<div class="row"><span>Start time</span><strong>${hh}:${mm} in each account's timezone</strong></div>` +
    (isLead
      ? `<div class="row"><span>Instant Form</span><strong>${escapeHtml(r.formLabel || r.formId || "—")}</strong></div>`
      : `<div class="row"><span>Conversion event</span><strong>${escapeHtml(r.salesEvent || "—")}</strong></div>`) +
    advs
      .map((a, i) => {
        const id = String(a.advertiser_id);
        const page = !isLead ? `<div class="row"><span>Instant Page</span><strong>${escapeHtml(pageByAdv.get(id) || "newest (auto)")}</strong></div>` : "";
        return `<div class="rev-acct">${escapeHtml(a.advertiser_name || id)}</div>
          <div class="row"><span>Campaign</span><strong>${escapeHtml(base + (i + 1))}</strong></div>
          <div class="row"><span>Spark code</span><strong>#${i + 1} · ${escapeHtml((sc[i] || "").slice(0, 10))}…</strong></div>
          <div class="row"><span>Post link</span><strong>${escapeHtml((lc[i] || "").replace(/^https:\/\/(www\.)?/, "").slice(0, 44))}</strong></div>
          ${page}`;
      })
      .join("");
}

async function submitCampaignCreator() {
  const r = ccState.run;
  const btn = document.getElementById("ccRunCreate");
  const prog = document.getElementById("ccRunProgress");
  const err = document.getElementById("ccRunErr6");
  err.textContent = "";
  const advs = ccSelectedAdvs();
  btn.disabled = true;
  btn.textContent = "Creating…";
  prog.className = "eng-placeholder busy";
  prog.textContent = `Creating ${advs.length} campaign${advs.length === 1 ? "" : "s"}… this can take a minute.`;
  try {
    const res = await runCampaignCreator({
      template_id: r.template.id,
      campaign_type: r.template.campaign_type,
      connection_id: r.connectionId,
      advertiser_ids: advs.map((a) => String(a.advertiser_id)),
      base_name: r.base.trim(),
      schedule: { hour: r.hour, minute: r.minute },
      spark_codes: r.spark.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      post_links: r.links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      identity_id: r.identityId,
      identity_type: r.identityType,
      form_id: r.formId || undefined,
      sales_event: r.salesEvent || undefined,
    });
    renderCcResults(res.results || []);
    runGoStepShow(7);
    ccSteps("ccRunSteps", 6);
    ccState.run.step = 7;
    loadTiktokCampaigns();
    runCampaignCreatorDuplication();
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
    btn.textContent = "Create Campaigns";
    prog.textContent = "";
    prog.className = "eng-placeholder";
  }
}

function renderCcResults(results) {
  const el = document.getElementById("ccRunResults");
  const tone = (s) => (s === "Created" ? "ok" : s === "Skipped" ? "warn" : "bad");
  const created = results.filter((r) => r.status === "Created").length;
  const failed = results.filter((r) => r.status === "Failed").length;
  const skipped = results.filter((r) => r.status === "Skipped").length;
  el.innerHTML =
    `<div class="wh-result-row"><span class="wh-r-detail"><strong>${created}</strong> Created · <strong>${failed}</strong> Failed${skipped ? ` · <strong>${skipped}</strong> Skipped` : ""}</span></div>` +
    results
      .map((r) => {
        const warn = (r.warnings || []).map((w) => `<div class="wh-r-detail">⚠ ${escapeHtml(w)}</div>`).join("");
        return `<div class="wh-result-row ${tone(r.status)}">
          <span class="wh-r-name">${escapeHtml(r.advertiser_name || r.advertiser_id)} — ${escapeHtml(r.campaign_name || "")}</span>
          <span class="wh-r-status">${escapeHtml(r.status)}${r.error ? ` <span class="wh-r-detail">— ${escapeHtml(r.error)}</span>` : ""}${warn}</span>
        </div>`;
      })
      .join("");
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
  const v = Number(bal.balance) || 0;
  // > $10 healthy · $5–$10 warning · < $5 danger
  const tone = v > 10 ? "ok" : v >= 5 ? "warn" : "bad";
  el.hidden = false;
  el.innerHTML = `<span class="bcbal-label">Available Balance</span><span class="bcbal-value tabular ${tone}">${money(v)}</span>`;
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
    <div class="adgroups-wrap">
      <table class="adgroups-table">
        <colgroup>
          <col style="width:40px" /><col style="width:118px" /><col style="width:210px" /><col style="width:96px" /><col style="width:96px" />
        </colgroup>
        <thead>
          <tr><th>On/Off</th><th>Status</th><th>Ad group</th><th class="num">Spend</th><th class="num">CPA</th></tr>
        </thead>
        <tbody>
          ${rows.map((g) => adGroupRowHtml(s.campaignId, g)).join("")}
        </tbody>
      </table>
    </div>`;
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

// Hourly TikTok spend for the Live Performance graph, derived from the
// cumulative-spend snapshots the metrics refresh stores each NY hour:
//   hour H spend = cumulative(H) − cumulative(nearest earlier hour, else 0)
// Completed hours use their frozen snapshot; the current (unfinished) hour uses
// the live cumulative minus the last completed-hour snapshot. Hours we never
// captured stay null (a gap, not a wrong bar); future hours stay null.
// Aggregate only — shown just for "All Sources Combined".
function hourlySpendSeries() {
  const st = state.spendToday;
  if (!st || st.date !== todayStr() || state.chartSource !== "__all__") return Array(24).fill(null);

  const byHour = st.byHour || {};
  const curH = Number.isFinite(st.currentHour) ? st.currentHour : currentEstHour();
  const liveCum = toNum(st.cumulative);
  const at = (h) => (byHour[String(h)] != null ? toNum(byHour[String(h)]) : null);

  const out = Array(24).fill(null);
  for (let h = 0; h <= curH && h < 24; h++) {
    const thisCum = h === curH ? liveCum : at(h);
    if (thisCum == null) continue; // never captured this completed hour — leave a gap

    let prev = 0;
    for (let p = h - 1; p >= 0; p--) {
      const v = at(p);
      if (v != null) {
        prev = v;
        break;
      }
    }
    const delta = thisCum - prev;
    out[h] = delta > 0 ? Math.round(delta * 100) / 100 : 0; // clamp: no negative bars at a reset
  }
  return out;
}

function renderChart() {
  if (!mainChartCanvas || !window.Chart) return;

  // Fixed 00:00–23:00 EST axis, always — never the viewer's local timezone.
  // Only hours up to (and including) the current EST hour get plotted;
  // everything after stays a gap (null) until that hour actually happens.
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const limit = currentEstHour() + 1;

  const spendFull = hourlySpendSeries();
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
const tiktokState = { connections: [], advertisers: [], selectedConnectionId: null, trackedDraft: {}, savingNetwork: null };
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
  document.getElementById("tiktokRefreshBtn").addEventListener("click", () => refreshTiktokData());
  document.getElementById("tiktokBcSelect").addEventListener("change", (e) => {
    tiktokState.selectedConnectionId = e.target.value;
    renderSelectedConnection();
  });

  const wrap = document.getElementById("tiktokConnectionsWrap");
  wrap.addEventListener("change", (e) => {
    const all = e.target.closest("input[data-tk-selectall-approved]");
    if (all) {
      const connId = all.dataset.tkConnId;
      const conn = tiktokState.connections.find((x) => x.id === connId);
      const advs = conn ? advsForConnection(conn.id).filter((a) => advIsApproved(a)) : [];
      for (const a of advs) tiktokState.trackedDraft[`${connId}::${a.advertiser_id}`] = all.checked;
      renderSelectedConnection();
      updateSaveButton();
      return;
    }
    const cb = e.target.closest('input[type="checkbox"][data-tk-adv]');
    if (cb) {
      tiktokState.trackedDraft[`${cb.dataset.tkConnId}::${cb.dataset.tkAdvId}`] = cb.checked;
      updateSaveButton();
    }
  });
  wrap.addEventListener("click", (e) => {
    const netBtn = e.target.closest("[data-tk-net]");
    if (netBtn && !netBtn.classList.contains("active")) {
      setBcNetwork(netBtn.dataset.tkConn, netBtn.dataset.tkNet);
      return;
    }
    const disconnectBtn = e.target.closest("[data-tk-disconnect]");
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

  // BC / connection dropdown at the top of the modal.
  const bcWrap = document.getElementById("tiktokBcSelectWrap");
  const bcSelect = document.getElementById("tiktokBcSelect");
  if (tiktokState.connections.length) {
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

  const rows = advs.length
    ? advs.map((a) => tiktokAdvRow(c.id, a)).join("")
    : `<p class="tk-empty">No advertiser accounts found for this connection.</p>`;

  const approvedAdvs = advs.filter((a) => advIsApproved(a));
  const allApprovedTracked =
    approvedAdvs.length > 0 && approvedAdvs.every((a) => isAdvTracked(c.id, a));
  const selectAll = approvedAdvs.length
    ? `<div class="tk-selectall"><label><input type="checkbox" data-tk-selectall-approved data-tk-conn-id="${c.id}" ${allApprovedTracked ? "checked" : ""} /> Select all Approved accounts</label></div>`
    : "";

  const net = String(c.affiliate_network || "GLITCHY").toUpperCase();
  const saving = tiktokState.savingNetwork === c.id;

  wrap.innerHTML = `
    <div class="tk-conn">
      <div class="tk-conn-head">
        <div class="tk-conn-id">
          <div class="tk-conn-label">${escapeHtml(connBcName(c))}</div>
          <div class="tk-conn-sub">${escapeHtml(c.tiktok_email || c.tiktok_display_name || "")}</div>
        </div>
        <div class="tk-conn-right">
          <div class="tk-net-toggle${saving ? " saving" : ""}" title="Affiliate network for this Business Center's campaigns">
            <button class="${net === "GLITCHY" ? "active" : ""}" data-tk-net="GLITCHY" data-tk-conn="${c.id}" ${saving ? "disabled" : ""}>Glitchy</button>
            <button class="${net === "MABAC" ? "active" : ""}" data-tk-net="MABAC" data-tk-conn="${c.id}" ${saving ? "disabled" : ""}>Mabac</button>
          </div>
          <button class="tk-disconnect" data-tk-disconnect="${c.id}" title="Disconnect this Business Center">
            <span class="tk-disconnect-icon">⚠</span> Disconnect
          </button>
        </div>
      </div>
      ${selectAll}
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
    title: "Connect New BC",
    hint: "Enter the dashboard password. You'll then be sent to TikTok to authorize the Business Center logged in to this browser profile.",
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
    // Full sync so campaigns from every affected BC are consistent.
    await refreshTiktokData({ silent: true, allBcs: true });
  } catch (err) {
    setStatus(`Couldn't save selection: ${err.message}`, true);
  } finally {
    btn.textContent = "Save tracked accounts";
    updateSaveButton();
  }
}

// "Refresh Data" — re-scan advertiser accounts (Approved/Suspended, new
// accounts), re-discover tracked campaigns + ad/adgroup statuses, refresh
// budgets/balances. Scoped to the currently selected BC unless allBcs. Does not
// change which accounts are tracked. No password.
async function refreshTiktokData({ silent, allBcs } = {}) {
  const btn = document.getElementById("tiktokRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  if (!silent) setStatus("Refreshing TikTok data…");
  try {
    const connId = allBcs ? null : tiktokState.selectedConnectionId;
    const r = await syncTiktokCampaigns(connId);
    await loadTiktokCampaigns();
    loadTiktokBudgets();
    loadMabac();
    loadTiktokMetrics();
    if (document.getElementById("accountsModal").classList.contains("open")) {
      await renderTiktokAccounts();
    }
    if (r.note) setStatus(r.note);
    else setStatus(`Refreshed — ${r.campaignCount ?? 0} campaign(s) across ${r.connections ?? 0} Business Center(s).`);
  } catch (err) {
    setStatus(`Refresh failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh Data";
  }
}

// Glitchy/Mabac toggle for one BC. Persists immediately, no password, subtle
// saving state. Stamps the BC's campaigns with the new network and re-merges.
async function setBcNetwork(connectionId, network) {
  if (tiktokState.savingNetwork) return;
  tiktokState.savingNetwork = connectionId;
  renderSelectedConnection();
  try {
    await setConnectionNetwork(connectionId, network);
    const conn = tiktokState.connections.find((c) => c.id === connectionId);
    if (conn) conn.affiliate_network = network;
    for (const c of state.tiktokCampaigns) {
      if (String(c.connection_id) === String(connectionId)) c.affiliate_network = network;
    }
    rebuildSources();
    loadMabac(); // ensure Mabac data is loaded if we just switched to it
    setStatus(`${connBcName(conn || {})} now uses ${network === "MABAC" ? "Mabac" : "Glitchy"} for affiliate data.`);
  } catch (err) {
    setStatus(`Couldn't change network: ${err.message}`, true);
  } finally {
    tiktokState.savingNetwork = null;
    renderSelectedConnection();
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
