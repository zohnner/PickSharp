import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, americanOdds } from './record.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const FINAL = { home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons', home_score: 27, away_score: 20, result_status: 'final' };
let nextId = 1;
const edge = (over) => ({
  id: nextId++,
  event_id: 'ev1',
  sport: 'americanfootball_nfl',
  game: 'Atlanta Falcons @ Green Bay Packers',
  commence_time: '2026-09-25T00:15:00Z',
  market: 'h2h',
  outcome: 'Green Bay Packers',
  point: null,
  book: 'draftkings',
  first_price: 2.0,
  first_ev: 0.025,
  close_fair_prob: null,
  close_updated_at: null,
  ...FINAL,
  ...over,
});

test('americanOdds converts decimal prices', () => {
  assert.equal(americanOdds(2.5), 150);
  assert.equal(americanOdds(2.0), 100);
  assert.equal(americanOdds(1.5), -200);
  assert.equal(americanOdds(1), null);
});

test('future games are never exposed', () => {
  const rec = buildRecord([edge({ commence_time: '2026-09-29T00:15:00Z', result_status: null })], NOW);
  assert.equal(rec.edges.length, 0);
});

test('the same selection at several books counts once, at the best edge', () => {
  const rec = buildRecord([edge({ book: 'fanduel', first_ev: 0.012 }), edge({ book: 'draftkings', first_ev: 0.03 })], NOW);
  assert.equal(rec.edges.length, 1);
  assert.equal(rec.edges[0].book, 'DraftKings');
});

test('grades, units and score come from the stored final', () => {
  const rec = buildRecord([edge({ first_price: 2.5 }), edge({ outcome: 'Atlanta Falcons', first_price: 1.8, first_ev: 0.015 })], NOW);
  const [gb, atl] = rec.edges;
  assert.equal(gb.grade, 'win');
  assert.equal(gb.units, 1.5);
  assert.equal(gb.score, '20-27');
  assert.equal(gb.selection, 'Green Bay Packers ML');
  assert.equal(atl.grade, 'loss');
  assert.equal(atl.units, -1);
});

test('games without a result are pending; unmatched ones are void and excluded from units', () => {
  const rec = buildRecord(
    [edge({ event_id: 'a', result_status: null }), edge({ event_id: 'b', result_status: 'unmatched', home_score: null, away_score: null })],
    NOW
  );
  assert.deepEqual(rec.edges.map((e) => e.grade).sort(), ['pending', 'void']);
  assert.equal(rec.summary.all.units, 0);
  assert.equal(rec.summary.all.pending, 1);
});

test('summary splits the publish bar from everything logged, with ROI and CLV', () => {
  const rec = buildRecord(
    [
      edge({ event_id: 'a', first_price: 2.2, first_ev: 0.03, close_fair_prob: 0.5, close_updated_at: '2026-09-25 00:05:00' }),
      edge({ event_id: 'b', outcome: 'Atlanta Falcons', first_ev: 0.012 }),
    ],
    NOW
  );
  assert.equal(rec.summary.bar.edges, 1);
  assert.equal(rec.summary.bar.wins, 1);
  assert.ok(Math.abs(rec.summary.bar.units - 1.2) < 1e-9);
  assert.ok(Math.abs(rec.summary.bar.clv.avg - 0.1) < 1e-9);
  assert.equal(rec.summary.all.edges, 2);
  assert.equal(rec.summary.all.losses, 1);
  assert.ok(Math.abs(rec.summary.all.roi - 0.1) < 1e-9);
});

test('a close written long before kickoff does not count as CLV', () => {
  const rec = buildRecord([edge({ close_fair_prob: 0.5, close_updated_at: '2026-09-24 12:00:00' })], NOW);
  assert.equal(rec.edges[0].clv, null);
});
