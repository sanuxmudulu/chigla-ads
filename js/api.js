// Talks to the two real Netlify functions (glitchy-stats, reset-day) plus the
// new daily-totals function, and caches the last successful result in
// localStorage so the dashboard never has to render an empty state — even on
// a fresh browser with no network yet.

const CACHE_KEY = "chigla_glitchy_cache_v1";
const DAILY_CACHE_KEY = "chigla_daily_totals_cache_v1";
const ACCOUNTS_KEY = "chigla_accounts_v1";
const THEME_KEY = "chigla_theme_v1";

export async function fetchGlitchyStats(startDate, endDate) {
  const res = await fetch(`/.netlify/functions/glitchy-stats?startDate=${startDate}&endDate=${endDate}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details || data.message;
    throw err;
  }
  saveCache(startDate, endDate, data);
  return data;
}

export async function postResetDay() {
  const res = await fetch("/.netlify/functions/reset-day", { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Reset failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

export async function fetchDailyTotals(month) {
  const res = await fetch(`/.netlify/functions/daily-totals?month=${month}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  saveDailyCache(month, data);
  return data;
}

function saveCache(startDate, endDate, data) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ startDate, endDate, data, savedAt: Date.now() })
    );
  } catch (_) {
    /* localStorage unavailable — non-fatal, just skip caching */
  }
}

export function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveDailyCache(month, data) {
  try {
    localStorage.setItem(DAILY_CACHE_KEY, JSON.stringify({ month, data, savedAt: Date.now() }));
  } catch (_) {}
}

export function loadDailyCache() {
  try {
    const raw = localStorage.getItem(DAILY_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ---------------- Mock ad accounts persistence (UI-only, no backend) ----------------

export function loadAccounts(defaults) {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  saveAccounts(defaults);
  return defaults;
}

export function saveAccounts(accounts) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch (_) {}
}

// ---------------- Theme persistence ----------------

export function loadTheme(defaultTheme) {
  try {
    return localStorage.getItem(THEME_KEY) || defaultTheme;
  } catch (_) {
    return defaultTheme;
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
}
