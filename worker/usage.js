// Usage of every rate-limited or paid API, against its free-plan limit, so a quota runs
// out on a chart instead of by surprise. X posts and emails are logged here as they
// happen; Odds API credits come from the balance header and xAI spend from its own log.

// Free-plan limits and budgets, overridable in wrangler.toml [vars] if a plan changes.
const DEFAULT_LIMITS = {
  // X API is pay-per-use: no post cap, just a monthly dollar budget we choose.
  X_MONTHLY_BUDGET_USD: 25,
  X_PRICE_POST_USD: 0.015,
  X_PRICE_POST_LINK_USD: 0.2,
  RESEND_MONTHLY_LIMIT: 3000,
  RESEND_DAILY_LIMIT: 100,
  ODDS_API_MONTHLY_CREDITS: 500,
  XAI_DISCOVERY_BUDGET_CEILING_USD: 18,
};
const limit = (env, key) => {
  const n = Number(env[key] ?? DEFAULT_LIMITS[key]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMITS[key];
};

export const WARN_SHARE = 0.8;

// Never throws: a failed usage write must not fail the post or email it's counting.
export async function logUsage(env, service, units = 1) {
  try {
    if (!env.DB) return;
    await env.DB.prepare('INSERT INTO api_usage (service, units) VALUES (?, ?)').bind(service, units).run();
  } catch (err) {
    console.error(`[usage] could not log ${service}:`, err.message);
  }
}

export function monthStartSql(nowMs) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
}

// counts: { xPlainMonth, xLinkMonth, emailsMonth, emailsToday, oddsRemaining (null if unknown), xaiUsd }
export function summarizeUsage(counts, env) {
  const oddsLimit = limit(env, 'ODDS_API_MONTHLY_CREDITS');
  // X bills a post with a link at ~13x a plain one (docs.x.com pricing, Sep 2026).
  const xSpend =
    counts.xPlainMonth * limit(env, 'X_PRICE_POST_USD') + counts.xLinkMonth * limit(env, 'X_PRICE_POST_LINK_USD');
  const row = (key, label, used, lim, period, unit = '') => ({
    key,
    label,
    used,
    limit: lim,
    period,
    unit,
    share: used == null ? null : used / lim,
  });
  return [
    row(
      'x_spend',
      `X API spend (${counts.xPlainMonth + counts.xLinkMonth} posts, ${counts.xLinkMonth} with links)`,
      xSpend,
      limit(env, 'X_MONTHLY_BUDGET_USD'),
      'this calendar month (estimate)',
      '$'
    ),
    row('email_month', 'Emails (Resend)', counts.emailsMonth, limit(env, 'RESEND_MONTHLY_LIMIT'), 'this calendar month'),
    row('email_day', 'Emails today (Resend)', counts.emailsToday, limit(env, 'RESEND_DAILY_LIMIT'), 'today (UTC)'),
    row(
      'odds_credits',
      'Odds API credits',
      counts.oddsRemaining == null ? null : Math.max(0, oddsLimit - counts.oddsRemaining),
      oddsLimit,
      'since the last quota reset'
    ),
    row('xai_usd', 'xAI tweet discovery', counts.xaiUsd, limit(env, 'XAI_DISCOVERY_BUDGET_CEILING_USD'), 'lifetime', '$'),
  ];
}

export function usageWarnings(rows, share = WARN_SHARE) {
  const fmt = (r, n) => (r.unit === '$' ? `$${n.toFixed(2)}` : `${Math.round(n)}`);
  return rows
    .filter((r) => r.share != null && r.share >= share)
    .map((r) => `${r.label}: ${fmt(r, r.used)} of ${fmt(r, r.limit)} ${r.period} (${Math.round(r.share * 100)}%)`);
}

// Reads every counter in one place so the admin panel and the daily alert agree.
export async function loadUsage(env, nowMs, getRemainingCredits) {
  const sum = (service, since) =>
    env.DB.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM api_usage WHERE service = ? AND created_at >= ?')
      .bind(service, since)
      .first()
      .then((r) => r?.n ?? 0);
  const today = new Date(nowMs).toISOString().slice(0, 10) + ' 00:00:00';
  const month = monthStartSql(nowMs);
  const [xPlainMonth, xLinkMonth, emailsMonth, emailsToday, xai, oddsRemaining] = await Promise.all([
    sum('x_post', month),
    sum('x_post_link', month),
    sum('email', month),
    sum('email', today),
    env.DB.prepare('SELECT COALESCE(SUM(estimated_usd), 0) AS total FROM xai_spend_log').first(),
    getRemainingCredits(env),
  ]);
  return summarizeUsage(
    { xPlainMonth, xLinkMonth, emailsMonth, emailsToday, oddsRemaining, xaiUsd: xai?.total ?? 0 },
    env
  );
}
