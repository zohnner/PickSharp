import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getUpcomingOdds, resetOddsCacheForTests } from './oddsApi.js';

let calls;
beforeEach(() => {
  calls = [];
  resetOddsCacheForTests();
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([{ id: String(calls.length) }]), { status: 200 });
  };
});

const env = { ODDS_API_KEY: 'k' };

test('reuses the fetched odds within the cache window instead of paying for them twice', async () => {
  const t0 = Date.parse('2026-09-24T13:00:00Z');
  const first = await getUpcomingOdds(env, { nowMs: t0 });
  const callsAfterFirst = calls.length;
  const second = await getUpcomingOdds(env, { nowMs: t0 + 5 * 60 * 1000 });
  assert.equal(calls.length, callsAfterFirst);
  assert.deepEqual(second, first);
});

test('refetches once the cache window has passed', async () => {
  const t0 = Date.parse('2026-09-24T13:00:00Z');
  await getUpcomingOdds(env, { nowMs: t0 });
  const callsAfterFirst = calls.length;
  await getUpcomingOdds(env, { nowMs: t0 + 11 * 60 * 1000 });
  assert.equal(calls.length, callsAfterFirst * 2);
});

test('limits each request to games kicking off within 3 days, so off-season sports cost nothing', async () => {
  await getUpcomingOdds(env, { nowMs: Date.parse('2026-09-24T13:00:00Z') });
  assert.ok(calls.length > 0);
  for (const url of calls) {
    assert.match(url, /commenceTimeTo=2026-09-27T13:00:00Z/);
  }
});
