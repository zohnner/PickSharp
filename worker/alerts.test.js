import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPostFailure, isSlotFailure, adminAlertRecipient } from './alerts.js';

test('successful posts and expected skips are not failures', () => {
  assert.equal(isPostFailure({ posted: true }), false);
  assert.equal(isPostFailure({ posted: false, reason: 'Already posted for this slot today' }), false);
  assert.equal(isPostFailure({ posted: false, reason: 'Posting is paused until further notice' }), false);
  assert.equal(isPostFailure(null), false);
});

test('anything else that did not post is a failure', () => {
  assert.equal(isPostFailure({ posted: false, reason: 'No picks found for this slot today' }), true);
  assert.equal(isPostFailure({ posted: false, reason: 'X API 401' }), true);
  assert.equal(isPostFailure({ posted: false }), true);
});

test('alerts go to the first admin email only', () => {
  assert.equal(adminAlertRecipient({ ADMIN_EMAILS: ' Owner@X.com , b@x.com' }), 'owner@x.com');
  assert.equal(adminAlertRecipient({}), null);
});

test('an empty slot is expected when the slate is already fully picked or empty', () => {
  const noPicks = { posted: false, reason: 'No picks found for this slot today' };
  assert.equal(isSlotFailure({ inserted: 0, reason: 'every pick conflicted' }, noPicks), false);
  assert.equal(isSlotFailure({ skipped: true, reason: 'no games today' }, noPicks), false);
});

test('an empty slot is still a failure when generation broke', () => {
  const noPicks = { posted: false, reason: 'No picks found for this slot today' };
  assert.equal(isSlotFailure({ skipped: true, reason: 'generation failed' }, noPicks), true);
  assert.equal(isSlotFailure({ skipped: true, reason: 'odds fetch failed' }, noPicks), true);
  assert.equal(isSlotFailure({ inserted: 0 }, noPicks), true);
  assert.equal(isSlotFailure({ threw: 'boom' }, noPicks), true);
  // A conflicted slate never excuses a real posting error.
  assert.equal(isSlotFailure({ inserted: 0, reason: 'every pick conflicted' }, { posted: false, reason: 'X API 401' }), true);
  assert.equal(isSlotFailure({ inserted: 0, reason: 'every pick conflicted' }, { posted: true }), false);
});
