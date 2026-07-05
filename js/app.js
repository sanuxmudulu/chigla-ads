import { mockAccounts, mockSourceProfile } from "./mock.js";
import {
  fetchGlitchyStats,
  postResetDay,
  fetchDailyTotals,
  loadCache,
  loadAccounts,
  saveAccounts,
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
// "today" needs to mean the same calendar date the backend uses — otherwise
// the date picker and the session logic in glitchy-stats.js can disagree
// right around midnight.
function todayStr() {
  const est = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${est.getFullYear()}-${String(est.getMonth() + 1).padStart(2, "0")}-${String(est.getDate()).padStart(2, "0")}`;
}
const money = (n) => `$${(n || 0).toFixed(2)}`;
const num = (n) => (n || 0).toLocaleString("en-US");

const state = {
  date: todayStr(),
  sources: [],
  raw: [],
  chartSource: "__all__",
  hasFetchedOnce: false,
  prevConversions: new Map(),
  baseSpendTotal: 0,
  baseEarningsTotal: 0,
  expandedSources: new Set(),
  sessionInfo: { extended: false },
};

let lastUpdatedAt = null;
let mainChartCanvas = null;

// ============================== INIT ==============================

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("datePicker").value = state.date;

  initTheme(() => {
    // Chart colors are read from CSS vars at creation time — rebuild on theme swap.
    renderChart();
  });

  mainChartCanvas = document.getElementById("mainChart");

  renderFromCacheOrFallback();
  renderAccounts();
  wireEvents();
  startTimers();
  refreshAll();
});

function renderFromCacheOrFallback() {
  const cache = loadCache();
  if (cache && cache.data && cache.data.sources && cache.data.sources.length) {
    applyGlitchyResponse(cache.data, { flagNewConversions: false });
    lastUpdatedAt = cache.savedAt || Date.now();
  } else {
    applyGlitchyResponse(
      { startDate: state.date, endDate: state.date, sources: fallbackSources(), raw: [] },
      { flagNewConversions: false }
    );
    lastUpdatedAt = Date.now();
  }
  renderCalendarFallback();
}

// ============================== EVENTS ==============================

function wireEvents() {
  document.getElementById("datePicker").addEventListener("change", (e) => {
    state.date = e.target.value;
    refreshAll();
  });

  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll(true));

  document.getElementById("resetDayBtn").addEventListener("click", async () => {
    if (!confirm("This locks in current numbers as the new baseline for today. Sure you want to reset?")) return;
    const btn = document.getElementById("resetDayBtn");
    btn.disabled = true;
    btn.textContent = "Resetting...";
    try {
      const result = await postResetDay();
      setStatus(result.message || "Reset complete.");
      await refreshAll(true);
    } catch (err) {
      setStatus(`Reset failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Reset Day";
    }
  });

  document.getElementById("chartSourceSelect").addEventListener("change", (e) => {
    state.chartSource = e.target.value;
    renderChart();
  });

  document.getElementById("manageAccountsBtn").addEventListener("click", openDrawer);
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);

  document.getElementById("addAccountBtn").addEventListener("click", () => {
    document.getElementById("newAccountName").value = "";
    document.getElementById("addAccountModal").classList.add("open");
  });
  document.getElementById("cancelAddAccount").addEventListener("click", () => {
    document.getElementById("addAccountModal").classList.remove("open");
  });
  document.getElementById("confirmAddAccount").addEventListener("click", () => {
    const name = document.getElementById("newAccountName").value.trim();
    if (!name) return;
    const accounts = loadAccounts(mockAccounts());
    accounts.push({ id: `acc_${Date.now()}`, name, status: "active" });
    saveAccounts(accounts);
    renderAccounts();
    document.getElementById("addAccountModal").classList.remove("open");
  });

  document.getElementById("sourcesBody").addEventListener("click", (e) => {
    const row = e.target.closest("tr.source-row");
    if (!row) return;
    toggleRowExpand(row.dataset.source);
  });
}

function startTimers() {
  // "last updated Xs ago" ticker
  setInterval(() => {
    const el = document.getElementById("lastUpdated");
    if (!lastUpdatedAt) return;
    const secs = Math.floor((Date.now() - lastUpdatedAt) / 1000);
    el.textContent = secs < 2 ? "updated just now" : secs < 60 ? `updated ${secs}s ago` : `updated ${Math.floor(secs / 60)}m ago`;
  }, 1000);

  // Auto-refresh real data periodically
  setInterval(() => refreshAll(), 60000);
}

// ============================== DATA FETCH ==============================

