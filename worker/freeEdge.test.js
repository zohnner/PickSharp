import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreeEdgeTick, selectFreeEdge, composeFreeEdgeTweet } from './freeEdge.js';
import { tweetLength } from './x.js';

const NOW = Date.parse('2026-09-27T16:06:00Z'); // Sunday, 5 min after the discovery scan
const row = (o) => ({
  id: 1, event_id: 'e1', sport: 'americanfootball_nfl', game: 'Arizona Cardinals @ San Francisco 49ers',
  commence_time: '2026-09-27T20:05:00Z', market: 'spreads', outcome: 'Arizona Cardinals', point: 7.5,
  book: 'fanduel', first_price: 1.95, first_fair_prob: 0.53, first_ev: 0.0335,
  first_seen_at: '2026-09-27 16:01:30', ...o,
});

test('fires daily at 16:06 UTC only', () => {
  assert.equal(isFreeEdgeTick(NOW), true);
  assert.equal(isFreeEdgeTick(Date.parse('2026-09-27T16:01:00Z')), false);
});

test('picks the biggest fresh 2%+ edge that kicks off in 30 min to 48 h', () => {
  const pick = selectFreeEdge(
    [
      row({ id: 1 }),
      row({ id: 2, first_ev: 0.05, commence_time: '2026-09-27T16:20:00Z' }), // kicks off in 14 min
      row({ id: 3, first_ev: 0.06, commence_time: '2026-10-01T00:15:00Z' }), // 3+ days out
      row({ id: 4, first_ev: 0.07, first_seen_at: '2026-09-26 16:01:30' }), // yesterday's price, may be stale
      row({ id: 5, first_ev: 0.015 }), // below the bar
      row({ id: 6, first_ev: 0.09, market: 'h2h', point: null, first_price: 4.5 }), // +350 longshot
      row({ id: 7, first_ev: 0.04, market: 'h2h', point: null, first_price: 2.6, outcome: 'Arizona Cardinals' }), // +160
    ],
    NOW
  );
  assert.equal(pick.id, 7);
});

test('nothing qualifying means no free edge', () => {
  assert.equal(selectFreeEdge([row({ first_ev: 0.01 })], NOW), null);
  assert.equal(selectFreeEdge([], NOW), null);
});

test('tweet shows the bet, book, our price vs the fair price, kickoff in ET, and the RG line', () => {
  const tweet = composeFreeEdgeTweet(row(), 'https://wepicksharp.com');
  assert.match(tweet, /Arizona Cardinals \+7\.5 \(-105\) at FanDuel/);
  assert.match(tweet, /Fair price -113/); // 1 / 0.53 = 1.887 decimal
  assert.match(tweet, /\+3\.4% edge/);
  assert.match(tweet, /Arizona Cardinals @ San Francisco 49ers/);
  assert.match(tweet, /NFL · Sun 4:05 PM ET/);
  // A total names no team, so the matchup line is what says which game it is.
  const total = composeFreeEdgeTweet(
    row({ market: 'totals', outcome: 'Under', point: 54.5, game: 'Texas Longhorns @ Tennessee Volunteers' }),
    'https://wepicksharp.com'
  );
  assert.match(total, /Under 54\.5[\s\S]*Texas Longhorns @ Tennessee Volunteers/);
  assert.ok(tweetLength(total) <= 280, `length ${tweetLength(total)}`);
  assert.match(tweet, /record\?ref=x_free_edge/);
  assert.match(tweet, /1-800-GAMBLER/);
  assert.ok(tweetLength(tweet) <= 280, `length ${tweetLength(tweet)}`);
});

test('very long team names drop optional copy but keep the bet, matchup, link and RG line', () => {
  const long = row({
    outcome: 'Middle Tennessee Blue Raiders', point: 10.5, book: 'hardrockbet',
    game: 'Louisiana-Monroe Warhawks @ Middle Tennessee Blue Raiders', sport: 'americanfootball_ncaaf',
  });
  const tweet = composeFreeEdgeTweet(long, 'https://wepicksharp.com');
  assert.ok(tweetLength(tweet) <= 280, `length ${tweetLength(tweet)}`);
  assert.match(tweet, /Middle Tennessee Blue Raiders \+10\.5/);
  assert.match(tweet, /Louisiana-Monroe Warhawks @ Middle Tennessee Blue Raiders/);
  assert.match(tweet, /ref=x_free_edge/);
  assert.match(tweet, /1-800-GAMBLER/);
});

test('tweetLength counts links as 23 like X does', () => {
  assert.equal(tweetLength('see https://wepicksharp.com/record?ref=x_free_edge'), 4 + 23);
});
