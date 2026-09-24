// worker/edges.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEdges, closingUpdates, edgeKey, MIN_LOGGED_EV } from './edges.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

// Hand-built, shaped like a real /odds response (decimal odds).
const upcoming = {
  id: 'evt1',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-25T00:15:00Z',
  home_team: 'Green Bay Packers',
  away_team: 'Atlanta Falcons',
  bookmakers: [
    {
      key: 'pinnacle',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.25 }, { name: 'Atlanta Falcons', price: 4.5 }] },
        {
          key: 'spreads',
          outcomes: [
            { name: 'Green Bay Packers', price: 1.91, point: -7.5 },
            { name: 'Atlanta Falcons', price: 1.91, point: 7.5 },
          ],
        },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 44.5 }] }, // not 2-way: skipped
      ],
    },
    {
      key: 'fanduel',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.22 }, { name: 'Atlanta Falcons', price: 5.2 }] },
        { key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', price: 2.2, point: 7 }] }, // point mismatch
      ],
    },
    {
      key: 'draftkings',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 4.6 }] }],
    },
    {
      key: 'betmgm',
      markets: [{ key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', price: 2.08, point: 7.5 }] }],
    },
  ],
};

const started = { ...upcoming, id: 'evt0', commence_time: '2026-09-24T11:00:00Z' };

test('finds the Shin edges and nothing else', () => {
  const edges = findEdges([upcoming, started], NOW);
  const keys = edges.map((e) => `${e.book}|${e.market}|${e.outcome}|${e.point}`).sort();
  assert.deepEqual(keys, ['betmgm|spreads|Atlanta Falcons|7.5', 'fanduel|h2h|Atlanta Falcons|null']);
});

test('computes EV from the Shin fair probability', () => {
  const fd = findEdges([upcoming], NOW).find((e) => e.book === 'fanduel');
  assert.ok(Math.abs(fd.fair_prob - 0.211111) < 1e-5);
  assert.ok(Math.abs(fd.ev - (0.211111 * 5.2 - 1)) < 1e-4);
  assert.equal(fd.game, 'Atlanta Falcons @ Green Bay Packers');
  assert.equal(fd.sport, 'americanfootball_nfl');
  assert.equal(fd.commence_time, '2026-09-25T00:15:00Z');
});

test('only exact point matches count (fanduel +7 vs pinnacle +7.5 is ignored)', () => {
  const all = closingUpdates([upcoming], NOW);
  assert.ok(!all.some((c) => c.book === 'fanduel' && c.market === 'spreads'));
});

test('closingUpdates includes below-threshold comparisons so logged edges keep a current close', () => {
  const all = closingUpdates([upcoming], NOW);
  const dk = all.find((c) => c.book === 'draftkings');
  assert.ok(dk, 'draftkings h2h comparison present');
  assert.ok(dk.ev < MIN_LOGGED_EV);
});

test('skips events that have started and events without Pinnacle', () => {
  const noPin = { ...upcoming, id: 'evt2', bookmakers: upcoming.bookmakers.filter((b) => b.key !== 'pinnacle') };
  assert.equal(closingUpdates([started, noPin], NOW).length, 0);
});

test('edgeKey treats null and undefined point the same', () => {
  const base = { event_id: 'e', market: 'h2h', outcome: 'X', book: 'b' };
  assert.equal(edgeKey({ ...base, point: null }), edgeKey({ ...base, point: undefined }));
  assert.notEqual(edgeKey({ ...base, point: 7.5 }), edgeKey({ ...base, point: null }));
});
