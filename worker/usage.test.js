import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, usageWarnings, monthStartSql, logUsage } from './usage.js';

const env = {};

test('month start is the first of the current UTC month in SQL datetime format', () => {
  assert.equal(monthStartSql(Date.parse('2026-09-26T13:31:00Z')), '2026-09-01 00:00:00');
});

test('summarizes each service against its limit, with configurable limits', () => {
  const rows = summarizeUsage(
    { xPostsMonth: 40, emailsMonth: 120, emailsToday: 12, oddsRemaining: 256, xaiUsd: 3.5 },
    { X_MONTHLY_POST_LIMIT: '100', XAI_DISCOVERY_BUDGET_CEILING_USD: '18' }
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual([by.x_posts.used, by.x_posts.limit], [40, 100]);
  assert.deepEqual([by.email_month.used, by.email_month.limit], [120, 3000]);
  assert.deepEqual([by.email_day.used, by.email_day.limit], [12, 100]);
  assert.deepEqual([by.odds_credits.used, by.odds_credits.limit], [244, 500]);
  assert.deepEqual([by.xai_usd.used, by.xai_usd.limit], [3.5, 18]);
  assert.equal(by.x_posts.share, 0.4);
});

test('an unknown Odds API balance is reported as unknown, not zero', () => {
  const rows = summarizeUsage({ xPostsMonth: 0, emailsMonth: 0, emailsToday: 0, oddsRemaining: null, xaiUsd: 0 }, env);
  const odds = rows.find((r) => r.key === 'odds_credits');
  assert.equal(odds.used, null);
  assert.equal(odds.share, null);
});

test('warns at 80% of any limit and names the service', () => {
  const rows = summarizeUsage({ xPostsMonth: 410, emailsMonth: 100, emailsToday: 5, oddsRemaining: 60, xaiUsd: 1 }, env);
  const warnings = usageWarnings(rows);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.startsWith('X posts')));
  assert.ok(warnings.some((w) => w.startsWith('Odds API credits')));
});

test('logUsage never throws, even without a database', async () => {
  await logUsage({}, 'x_post');
  await logUsage({ DB: { prepare: () => { throw new Error('boom'); } } }, 'x_post');
});
