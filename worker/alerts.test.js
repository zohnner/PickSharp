import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPostFailure, adminAlertRecipient } from './alerts.js';

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
