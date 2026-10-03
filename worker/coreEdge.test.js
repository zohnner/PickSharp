import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCoreEdge, rankForLogging, CORE_EDGE_SQL, PUBLISH_BAR_EV, LONGSHOT_AMERICAN } from './coreEdge.js';

test('core edges are 2%+ and never +200-or-longer moneylines', () => {
  assert.equal(isCoreEdge(0.02, 'spreads', 1.91), true);
  assert.equal(isCoreEdge(0.025, 'h2h', 2.99), true);
  assert.equal(isCoreEdge(0.019, 'spreads', 1.91), false); // under the bar
  assert.equal(isCoreEdge(0.05, 'h2h', 3.0), false); // +200 moneyline
  assert.equal(isCoreEdge(0.05, 'totals', 3.0), true); // the longshot rule is moneylines only
});

test('the SQL rule and the JS rule share their numbers', () => {
  assert.equal(PUBLISH_BAR_EV, 0.02);
  assert.equal(LONGSHOT_AMERICAN, 200);
  assert.match(CORE_EDGE_SQL, /first_ev >= 0\.02/);
  assert.match(CORE_EDGE_SQL, /market = 'h2h' AND first_price >= 3/);
});

test('logging ranks core edges ahead of bigger-EV longshots, then by EV', () => {
  const found = [
    { id: 'long', ev: 0.12, market: 'h2h', price: 11 },
    { id: 'small', ev: 0.012, market: 'spreads', price: 1.91 },
    { id: 'core-lo', ev: 0.021, market: 'totals', price: 1.95 },
    { id: 'core-hi', ev: 0.03, market: 'h2h', price: 1.8 },
  ];
  assert.deepEqual(rankForLogging(found).map((e) => e.id), ['core-hi', 'core-lo', 'long', 'small']);
});
