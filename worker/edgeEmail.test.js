import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEmailEdges, composeEdgeEmail } from './edgeEmail.js';

const NOW = Date.parse('2026-10-03T16:06:00Z');
const row = (o) => ({
  id: 1, event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  commence_time: '2026-10-04T17:00:00Z', market: 'spreads', outcome: 'Cincinnati Bengals', point: -2.5,
  book: 'fanduel', first_price: 2.1, first_fair_prob: 0.5, first_ev: 0.05, first_seen_at: '2026-10-03 16:01:30', ...o,
});

test('only core edges first seen in this scan, kicking off later, one per selection', () => {
  const rows = [
    row({}),
    row({ id: 2, book: 'espnbet', first_price: 2.05, first_ev: 0.025 }), // same selection, smaller edge
    row({ id: 3, market: 'h2h', outcome: 'Jacksonville Jaguars', point: null, first_price: 3.6, first_ev: 0.08 }), // longshot
    row({ id: 4, first_ev: 0.015, outcome: 'Over', market: 'totals', point: 47.5 }), // under 2%
    row({ id: 5, first_seen_at: '2026-10-02 16:01:30', outcome: 'Under', market: 'totals', point: 47.5 }), // yesterday's
    row({ id: 6, commence_time: '2026-10-03T16:00:00Z', outcome: 'Over', market: 'totals', point: 44 }), // already started
    row({ id: 7, outcome: 'Jacksonville Jaguars', point: 2.5, first_ev: 0.03 }),
  ];
  assert.deepEqual(selectEmailEdges(rows, NOW).map((r) => r.id), [1, 7]);
});

test('the email lists each edge with book, price, fair price, EV and kickoff, plus the trial framing and footer', () => {
  const edges = selectEmailEdges([row({}), row({ id: 7, outcome: 'Jacksonville Jaguars', point: 2.5, first_ev: 0.03, first_price: 2.06, first_fair_prob: 0.5 })], NOW);
  const { subject, text, html } = composeEdgeEmail(edges, { siteUrl: 'https://wepicksharp.com', unsubscribeLink: 'https://wepicksharp.com/u?x', postalAddress: '1 Main St' });
  assert.equal(subject, '2 edges today: Cincinnati Bengals -2.5 +110 at FanDuel');
  assert.match(text, /Cincinnati Bengals -2.5 at FanDuel \+110 \(fair \+100\) · \+5.0% EV · Sun, Oct 4, 1:00 PM ET/);
  assert.match(text, /Free during our public trial/);
  assert.match(text, /https:\/\/wepicksharp.com\/record\?src=email/);
  assert.match(text, /1 Main St/);
  assert.match(html, /https:\/\/wepicksharp.com\/u\?x/);
  assert.equal(composeEdgeEmail(edges.slice(0, 1), { siteUrl: 'x', unsubscribeLink: 'y', postalAddress: 'z' }).subject, '1 edge today: Cincinnati Bengals -2.5 +110 at FanDuel');
});

test('team names are escaped in the HTML', () => {
  const { html } = composeEdgeEmail([row({ outcome: '<b>x</b>' })], { siteUrl: 'x', unsubscribeLink: 'y', postalAddress: 'z' });
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
