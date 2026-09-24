import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toFeedIso, isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, parseReserve, DEFAULT_RESERVE,
  effectiveReserve, parsePositiveInt,
} from './edgeSchedule.js';

const at = (iso) => Date.parse(iso);

test('toFeedIso drops milliseconds to match the odds feed format', () => {
  assert.equal(toFeedIso(at('2026-09-25T00:15:00.000Z')), '2026-09-25T00:15:00Z');
});

test('edge ticks are only the 1,6,...,56 cron, never the 0,15,30 generation cron', () => {
  assert.equal(isEdgeTick(at('2026-09-24T16:01:00Z')), true);
  assert.equal(isEdgeTick(at('2026-09-24T16:56:00Z')), true);
  assert.equal(isEdgeTick(at('2026-09-24T13:15:00Z')), false);
  assert.equal(isEdgeTick(at('2026-09-24T12:30:00Z')), false);
  assert.equal(isEdgeTick(at('2026-09-24T13:00:00Z')), false);
});

test('discovery fires once a day at 16:01 UTC', () => {
  assert.equal(isDiscoveryTick(at('2026-09-24T16:01:00Z')), true);
  assert.equal(isDiscoveryTick(at('2026-09-24T16:06:00Z')), false);
  assert.equal(isDiscoveryTick(at('2026-09-24T15:01:00Z')), false);
});

test('each kickoff falls in exactly one closing window across consecutive 5-minute ticks', () => {
  const kickoffs = ['2026-09-25T00:15:00Z', '2026-09-27T17:00:00Z', '2026-09-27T20:25:00Z', '2026-09-26T23:30:00Z'];
  const start = at('2026-09-24T00:01:00Z');
  for (const kickoff of kickoffs) {
    let hits = 0;
    for (let t = start; t < start + 4 * 24 * 3600e3; t += 5 * 60e3) {
      const { fromIso, toIso } = closingWindow(t);
      if (kickoff >= fromIso && kickoff < toIso) hits++;
    }
    assert.equal(hits, 1, kickoff);
  }
});

test('closing window is 10-15 minutes ahead of the tick', () => {
  assert.deepEqual(closingWindow(at('2026-09-25T00:01:00Z')), {
    fromIso: '2026-09-25T00:11:00Z',
    toIso: '2026-09-25T00:16:00Z',
  });
});

test('budget guard keeps the reserve for the AI pipeline', () => {
  assert.equal(withinBudget(157, 2, 150), true); // 157 - 6 = 151
  assert.equal(withinBudget(155, 2, 150), false); // 155 - 6 = 149
  assert.equal(withinBudget(null, 1, 150), false);
});

test('parseReserve falls back to the default on bad input', () => {
  assert.equal(parseReserve('200'), 200);
  assert.equal(parseReserve('0'), 0);
  assert.equal(parseReserve(undefined), DEFAULT_RESERVE);
  assert.equal(parseReserve(''), DEFAULT_RESERVE);
  assert.equal(parseReserve('-5'), DEFAULT_RESERVE);
  assert.equal(parseReserve('abc'), DEFAULT_RESERVE);
});

// F2: a flat reserve doesn't protect the AI pipeline -- 7 days before quota reset, a flat
// 150-credit floor lets the edge scans drain everything above it, starving the pipeline
// for the rest of the cycle. effectiveReserve scales the floor up by how many days of
// pipeline spend are still ahead before the monthly quota resets.
test('effectiveReserve prorates by days remaining until the reset day, computed exactly', () => {
  // Sept 24 2026 noon UTC -> Oct 1 00:00 UTC is exactly 6.5 days. 18 * 6.5 = 117 exactly.
  const nowMs = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 1 }), 117);
});

test('effectiveReserve: the floor wins late in the cycle, right before reset', () => {
  // Sept 30 2026 23:00 UTC -> Oct 1 00:00 UTC is 1 hour = 1/24 day. 18 * (1/24) = 0.75,
  // ceil = 1, which is below the 30-credit floor.
  const nowMs = Date.parse('2026-09-30T23:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 1 }), 30);
});

test('effectiveReserve: resetDay later in the same month', () => {
  // Sept 5 2026 00:00 UTC -> Sept 15 2026 00:00 UTC is exactly 10 days. 18 * 10 = 180.
  const nowMs = Date.parse('2026-09-05T00:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 15 }), 180);
});

test('effectiveReserve: rolls over into the next month (Dec -> Jan)', () => {
  // Dec 29 2026 00:00 UTC -> Jan 1 2027 00:00 UTC is exactly 3 days. 18 * 3 = 54.
  const nowMs = Date.parse('2026-12-29T00:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 1 }), 54);
});

test('effectiveReserve clamps resetDay above 28 down to 28', () => {
  // Sept 1 2026 00:00 UTC -> Sept 28 2026 00:00 UTC is exactly 27 days. 18 * 27 = 486.
  const nowMs = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 31 }), 486);
});

test('effectiveReserve clamps resetDay below 1 up to 1', () => {
  // Sept 5 2026 00:00 UTC -> Oct 1 2026 00:00 UTC is exactly 26 days. 18 * 26 = 468.
  const nowMs = Date.parse('2026-09-05T00:00:00Z');
  assert.equal(effectiveReserve(nowMs, { floor: 30, perDay: 18, resetDay: 0 }), 468);
});

test('parsePositiveInt falls back on bad input, generalized from parseReserve', () => {
  assert.equal(parsePositiveInt('18', 999), 18);
  assert.equal(parsePositiveInt('0', 5), 0);
  assert.equal(parsePositiveInt(undefined, 5), 5);
  assert.equal(parsePositiveInt('', 5), 5);
  assert.equal(parsePositiveInt('-3', 5), 5);
  assert.equal(parsePositiveInt('abc', 5), 5);
});
