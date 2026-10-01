// Pure scheduling logic: which video goes to which account in which session.
// Ported from chigla-organic/lib/schedule.ts.

function validateConfig(c) {
  if (c.clips < 2) throw new Error("Need at least 2 clips to avoid back-to-back repeats");
  if (c.accounts > c.clips) throw new Error("More accounts than clips: accounts in one session would share a clip");
  if (c.sessionTimes.length > c.hooks)
    throw new Error("More sessions per day than hook variants: hooks would repeat within a day");
  for (const t of c.sessionTimes)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Bad session time "${t}"`);
}

function slotFor(c, day, session, account) {
  return { clip: (account + session + day) % c.clips, hook: (session + day) % c.hooks };
}

function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - utcMs;
}

function zonedToUtcIso(date, time, timeZone) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone);
  return new Date(utc).toISOString().replace(".000Z", "Z");
}

function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function buildPlan(c, startDate, days, startDayIndex = 0) {
  validateConfig(c);
  const out = [];
  for (let day = 0; day < days; day++) {
    const localDate = addDays(startDate, day);
    c.sessionTimes.forEach((time, session) => {
      for (let account = 0; account < c.accounts; account++) {
        const { clip, hook } = slotFor(c, startDayIndex + day, session, account);
        const base = zonedToUtcIso(localDate, time, c.timeZone);
        const publishAt = new Date(Date.parse(base) + account * c.staggerMinutes * 60_000)
          .toISOString()
          .replace(".000Z", "Z");
        out.push({ day, session, account, clip, hook, publishAt });
      }
    });
  }
  return out;
}

const DEFAULT_SCHEDULE = {
  accounts: 5,
  clips: 5,
  hooks: 5,
  sessionTimes: ["07:00", "10:00", "13:00", "18:00", "21:00"],
  staggerMinutes: 5,
  timeZone: "Australia/Sydney",
};

module.exports = { validateConfig, slotFor, zonedToUtcIso, buildPlan, DEFAULT_SCHEDULE };
