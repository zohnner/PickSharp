import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropConflictingPicks } from './pickConflicts.js';

const NYG_LAR = { game: 'New York Giants @ Los Angeles Rams', game_time_utc: '2026-09-22T00:15:00Z' };
const ATL_GB = { game: 'Atlanta Falcons @ Green Bay Packers', game_time_utc: '2026-09-25T00:15:00Z' };

const pick = (game, pick_type, pick_text) => ({ ...game, pick_type, pick_text });

test('drops a spread on the opposite side of an existing spread (the Giants/Rams case)', () => {
  const existing = [pick(NYG_LAR, 'spread', 'New York Giants +6.5')];
  const { kept, dropped } = dropConflictingPicks([pick(NYG_LAR, 'spread', 'Los Angeles Rams -6.5')], existing);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('drops a second pick of the same type on the same game even if same side', () => {
  const existing = [pick(NYG_LAR, 'over_under', 'Over 47.5')];
  const { kept } = dropConflictingPicks([pick(NYG_LAR, 'over_under', 'Over 47.5')], existing);
  assert.equal(kept.length, 0);
});

test('drops a moneyline on the other team from an existing spread', () => {
  const existing = [pick(ATL_GB, 'spread', 'Green Bay Packers -6.5')];
  const { kept } = dropConflictingPicks([pick(ATL_GB, 'moneyline', 'Atlanta Falcons +230')], existing);
  assert.equal(kept.length, 0);
});

test('keeps a moneyline on the same team as an existing spread', () => {
  const existing = [pick(ATL_GB, 'spread', 'Green Bay Packers -6.5')];
  const { kept } = dropConflictingPicks([pick(ATL_GB, 'moneyline', 'Green Bay Packers')], existing);
  assert.equal(kept.length, 1);
});

test('keeps a total alongside a spread on the same game', () => {
  const existing = [pick(ATL_GB, 'spread', 'Green Bay Packers -6.5')];
  const { kept } = dropConflictingPicks([pick(ATL_GB, 'over_under', 'Under 44.5')], existing);
  assert.equal(kept.length, 1);
});

test('catches conflicts within the same candidate batch', () => {
  const { kept, dropped } = dropConflictingPicks(
    [pick(NYG_LAR, 'moneyline', 'New York Giants +230'), pick(NYG_LAR, 'moneyline', 'Los Angeles Rams')],
    []
  );
  assert.deepEqual(kept.map((p) => p.pick_text), ['New York Giants +230']);
  assert.equal(dropped.length, 1);
});

test('treats the same matchup at a different kickoff as a different game', () => {
  const existing = [pick(NYG_LAR, 'spread', 'New York Giants +6.5')];
  const rematch = { ...NYG_LAR, game_time_utc: '2026-12-20T21:25:00Z' };
  const { kept } = dropConflictingPicks([pick(rematch, 'spread', 'Los Angeles Rams -3')], existing);
  assert.equal(kept.length, 1);
});

test('drops a side pick whose team cannot be identified when the game already has a side pick', () => {
  const existing = [pick(ATL_GB, 'spread', 'Green Bay Packers -6.5')];
  const { kept } = dropConflictingPicks([pick(ATL_GB, 'moneyline', 'Packers win outright')], existing);
  assert.equal(kept.length, 0);
});

test('matches the same kickoff written in different ISO formats', () => {
  const existing = [pick(ATL_GB, 'spread', 'Green Bay Packers -6.5')];
  const sameKickoff = { ...ATL_GB, game_time_utc: '2026-09-25T00:15:00.000Z' };
  const { kept } = dropConflictingPicks([pick(sameKickoff, 'spread', 'Atlanta Falcons +6.5')], existing);
  assert.equal(kept.length, 0);
});

test('ignores props entirely', () => {
  const existing = [pick(ATL_GB, 'prop', 'Jordan Love Over 229.5 Passing Yards')];
  const { kept } = dropConflictingPicks([pick(ATL_GB, 'prop', 'Jordan Love Under 229.5 Passing Yards')], existing);
  assert.equal(kept.length, 1);
});
