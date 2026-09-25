import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGradingTick } from './gradeGames.js';

test('grading runs on the 5-minute ticks between 08:00 and 10:59 UTC only', () => {
  assert.equal(isGradingTick(Date.parse('2026-09-28T08:01:00Z')), true);
  assert.equal(isGradingTick(Date.parse('2026-09-28T10:56:00Z')), true);
  assert.equal(isGradingTick(Date.parse('2026-09-28T11:01:00Z')), false);
  assert.equal(isGradingTick(Date.parse('2026-09-28T07:56:00Z')), false);
  assert.equal(isGradingTick(Date.parse('2026-09-28T09:00:00Z')), false);
});
