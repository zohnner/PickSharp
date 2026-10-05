import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyKit } from './replyKit.js';

const NOW = Date.parse('2026-10-03T16:00:00Z');
const side = (o) => ({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 1.95, best_book: 'espnbet', worst_price: 1.85, worst_book: 'betmgm', books: 6, fair_prob: 0.5, is_edge: false, ...o });
const g = (o, markets) => ({ event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals', home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z', slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04', markets, ...o });

test('two ready-to-paste lines per game from its biggest non-edge gaps, linking the board with src=x_reply', () => {
  const kit = buildReplyKit([g({}, {
    spreads: [side({}), side({ outcome: 'Jacksonville Jaguars', point: 2.5, is_edge: true, best_price: 2.2 })],
    totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.91, best_book: 'fanduel', worst_price: 1.87, worst_book: 'draftkings' })],
  })], 'https://wepicksharp.com', NOW);
  assert.equal(kit.length, 1);
  assert.equal(kit[0].url, 'https://wepicksharp.com/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply');
  assert.equal(kit[0].lines[0], 'Best price on Cincinnati Bengals -2.5 today is -105 at ESPN BET (worst -118 at BetMGM). Full board: https://wepicksharp.com/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply');
  assert.equal(kit[0].lines.length, 2);
  assert.ok(kit[0].lines.every((l) => !l.includes('Jacksonville Jaguars +2.5')), 'edge sides never appear');
});

test('only games kicking off within 36h, soonest first', () => {
  const kit = buildReplyKit([
    g({ event_id: 'late', commence_time: '2026-10-06T17:00:00Z' }, { spreads: [side({})] }),
    g({ event_id: 'soon', commence_time: '2026-10-03T19:30:00Z', slug: 'a-at-b-2026-10-03' }, { spreads: [side({})] }),
  ], 'https://wepicksharp.com', NOW);
  assert.deepEqual(kit.map((k) => k.url.includes('a-at-b')), [true]);
});
