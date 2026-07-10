import { mockAccounts, mockSourceProfile } from "./mock.js";
import {
  fetchGlitchyStats,
  postResetDay,
  fetchDailyTotals,
  loadCache,
} from "./api.js";
import { initTheme } from "./theme.js";
import { createMainChart, createMiniChart } from "./charts.js";

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

// Glitchy's "hour" field (and reset_baselines) are anchored to EST, so
// "today" needs to mean the same calendar date the backend uses. This is a
// pure display/query convenience — it never decides when a new tracking
// session starts. Only a successful password-verified "New Day" click (see
// reset-day.js) ever writes a new baseline.
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
  startTimers();
  refreshAll();
});

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
    renderAccounts();
    openAccountsModal();
  });
  document.getElementById("closeAccountsModal").addEventListener("click", closeAccountsModal);
  document.getElementById("accountsModal").addEventListener("click", (e) => {
    if (e.target.id === "accountsModal") closeAccountsModal();
  });

  document.getElementById("toolsCalendarBtn").addEventListener("click", openCalendarModal);
  document.getElementById("closeCalendarModal").addEventListener("click", closeCalendarModal);
  document.getElementById("calendarModal").addEventListener("click", (e) => {
    if (e.target.id === "calendarModal") closeCalendarModal();
  });

  // ---- New Day (password protected) ----
  document.getElementById("newDayBtn").addEventListener("click", openNewDayModal);
  document.getElementById("cancelNewDayBtn").addEventListener("click", closeNewDayModal);
  document.getElementById("newDayModal").addEventListener("click", (e) => {
    if (e.target.id === "newDayModal") closeNewDayModal();
  });
  document.getElementById("confirmNewDayBtn").addEventListener("click", submitNewDay);
  document.getElementById("newDayPasswordInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewDay();
  });

  document.getElementById("chartSourceSelect").addEventListener("change", (e) => {
    state.chartSource = e.target.value;
    renderChart();
  });

  document.getElementById("sourcesBody").addEventListener("click", (e) => {
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
  const dateStr = todayStr();

  const newConversionSources = new Set();
  if (flagNewConversions) {
    for (const s of sources) {
      const prev = state.prevConversions.get(s.source);
      if (prev !== undefined && s.conversions > prev) newConversionSources.add(s.source);
    }
  }
  state.prevConversions = new Map(sources.map((s) => [s.source, s.conversions]));

  // Spend, CPM, CPA (cost per conversion) and CPNC (cost per network click)
  // all come from TikTok, which isn't connected yet — they stay at 0 rather
  // than showing invented numbers. Clicks, Earning (payout) and EPC are the
  // real Glitchy figures.
  const enriched = sources.map((s) => {
    const profile = mockSourceProfile(s.source, dateStr);
    const spend = 0;
    const cpm = 0;
    const cpa = 0;
    const cpnc = 0;
    const epc = s.clicks > 0 ? s.payout / s.clicks : 0;
    const roas = 0;
    const profit = s.payout - spend;
    return { ...s, type: profile.type, spend, cpm, cpa, cpnc, epc, roas, profit };
  });

  state.sources = enriched;
  state.raw = data.raw || [];
  state.baseSpendTotal = enriched.reduce((a, s) => a + s.spend, 0);
  state.baseEarningsTotal = enriched.reduce((a, s) => a + s.payout, 0);

  populateChartSourceOptions(enriched);
  renderKpis();
  renderTable(newConversionSources);
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
      <td><span class="type-badge ${s.type.toLowerCase()}">${s.type}</span></td>
      <td class="source-name"><span class="expand-caret">▸</span>${crown}${escapeHtml(s.source)}</td>
      <td class="num">${money(s.spend)}</td>
      <td class="num">${money(s.cpm)}</td>
      <td class="num">${money(s.cpa)}</td>
      <td class="num">${money(s.cpnc)}</td>
      <td class="num">${num(s.clicks)}</td>
      <td class="num">${money(s.payout)}</td>
      <td class="num">${money(s.epc)}</td>
      <td class="num ${s.roas >= 1 ? "positive" : "negative"}">${s.roas.toFixed(2)}x</td>
    `;
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "row-detail";
    detailTr.innerHTML = `<td colspan="10"><div class="row-detail-inner"><canvas id="mini_${cssSafeId(s.source)}" height="120"></canvas></div></td>`;
    tbody.appendChild(detailTr);

    if (state.expandedSources.has(s.source)) {
      tr.classList.add("expanded");
      requestAnimationFrame(() => renderMiniChart(s.source));
    }
  });
}

function toggleRowExpand(source) {
  const tr = document.querySelector(`tr.source-row[data-source="${cssEscapeAttr(source)}"]`);
  if (!tr) return;
  const isOpen = tr.classList.toggle("expanded");
  if (isOpen) {
    state.expandedSources.add(source);
    // Chart.js measures its container at creation time — wait for the
    // row-detail-inner max-height transition (0.35s, see base.css) to
    // finish, otherwise it sizes itself against a still-collapsed box.
    setTimeout(() => renderMiniChart(source), 380);
  } else {
    state.expandedSources.delete(source);
  }
}

function renderMiniChart(source) {
  const canvas = document.getElementById(`mini_${cssSafeId(source)}`);
  if (!canvas) return;
  const { hours, values } = hourlyPayoutForSource(source);
  createMiniChart(canvas, source, hours, values, "--profit");
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

// ============================== ACCOUNTS MODAL ==============================

function renderAccounts() {
  const accounts = mockAccounts();
  const list = document.getElementById("accountsList");
  list.innerHTML = "";

  accounts.forEach((acc) => {
    const item = document.createElement("div");
    item.className = "account-item";
    item.innerHTML = `
      <span class="status-dot ${acc.status}"></span>
      <div class="account-info">
        <div class="account-name">${escapeHtml(acc.name)}</div>
        <div class="account-sub">${acc.status === "active" ? "Active" : "Suspended"}</div>
      </div>
    `;
    list.appendChild(item);
  });
}

function openAccountsModal() {
  document.getElementById("accountsModal").classList.add("open");
}
function closeAccountsModal() {
  document.getElementById("accountsModal").classList.remove("open");
}

// ============================== NEW DAY (password protected) ==============================

let newDayAttempts = 0;
let newDayLockedUntil = 0;
let newDayLockInterval = null;

function openNewDayModal() {
  if (Date.now() < newDayLockedUntil) return; // button itself is disabled during lockout
  document.getElementById("newDayPasswordInput").value = "";
  document.getElementById("newDayModalError").textContent = "";
  document.getElementById("newDayModal").classList.add("open");
  document.getElementById("newDayPasswordInput").focus();
}
function closeNewDayModal() {
  document.getElementById("newDayModal").classList.remove("open");
}

async function submitNewDay() {
  const input = document.getElementById("newDayPasswordInput");
  const errorEl = document.getElementById("newDayModalError");
  const confirmBtn = document.getElementById("confirmNewDayBtn");
  const password = input.value;

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Confirming...";
  errorEl.textContent = "";

  try {
    const result = await postResetDay(password);
    newDayAttempts = 0;
    closeNewDayModal();
    setStatus(result.message || "New day started.");
    await refreshAll(true);
  } catch (err) {
    if (err.status === 401) {
      newDayAttempts += 1;
      const remaining = 3 - newDayAttempts;
      if (remaining > 0) {
        errorEl.textContent = `Incorrect password. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
      } else {
        lockNewDayButton();
        closeNewDayModal();
      }
    } else {
      errorEl.textContent = `Reset failed: ${err.message}`;
    }
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm New Day";
  }
}

