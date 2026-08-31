// Talks to the two real Netlify functions (glitchy-stats, reset-day) plus the
// new daily-totals function, and caches the last successful result in
// localStorage so the dashboard never has to render an empty state — even on
// a fresh browser with no network yet.

const CACHE_KEY = "chigla_glitchy_cache_v1";
const DAILY_CACHE_KEY = "chigla_daily_totals_cache_v1";
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

export async function postResetDay(password) {
  const res = await fetch("/.netlify/functions/reset-day", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Reset failed (${res.status})`);
    err.status = res.status;
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

// ---------------- TikTok Ads (MCP OAuth) ----------------
// Auth + advertiser discovery/selection. All token handling is server-side in
// the tiktok-* Netlify functions — nothing sensitive is returned here.

// Surfaces the function's `details` alongside `error` so failures are debuggable
// from the dashboard instead of a bare "Request failed".
async function readTiktokResponse(res, fallback) {
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  if (!res.ok || data.error) {
    const msg = data.error || `${fallback} (${res.status})`;
    const err = new Error(data.details ? `${msg} — ${data.details}` : msg);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

export async function fetchTiktokConnections() {
  const res = await fetch("/.netlify/functions/tiktok-connections");
  return readTiktokResponse(res, "Request failed"); // { connections: [...], advertisers: [...] }
}

export async function startTiktokAuth(password, label) {
  const res = await fetch("/.netlify/functions/tiktok-auth-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, label }),
  });
  return readTiktokResponse(res, "Auth start failed"); // { authorizeUrl }
}

export async function postTiktokAction(payload) {
  const res = await fetch("/.netlify/functions/tiktok-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readTiktokResponse(res, "Request failed");
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
