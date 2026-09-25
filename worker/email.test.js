import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDailyEmail, missingEmailConfig, unsubscribeToken, verifyUnsubscribeToken } from './email.js';

const PICK = {
  author: 'PickSharp',
  pick_text: 'Kansas City Chiefs -3.5',
  game: 'Kansas City Chiefs @ Buffalo Bills',
  game_time: 'Sep 27 4:25 PM ET',
};
const OPTS = { siteUrl: 'https://wepicksharp.com', unsubscribeLink: 'https://wepicksharp.com/api/unsubscribe?x=1', postalAddress: '123 Main St, Town, ST 00000' };

test('missingEmailConfig lists every unset required key', () => {
  assert.deepEqual(missingEmailConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.co' }), ['UNSUBSCRIBE_SECRET', 'EMAIL_POSTAL_ADDRESS']);
  assert.deepEqual(missingEmailConfig({ RESEND_API_KEY: 'k', UNSUBSCRIBE_SECRET: 's', EMAIL_FROM: 'f', EMAIL_POSTAL_ADDRESS: 'p' }), []);
});

test('unsubscribe tokens verify for the same email and secret only', async () => {
  const token = await unsubscribeToken('secret', 'fan@example.com');
  assert.equal(token.length, 64);
  assert.equal(await verifyUnsubscribeToken('secret', 'fan@example.com', token), true);
  assert.equal(await verifyUnsubscribeToken('secret', 'other@example.com', token), false);
  assert.equal(await verifyUnsubscribeToken('rotated', 'fan@example.com', token), false);
  assert.equal(await verifyUnsubscribeToken('secret', 'fan@example.com', 'short'), false);
  assert.equal(await verifyUnsubscribeToken('secret', 'fan@example.com', undefined), false);
});

test('email carries the pick, the postal address, the unsubscribe link and a ref-tagged site link', () => {
  const { subject, text, html } = composeDailyEmail(PICK, OPTS);
  assert.equal(subject, "Today's free pick: Kansas City Chiefs -3.5");
  for (const body of [text, html]) {
    assert.ok(body.includes('Kansas City Chiefs @ Buffalo Bills'));
    assert.ok(body.includes('123 Main St, Town, ST 00000'));
    assert.ok(body.includes('https://wepicksharp.com/picks?ref=email'));
    assert.ok(body.includes('1-800-GAMBLER'));
  }
  assert.ok(text.includes(OPTS.unsubscribeLink));
  assert.ok(html.includes('https://wepicksharp.com/api/unsubscribe?x=1'));
});

test('html escapes pick fields', () => {
  const { html } = composeDailyEmail({ ...PICK, pick_text: '<script>alert(1)</script>' }, OPTS);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