function lockNewDayButton() {
  newDayLockedUntil = Date.now() + 60000;
  const btn = document.getElementById("newDayBtn");
  btn.disabled = true;

  if (newDayLockInterval) clearInterval(newDayLockInterval);
  const tick = () => {
    const remaining = Math.ceil((newDayLockedUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      btn.disabled = false;
      btn.textContent = "New Day";
      newDayAttempts = 0;
      clearInterval(newDayLockInterval);
      newDayLockInterval = null;
    } else {
      btn.textContent = `Locked (${remaining}s)`;
    }
  };
  tick();
  newDayLockInterval = setInterval(tick, 1000);
}

// ============================== PROFIT CALENDAR (modal, on demand) ==============================

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
    const isFuture = dateStr > todayIso;
    days.push({ dateStr, day: d, isFuture, isToday: dateStr === todayIso, entry: rowsByDate.get(dateStr) || null });
  }
  return { year, mon, month, firstWeekday, days, todayIso };
}

async function openCalendarModal() {
  document.getElementById("calendarModal").classList.add("open");
  const month = todayStr().slice(0, 7);
  try {
    const daily = await fetchDailyTotals(month);
    renderDetailedCalendar(daily);
  } catch (err) {
    renderDetailedCalendar({ month, days: [] });
  }
}

function closeCalendarModal() {
  document.getElementById("calendarModal").classList.remove("open");
}

function renderDetailedCalendar(daily) {
  const { year, mon, firstWeekday, days } = monthGridDays(daily);

  document.getElementById("calendarModalMonthLabel").textContent = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const withEntries = days.filter((d) => d.entry && !d.isFuture);
  const totalSpend = withEntries.reduce((a, d) => a + (d.entry.total_spend || 0), 0);
  const totalEarnings = withEntries.reduce((a, d) => a + (d.entry.total_earnings || 0), 0);
  const totalProfit = totalEarnings - totalSpend;
  const overallRoas = totalSpend > 0 ? totalEarnings / totalSpend : 0;

  document.getElementById("summarySpend").textContent = money(totalSpend);
  document.getElementById("summaryEarnings").textContent = money(totalEarnings);
  const profitEl = document.getElementById("summaryProfit");
  profitEl.textContent = signedMoney(totalProfit);
  profitEl.classList.toggle("positive", totalProfit >= 0);
  profitEl.classList.toggle("negative", totalProfit < 0);
  document.getElementById("summaryRoas").textContent = `${overallRoas.toFixed(2)}x`;

  const maxAbs = Math.max(1, ...withEntries.map((d) => Math.abs((d.entry.total_earnings || 0) - (d.entry.total_spend || 0))));

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
    cell.style.animationDelay = `${idx * 6}ms`;
    cell.title = dateStr;

    if (entry && !isFuture) {
      const profit = (entry.total_earnings || 0) - (entry.total_spend || 0);
      const sentiment = profit >= 0 ? "positive" : "negative";
      const pct = Math.min(45, Math.round((Math.abs(profit) / maxAbs) * 45)) + 6;
      cell.style.background = profit >= 0
        ? `color-mix(in srgb, var(--profit) ${pct}%, var(--bg-2))`
        : `color-mix(in srgb, var(--loss) ${pct}%, var(--bg-2))`;
      cell.innerHTML = `
        <span class="cal-d-daynum">${day}</span>
        <span class="cal-d-amount ${sentiment}">${signedMoney(profit)}</span>
      `;
      cell.title = `${dateStr} — net profit ${signedMoney(profit)}`;
    } else {
      cell.innerHTML = `<span class="cal-d-daynum">${day}</span>`;
    }

    grid.appendChild(cell);
  });
}
