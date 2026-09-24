import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shinFairProbs } from './devig.js';

const close = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `${a} !~ ${b}`);

test('fair probabilities sum to 1', () => {
  const [a, b] = shinFairProbs([1.25, 4.5]);
  close(a + b, 1, 1e-9);
});

test('an even market splits 50/50', () => {
  const [a, b] = shinFairProbs([1.95, 1.95]);
  close(a, 0.5);
  close(b, 0.5);
});

test('matches an independently computed reference (1.25 / 4.5)', () => {
  const [fav, dog] = shinFairProbs([1.25, 4.5]);
  close(fav, 0.788889);
  close(dog, 0.211111);
});

test('shades the longshot below proportional margin removal (the spike false-edge fix)', () => {
  const q = [1 / 1.25, 1 / 4.5];
  const proportionalDog = q[1] / (q[0] + q[1]); // 0.217391
  const [, shinDog] = shinFairProbs([1.25, 4.5]);
  assert.ok(shinDog < proportionalDog);
});

test('rejects anything but two valid decimal prices', () => {
  assert.equal(shinFairProbs([1.9]), null);
  assert.equal(shinFairProbs([1.9, 2.0, 3.0]), null);
  assert.equal(shinFairProbs([1.0, 2.0]), null);
  assert.equal(shinFairProbs([1.9, NaN]), null);
});

test('rejects zero-margin markets (booksum ≤ 1)', () => {
  assert.equal(shinFairProbs([2.1, 2.1]), null);
});

test('handles high-margin markets correctly (guard against bisection ceiling saturation)', () => {
  // 70/30 market inflated 40%: [1/0.98, 1/0.42]
  const [a, b] = shinFairProbs([1 / 0.98, 1 / 0.42]);
  close(a, 0.78);
  close(b, 0.22);
});
