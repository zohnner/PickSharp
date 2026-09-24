// Timing and budget rules for the edge logger on The Odds API's free 500-credit plan.
// Derived from event.scheduledTime, never event.cron (undocumented format).

export const CREDITS_PER_SPORT_SCAN = 3; // h2h+spreads+totals, <=10 named bookmakers = 1 region
export const DEFAULT_RESERVE = 30; // floor: credits always left for the AI pick pipeline
export const DEFAULT_CREDITS_PER_DAY = 18; // pipeline's average daily Odds API spend
export const DEFAULT_QUOTA_RESET_DAY = 1; // day-of-month (UTC) the Odds API's free plan resets

const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;

export function toFeedIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The 1,6,...,56 cron only. The 0,15,30 generation cron also reaches scheduled()'s
// fallback branch; scanning on its ticks too would double-scan kickoffs.
export function isEdgeTick(ms) {
  return new Date(ms).getUTCMinutes() % 5 === 1;
}

export function isDiscoveryTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 16 && d.getUTCMinutes() === 1;
}

// Ticks are 5 minutes apart and the window is 5 minutes wide, so every kickoff lands in
// exactly one window -- one closing scan, taken 10-15 minutes before kickoff.
export function closingWindow(ms) {
  return { fromIso: toFeedIso(ms + 10 * MINUTE), toIso: toFeedIso(ms + 15 * MINUTE) };
}

export function withinBudget(remaining, sportsCount, reserve) {
  if (!Number.isFinite(remaining)) return false;
  return remaining - CREDITS_PER_SPORT_SCAN * sportsCount >= reserve;
}

export function parsePositiveInt(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

export function parseReserve(raw) {
  return parsePositiveInt(raw, DEFAULT_RESERVE);
}

// A flat reserve doesn't protect the AI pipeline: early in the Odds API's billing cycle a
// flat floor lets edge scans drain every credit above it, starving the pipeline for the
// rest of the month. Instead, the reserve scales with how many days of pipeline spend are
// still ahead before the monthly quota resets, and never drops below the floor.
function nextResetMs(nowMs, resetDay) {
  const day = Math.min(28, Math.max(1, resetDay));
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisMonth = Date.UTC(y, m, day, 0, 0, 0, 0);
  return thisMonth > nowMs ? thisMonth : Date.UTC(y, m + 1, day, 0, 0, 0, 0);
}

export function effectiveReserve(nowMs, { floor, perDay, resetDay }) {
  const daysUntilReset = (nextResetMs(nowMs, resetDay) - nowMs) / DAY_MS;
  return Math.max(floor, Math.ceil(perDay * daysUntilReset));
}