async function refreshAll(userTriggered) {
  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.classList.add("spinning");
  try {
    const data = await fetchGlitchyStats(state.date, state.date);
    applyGlitchyResponse(data, { flagNewConversions: state.hasFetchedOnce });
    state.hasFetchedOnce = true;
    lastUpdatedAt = Date.now();
    setStatus(null);
  } catch (err) {
    setStatus(`Couldn't reach Glitchy: ${err.message} — showing last known data.`, true);
  } finally {
    refreshBtn.classList.remove("spinning");
  }

  try {
    const month = state.date.slice(0, 7);
    const daily = await fetchDailyTotals(month);
    renderCalendar(daily);
  } catch (err) {
    renderCalendarFallback();
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
  const dateStr = state.date;

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
  // If we haven't clicked Reset Day since before today, glitchy-stats.js
  // extends the query back to the last reset so the current session's
  // numbers aren't clipped at midnight — surface that here so the totals
  // aren't mistaken for a single calendar day.
  state.sessionInfo = data.session_extended
    ? { extended: true, startDate: data.startDate, endDate: data.endDate }
    : { extended: false };

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

// ============================== KPI STRIP ==============================

function renderKpis() {
  const totalSpend = state.baseSpendTotal; // always 0 until TikTok is wired in
  const totalEarnings = state.baseEarningsTotal;
  const netProfit = totalEarnings - totalSpend;
  const roas = 0;
  const cpa = 0;

  setKpi("kpiSpend", money(totalSpend));
  setKpi("kpiEarnings", money(totalEarnings));
  setKpi("kpiProfit", (netProfit >= 0 ? "+" : "-") + money(Math.abs(netProfit)), netProfit >= 0 ? "positive" : "negative");
  setKpi("kpiRoas", `${roas.toFixed(2)}x`);
  setKpi("kpiCpa", money(cpa));
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

  const metaEl = document.getElementById("tableMeta");
  if (state.sessionInfo.extended) {
    metaEl.textContent = `${sorted.length} sources — session since ${state.sessionInfo.startDate} (no Reset Day since then)`;
  } else {
    metaEl.textContent = `${sorted.length} sources — ${state.date}`;
  }
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

function currentHourLimit() {
  if (state.date !== todayStr()) return 24;
  return new Date().getHours() + 1;
}

function renderChart() {
  if (!mainChartCanvas || !window.Chart) return;
  const limit = currentHourLimit();
  const hourLabels = Array.from({ length: limit }, (_, h) => `${String(h).padStart(2, "0")}:00`);

  // Spend has no hourly shape until TikTok is connected — a flat 0 line
  // rather than an invented curve.
  const spendBuckets = Array(limit).fill(0);
  let earningsBuckets;

  if (state.chartSource === "__all__") {
    earningsBuckets = hourlyPayoutCombined().slice(0, limit);
  } else {
    const { values } = hourlyPayoutForSource(state.chartSource);
    earningsBuckets = values.slice(0, limit);
  }

  createMainChart(mainChartCanvas, hourLabels, earningsBuckets, spendBuckets);
}

// ============================== ACCOUNTS DRAWER ==============================

function renderAccounts() {
  const accounts = loadAccounts(mockAccounts());
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
      <button class="account-remove" data-id="${acc.id}">Remove</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll(".account-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const remaining = loadAccounts(mockAccounts()).filter((a) => a.id !== btn.dataset.id);
      saveAccounts(remaining);
      renderAccounts();
    });
  });
}

function openDrawer() {
  document.getElementById("accountsDrawer").classList.add("open");
  document.getElementById("drawerBackdrop").classList.add("open");
}
function closeDrawer() {
  document.getElementById("accountsDrawer").classList.remove("open");
  document.getElementById("drawerBackdrop").classList.remove("open");
}

// ============================== PROFIT CALENDAR ==============================

function renderCalendarFallback() {
  const month = state.date.slice(0, 7);
  renderCalendar({ month, days: [] });
}

function renderCalendar(daily) {
  const month = daily.month || state.date.slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstWeekday = new Date(year, mon - 1, 1).getDay();
  const todayIso = todayStr();

  const rowsByDate = new Map((daily.days || []).map((d) => [d.date, d]));

  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = "";

  document.getElementById("calendarMonthLabel").textContent = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  // Only real rows from `daily_totals` get colored/labeled — days with no
  // recorded row (before this dashboard existed, or a gap) render blank
  // rather than an invented number.
  const computed = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isFuture = dateStr > todayIso;
    computed.push({ dateStr, day: d, isFuture, entry: rowsByDate.get(dateStr) || null });
  }

  const maxAbs = Math.max(1, ...computed.filter((c) => c.entry).map((c) => Math.abs((c.entry.total_earnings || 0) - (c.entry.total_spend || 0))));

  for (let i = 0; i < firstWeekday; i++) {
    const filler = document.createElement("div");
    filler.className = "cal-cell empty";
    grid.appendChild(filler);
  }

  computed.forEach(({ dateStr, day, isFuture, entry }, idx) => {
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (isFuture ? " future" : "") + (dateStr === todayIso ? " today" : "");
    cell.style.animationDelay = `${idx * 8}ms`;
    cell.title = dateStr;

    if (entry && !isFuture) {
      const profit = (entry.total_earnings || 0) - (entry.total_spend || 0);
      const pct = Math.min(85, Math.round((Math.abs(profit) / maxAbs) * 85)) + 10;
      cell.style.background = profit >= 0
        ? `color-mix(in srgb, var(--profit) ${pct}%, var(--bg-2))`
        : `color-mix(in srgb, var(--loss) ${pct}%, var(--bg-2))`;
      cell.innerHTML = `<span class="cal-daynum">${day}</span><span class="cal-profit">${compactProfit(profit)}</span>`;
      cell.title = `${dateStr} — profit ${profit >= 0 ? "+" : ""}${money(profit)}`;
    } else {
      cell.style.background = "var(--bg-2)";
      cell.innerHTML = `<span class="cal-daynum">${day}</span>`;
    }

    grid.appendChild(cell);
  });
}

function compactProfit(n) {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : Math.round(abs).toString();
  return `${sign}${body}`;
}
