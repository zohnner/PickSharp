import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEdges, findProofGaps, isProofCheckTick } from './edgeReport.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const row = (o) => ({
  sport: 'americanfootball_nfl', market: 'h2h', first_price: 5.0, first_ev: 0.025,
  first_seen_at: '2026-09-24 16:01:00', last_edge_seen_at: '2026-09-24 16:01:00',
  commence_time: '2026-09-25T00:15:00Z', close_fair_prob: null,
  close_updated_at: '2026-09-25 00:03:00', // 12 min before kickoff: valid by default
  ...o,
});

test('CLV only counts games that have kicked off and have a valid close', () => {
  const edges = [
    row({ close_fair_prob: 0.22 }), // 5.0*0.22-1 = +0.10, close 12 min before kickoff: valid
    row({ close_fair_prob: 0.18 }), // 5.0*0.18-1 = -0.10, valid
    row({ close_fair_prob: 0.30, commence_time: '2026-10-05T17:00:00Z', close_updated_at: '2026-10-05 16:48:00' }), // not started: excluded, not noClose
    row({ close_fair_prob: null }), // kicked off, no close at all: excluded, counted in noClose
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.equal(summary.clv.all.count, 2);
  assert.ok(Math.abs(summary.clv.all.avg - 0) < 1e-9);
  assert.equal(summary.clv.all.positiveShare, 0.5);
  assert.equal(summary.clv.noClose, 1);
});

test('F1: a close written hours before kickoff is stale and does not count as settled', () => {
  const edges = [
    // commence 2026-09-25T00:15:00Z, close written 2026-09-24 18:00:00 -> ~6h15m before
    // kickoff, well outside the 20-minute grace window -> not a valid close.
    row({ close_fair_prob: 0.22, close_updated_at: '2026-09-24 18:00:00' }),
  ];
  const { summary, recent } = summarizeEdges(edges, [], NOW);
  assert.equal(summary.clv.all.count, 0);
  assert.equal(summary.clv.noClose, 1);
  assert.equal(recent[0].clv, null);
});

test('F1: a close written 12 minutes before kickoff counts as settled', () => {
  const edges = [
    // commence 2026-09-25T00:15:00Z, close written 2026-09-25 00:03:00 -> 12 min before
    // kickoff, inside the 20-minute grace window -> valid close.
    row({ close_fair_prob: 0.22, close_updated_at: '2026-09-25 00:03:00' }),
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.equal(summary.clv.all.count, 1);
  assert.equal(summary.clv.noClose, 0);
});

test('recent rows are ordered by first_seen_at desc, with clv null for no-close rows', () => {
  const edges = [
    row({ first_seen_at: '2026-09-24 16:01:00', close_fair_prob: 0.22 }), // earliest, valid close
    row({ first_seen_at: '2026-09-25 10:00:00', close_fair_prob: null }), // later, no close
    row({ first_seen_at: '2026-09-26 08:00:00', close_fair_prob: 0.20 }), // latest, valid close
  ];
  const { recent } = summarizeEdges(edges, [], NOW);
  assert.deepEqual(recent.map((r) => r.first_seen_at), [
    '2026-09-26 08:00:00', '2026-09-25 10:00:00', '2026-09-24 16:01:00',
  ]);
  assert.equal(recent[0].clv, 5.0 * 0.20 - 1);
  assert.equal(recent[1].clv, null);
  assert.equal(recent[2].clv, 5.0 * 0.22 - 1);
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
  assert.equal(summary.clv.noClose, 0);
  assert.equal(summary.medianLifetimeMinutes, null);
  assert.deepEqual(recent, []);
});

// Proof-health check: rows are edges LEFT JOIN game_results (result_status, graded_at).
const CHECK = Date.parse('2026-09-26T10:56:00Z');
const gap = (o) => ({
  event_id: 'e1', game: 'Atlanta Falcons @ Green Bay Packers',
  commence_time: '2026-09-25T00:15:00Z', close_fair_prob: 0.5,
  close_updated_at: '2026-09-25 00:03:00', result_status: 'final', graded_at: '2026-09-25 08:01:00',
  ...o,
});

test('a graded game with a valid close has no gaps', () => {
  assert.deepEqual(findProofGaps([gap()], CHECK), { ungraded: [], unmatched: [], missingClose: [] });
});

test('flags a game still ungraded 5h+ after kickoff, once per game', () => {
  const rows = [gap({ result_status: null }), gap({ result_status: null })];
  assert.deepEqual(findProofGaps(rows, CHECK).ungraded, ['Atlanta Falcons @ Green Bay Packers']);
  // A late kickoff the grader can't have reached yet is not a gap.
  const late = gap({ result_status: null, commence_time: '2026-09-26T07:00:00Z', close_updated_at: '2026-09-26 06:50:00' });
  assert.deepEqual(findProofGaps([late], CHECK).ungraded, []);
});

test('flags games the grader gave up on in the last day, since they drop out of the record', () => {
  const fresh = gap({ result_status: 'unmatched', graded_at: '2026-09-26 08:01:00' });
  const old = gap({ event_id: 'e2', game: 'Old @ Game', result_status: 'unmatched', graded_at: '2026-09-24 08:01:00' });
  assert.deepEqual(findProofGaps([fresh, old], CHECK).unmatched, ['Atlanta Falcons @ Green Bay Packers']);
});

test('flags a game from the last 24h whose edges have no valid close', () => {
  const kickoff = '2026-09-26T00:00:00Z';
  const none = gap({ commence_time: kickoff, close_fair_prob: null, close_updated_at: null });
  const stale = gap({ event_id: 'e2', game: 'Early @ Close', commence_time: kickoff, close_updated_at: '2026-09-25 16:00:00' });
  const older = gap({ event_id: 'e3', game: 'Two @ Days', close_fair_prob: null, commence_time: '2026-09-24T20:00:00Z' });
  assert.deepEqual(findProofGaps([none, stale, older], CHECK).missingClose, ['Atlanta Falcons @ Green Bay Packers', 'Early @ Close']);
});

test('the proof check runs once a day, on the last grading tick', () => {
  assert.equal(isProofCheckTick(CHECK), true);
  assert.equal(isProofCheckTick(Date.parse('2026-09-26T10:51:00Z')), false);
  assert.equal(isProofCheckTick(Date.parse('2026-09-26T22:56:00Z')), false);
});
