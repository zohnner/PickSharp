import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from './emailSignup.js';

test('trims and lowercases a valid address', () => {
  assert.equal(normalizeEmail('  Fan@Example.COM '), 'fan@example.com');
});

test('accepts plus-addressing and subdomains', () => {
  assert.equal(normalizeEmail('fan+nfl@mail.example.co.uk'), 'fan+nfl@mail.example.co.uk');
});

test('rejects non-strings, empty and whitespace-only input', () => {
  for (const raw of [undefined, null, 42, {}, '', '   ']) assert.equal(normalizeEmail(raw), null);
});

test('rejects addresses missing an @, a domain dot, or containing spaces', () => {
  for (const raw of ['fan.example.com', 'fan@example', 'fan @example.com', 'fan@@example.com']) {
    assert.equal(normalizeEmail(raw), null);
  }
});

test('rejects addresses over 254 characters', () => {
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@x.co`), null);
});
