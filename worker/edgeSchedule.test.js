import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toFeedIso, isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, parseReserve, DEFAULT_RESERVE,
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
