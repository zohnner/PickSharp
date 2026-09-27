import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLaunchGate } from './launchGate.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-09-24T17:00:00Z');
const NOW = START + 40 * DAY;
// n entries spread one per `gapDays`, CLVs cycling through `clvs`.
const entries = (n, clvs, { gapDays = 0.25, ...o } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    ev: 0.03, market: 'spreads', odds: -110, clv: clvs[i % clvs.length], clvEstimated: false,
    commence_time: new Date(START + i * gapDays * DAY).toISOString(), ...o,
  }));
const record = (edges) => ({ publishBar: 0.02, edges });
const check = (gate, key) => gate.checks.find((c) => c.key === key);

test('ready only when all four checks pass', () => {
  const gate = evaluateLaunchGate(record(entries(120, [0.03, 0.01, -0.01, 0.02])), NOW);
  assert.equal(check(gate, 'sample').pass, true);
  assert.equal(check(gate, 'mean').pass, true); // mean +1.25%
  assert.equal(check(gate, 'significant').pass, true);
  assert.equal(check(gate, 'span').pass, true); // 120 * 0.25 = ~30 days
  assert.equal(gate.ready, true);
});

test('too few edges is not ready, and says roughly how many more are needed', () => {
  const gate = evaluateLaunchGate(record(entries(30, [0.03, 0.01, -0.01, 0.02])), NOW);
  assert.equal(gate.ready, false);
  assert.equal(check(gate, 'sample').pass, false);
  assert.equal(gate.n, 30);
  assert.ok(gate.edgesNeeded >= 70, `edgesNeeded ${gate.edgesNeeded}`);
});

test('a positive but noisy average is not significant', () => {
  const gate = evaluateLaunchGate(record(entries(120, [0.2, -0.17])), NOW); // mean +1.5%, huge spread
  assert.equal(check(gate, 'mean').pass, true);
  assert.equal(check(gate, 'significant').pass, false);
  assert.equal(gate.ready, false);
});

test('only core edges count: below the bar, no close, and +200-or-longer moneylines are left out', () => {
  const edges = [
    ...entries(10, [0.02]),
    ...entries(5, [0.5], { ev: 0.015 }), // below the bar
    ...entries(5, [0.5], { clv: null }), // no close captured
    ...entries(5, [0.5], { market: 'h2h', odds: 250 }), // longshot
    ...entries(5, [0.02], { market: 'h2h', odds: 150 }), // short moneyline counts
  ];
  const gate = evaluateLaunchGate(record(edges), NOW);
  assert.equal(gate.n, 15);
  assert.ok(Math.abs(gate.meanClv - 0.02) < 1e-9);
  assert.equal(gate.excluded.longshots, 5);
  assert.equal(gate.excluded.noClose, 5);
});

test('less than 21 days of data fails the span check even with plenty of edges', () => {
  const gate = evaluateLaunchGate(record(entries(150, [0.03, 0.01, 0.02], { gapDays: 0.1 })), NOW); // ~15 days
  assert.equal(check(gate, 'span').pass, false);
  assert.equal(gate.ready, false);
});

test('reports how many CLVs are estimates, and handles an empty record', () => {
  const gate = evaluateLaunchGate(record(entries(4, [0.01], { clvEstimated: true })), NOW);
  assert.equal(gate.estimatedShare, 1);
  const empty = evaluateLaunchGate(record([]), NOW);
  assert.equal(empty.n, 0);
  assert.equal(empty.meanClv, null);
  assert.equal(empty.ready, false);
});
