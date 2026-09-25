import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature, stripeMode, paidSessionPickIds } from './stripe.js';

const SECRET = 'whsec_test123';
const BODY = '{"type":"checkout.session.completed"}';
const sign = (t, body = BODY, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

test('accepts a correctly signed, fresh payload', async () => {
  const t = 1_700_000_000;
  assert.equal(await verifyStripeSignature(BODY, `t=${t},v1=${sign(t)}`, SECRET, t + 10), true);
});

test('accepts when any one of several v1 signatures matches (secret rotation)', async () => {
  const t = 1_700_000_000;
  assert.equal(await verifyStripeSignature(BODY, `t=${t},v1=${'0'.repeat(64)},v1=${sign(t)}`, SECRET, t), true);
});

test('rejects a tampered body, wrong secret, stale timestamp or malformed header', async () => {
  const t = 1_700_000_000;
  const header = `t=${t},v1=${sign(t)}`;
  assert.equal(await verifyStripeSignature(BODY + ' ', header, SECRET, t), false);
  assert.equal(await verifyStripeSignature(BODY, header, 'whsec_other', t), false);
  assert.equal(await verifyStripeSignature(BODY, header, SECRET, t + 301), false);
  assert.equal(await verifyStripeSignature(BODY, `v1=${sign(t)}`, SECRET, t), false);
  assert.equal(await verifyStripeSignature(BODY, null, SECRET, t), false);
  assert.equal(await verifyStripeSignature(BODY, header, undefined, t), false);
});

test('stripeMode reports the key type without the key', () => {
  assert.equal(stripeMode('sk_live_abc'), 'live');
  assert.equal(stripeMode('rk_live_abc'), 'live');
  assert.equal(stripeMode('sk_test_abc'), 'test');
  assert.equal(stripeMode(undefined), 'missing');
  assert.equal(stripeMode('pk_live_abc'), 'unrecognized');
});

test('paidSessionPickIds only returns ids for paid sessions with PickSharp metadata', () => {
  const meta = { buyer_token: 'tok', pick_ids: '12,15' };
  assert.deepEqual(paidSessionPickIds({ payment_status: 'paid', metadata: meta }), [12, 15]);
  assert.equal(paidSessionPickIds({ payment_status: 'unpaid', metadata: meta }), null);
  assert.equal(paidSessionPickIds({ payment_status: 'paid', metadata: { pick_ids: '12' } }), null);
  assert.equal(paidSessionPickIds({ payment_status: 'paid', metadata: { buyer_token: 'tok', pick_ids: 'x' } }), null);
  assert.equal(paidSessionPickIds(null), null);
});
