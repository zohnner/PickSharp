import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getUpcomingOdds, resetOddsCacheForTests, fetchSharpComparison, getRemainingCredits, EDGE_SPORTS } from './oddsApi.js';

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

test('sharp comparison names pinnacle + US books, decimal odds, and a 7-day window', async () => {
  await fetchSharpComparison(env, 'americanfootball_nfl', Date.parse('2026-09-24T16:01:00Z'));
  const url = calls.at(-1);
  assert.match(url, /\/sports\/americanfootball_nfl\/odds\?/);
  assert.match(url, /bookmakers=pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,hardrockbet/);
  assert.match(url, /markets=h2h,spreads,totals/);
  assert.match(url, /oddsFormat=decimal/);
  assert.match(url, /commenceTimeTo=2026-10-01T16:01:00Z/);
  assert.doesNotMatch(url, /regions=/);
});

test('bookmaker list stays within 10 so it bills as one region', async () => {
  await fetchSharpComparison(env, 'americanfootball_nfl', Date.now());
  const books = new URL(calls.at(-1)).searchParams.get('bookmakers').split(',');
  assert.ok(books.length <= 10);
});

test('remaining credits come from the free /sports endpoint header', async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('[]', { status: 200, headers: { 'x-requests-remaining': '321' } });
  };
  assert.equal(await getRemainingCredits(env), 321);
  assert.match(calls.at(-1), /\/v4\/sports\?apiKey=/);
});

test('remaining credits is null when the call fails', async () => {
  globalThis.fetch = async () => { throw new Error('network'); };
  assert.equal(await getRemainingCredits(env), null);
});

test('edge sports are NFL and NCAAF only', () => {
  assert.deepEqual(EDGE_SPORTS, ['americanfootball_nfl', 'americanfootball_ncaaf']);
});
