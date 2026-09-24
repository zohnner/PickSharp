import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEdges } from './edgeReport.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const row = (o) => ({
  sport: 'americanfootball_nfl', market: 'h2h', first_price: 5.0, first_ev: 0.025,
  first_seen_at: '2026-09-24 16:01:00', last_edge_seen_at: '2026-09-24 16:01:00',
  commence_time: '2026-09-25T00:15:00Z', close_fair_prob: null, ...o,
});

test('CLV only counts games that have kicked off and have a close', () => {
  const edges = [
    row({ close_fair_prob: 0.22 }), // 5.0*0.22-1 = +0.10
    row({ close_fair_prob: 0.18 }), // 5.0*0.18-1 = -0.10
    row({ close_fair_prob: 0.30, commence_time: '2026-10-05T17:00:00Z' }), // not started: excluded
    row({ close_fair_prob: null }), // no close: excluded
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.equal(summary.clv.all.count, 2);
  assert.ok(Math.abs(summary.clv.all.avg - 0) < 1e-9);
  assert.equal(summary.clv.all.positiveShare, 0.5);
});

test('bands and the 2%+ CLV subset', () => {
  const edges = [
    row({ first_ev: 0.015, close_fair_prob: 0.25 }),
    row({ first_ev: 0.025, close_fair_prob: 0.25 }),
    row({ first_ev: 0.04, close_fair_prob: 0.25 }),
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.deepEqual(summary.byBand, { '1-2%': 1, '2-3%': 1, '3%+': 1 });
  assert.equal(summary.clv.twoPlus.count, 2);
});

test('median lifetime in minutes', () => {
  const edges = [
    row({ last_edge_seen_at: '2026-09-24 16:01:00' }), // 0
    row({ last_edge_seen_at: '2026-09-24 16:31:00' }), // 30
    row({ last_edge_seen_at: '2026-09-24 18:01:00' }), // 120
  ];
  assert.equal(summarizeEdges(edges, [], NOW).summary.medianLifetimeMinutes, 30);
});

test('reports skipped scans by reason so missing data is visible', () => {
  const scans = [
    { kind: 'discovery', ran: 1, reason: null },
    { kind: 'discovery', ran: 0, reason: 'budget' },
    { kind: 'closing', ran: 0, reason: 'budget' },
  ];
  const { summary } = summarizeEdges([], scans, NOW);
  assert.deepEqual(summary.scans, { ran: 1, skipped: { budget: 2 } });
});

test('empty input gives nulls, not NaN', () => {
  const { summary, recent } = summarizeEdges([], [], NOW);
  assert.equal(summary.total, 0);
  assert.equal(summary.clv.all.avg, null);
  assert.equal(summary.medianLifetimeMinutes, null);
  assert.deepEqual(recent, []);
});
