// One day's posting plan (25 posts), for the organic dashboard's Schedule page.
// Settings are hardcoded here until the Supabase settings table exists.
const { buildPlan, DEFAULT_SCHEDULE } = require("./_shared/organic-schedule");

exports.handler = async function () {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_SCHEDULE.timeZone }).format(new Date());
  const plan = buildPlan(DEFAULT_SCHEDULE, today, 1);
  return { statusCode: 200, body: JSON.stringify({ today, timeZone: DEFAULT_SCHEDULE.timeZone, plan }) };
};
