import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPriceGapTick, centsGap, selectPriceGaps, composePriceGapTweet } from './priceGaps.js';
import { tweetLength } from './x.js';

const NOW = Date.parse('2026-10-03T16:11:00Z');
const side = (o) => ({ outcome: 'Cincinnati Bengals', point: null, best_price: 1.8, best_book: 'fanduel', worst_price: 1.69, worst_book: 'betmgm', books: 5, fair_prob: 0.55, is_edge: false, ...o });
const game = (o, markets) => ({
  event_id: 'e1', sport: 'americanfootball_nfl', home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars',
  commence_time: '2026-10-04T17:00:00Z', slug: 's', markets, ...o,
});

test('fires daily at 16:11 UTC only', () => {
  assert.equal(isPriceGapTick(Date.parse('2026-10-03T16:11:00Z')), true);
  assert.equal(isPriceGapTick(Date.parse('2026-10-03T16:06:00Z')), false);
});

test('cents are measured across the even-money line', () => {
  assert.equal(centsGap(1.8, 1.69), 20); // -125 vs -145
  assert.equal(centsGap(2.05, 1.95), 10); // +105 vs -105
  assert.equal(centsGap(2.5, 2.3), 20); // +150 vs +130
});

test('picks the biggest same-bet gaps of 15+ cents, skipping edges and far-off games', () => {
  const games = [
    game({}, {
      h2h: [side({}), side({ outcome: 'Jacksonville Jaguars', best_price: 2.25, best_book: 'draftkings', worst_price: 2.1, worst_book: 'fanduel' })],
      spreads: [side({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 2.1, is_edge: true, worst_price: 1.8 })],
    }),
    game({ event_id: 'e2', home_team: 'Ohio State Buckeyes', away_team: 'Iowa Hawkeyes', commence_time: '2026-10-03T19:30:00Z' }, {
      totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.95, best_book: 'williamhill_us', worst_price: 1.82, worst_book: 'draftkings' })],
    }),
    game({ event_id: 'e3', commence_time: '2026-10-06T17:00:00Z' }, { h2h: [side({ best_price: 2.5, worst_price: 1.5 })] }),
  ];
  const gaps = selectPriceGaps(games, NOW);
  // Ranked by implied-probability gap: Over 0.0366, Bengals ML 0.0362, Jaguars ML 0.0317.
  assert.deepEqual(gaps.map((g) => [g.game.event_id, g.side.outcome]), [['e2', 'Over'], ['e1', 'Cincinnati Bengals'], ['e1', 'Jacksonville Jaguars']]);
  // The Jaguars gap is exactly 15 cents (+125 vs +110) and qualifies; raising the bar drops everything.
  assert.equal(selectPriceGaps(games, NOW, { minCents: 21 }).length, 0);
});

test('the tweet names the bet, both prices and books, with no link', () => {
  const gaps = selectPriceGaps([game({}, { h2h: [side({})], totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.95, best_book: 'williamhill_us', worst_price: 1.82, worst_book: 'draftkings' })] })], NOW);
  const t = composePriceGapTweet(gaps);
  assert.match(t, /^Same bet, different price 👇/);
  assert.match(t, /Cincinnati Bengals ML: -125 FanDuel \/ -145 BetMGM/);
  assert.match(t, /Over 47.5 \(Jaguars @ Bengals\): -105 Caesars \/ -122 DraftKings/);
  assert.doesNotMatch(t, /https?:/);
  assert.ok(tweetLength(t) <= 280);
});
