import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecapTick, lastWeekDates, buildWeeklyRecap, composeRecapTweet, composeRecapEmail, isDailyResultsTick, buildDailyResults, composeDailyResultsTweet } from './recap.js';

const MONDAY = Date.parse('2026-09-28T14:01:00Z');
const entry = (commence_time, grade, units, ev = 0.025, clv = null) => ({ commence_time, grade, units, ev, clv });
const record = (edges) => ({ publishBar: 0.02, edges });

test('recap fires Mondays at 14:01 UTC only', () => {
  assert.equal(isRecapTick(MONDAY), true);
  assert.equal(isRecapTick(Date.parse('2026-09-28T14:06:00Z')), false);
  assert.equal(isRecapTick(Date.parse('2026-09-29T14:01:00Z')), false);
});

test('last week is the previous Monday through Sunday, Eastern', () => {
  assert.deepEqual(lastWeekDates(MONDAY), ['20260921', '20260922', '20260923', '20260924', '20260925', '20260926', '20260927']);
});

test('week counts publish-bar edges from last week; season counts all of them', () => {
  const rec = buildWeeklyRecap(
    record([
      entry('2026-09-28T00:20:00Z', 'win', 1.5, 0.03, 0.02), // Sun 8:20 PM ET -> last week
      entry('2026-09-25T00:15:00Z', 'loss', -1, 0.025, -0.01), // Thu night -> last week
      entry('2026-09-26T17:00:00Z', 'win', 0.9, 0.012), // below the bar -> excluded
      entry('2026-09-14T17:00:00Z', 'win', 1, 0.02), // two weeks ago -> season only
      entry('2026-09-27T17:00:00Z', 'pending', null), // not graded yet
    ]),
    MONDAY
  );
  assert.equal(rec.label, 'Sep 21–Sep 27');
  assert.deepEqual([rec.week.wins, rec.week.losses, rec.week.pending], [1, 1, 1]);
  assert.ok(Math.abs(rec.week.units - 0.5) < 1e-9);
  assert.deepEqual([rec.season.wins, rec.season.losses], [2, 1]);
});

test('no recap when nothing on the bar settled last week', () => {
  assert.equal(buildWeeklyRecap(record([entry('2026-09-26T17:00:00Z', 'pending', null)]), MONDAY), null);
  assert.equal(buildWeeklyRecap(record([]), MONDAY), null);
});

test('a losing week is still reported, and the tweet fits in 280 characters', () => {
  const rec = buildWeeklyRecap(
    record([entry('2026-09-26T17:00:00Z', 'loss', -1, 0.03, -0.02), entry('2026-09-27T17:00:00Z', 'loss', -1, 0.03, 0.01)]),
    MONDAY
  );
  const tweet = composeRecapTweet(rec, 'https://wepicksharp.com');
  assert.ok(tweet.includes('2%+ edges: 0-2, -2.00u'));
  assert.ok(tweet.includes('avg CLV -0.5% (1 of 2 beat the close)'));
  assert.ok(tweet.includes('https://wepicksharp.com/record?ref=x_recap'));
  assert.ok([...tweet].length <= 280, `tweet is ${[...tweet].length} chars`);
});

test('recap email carries the numbers, the record link and the required footer', () => {
  const rec = buildWeeklyRecap(record([entry('2026-09-26T17:00:00Z', 'win', 1.2, 0.03)]), MONDAY);
  const { subject, text, html } = composeRecapEmail(rec, {
    siteUrl: 'https://wepicksharp.com',
    unsubscribeLink: 'https://wepicksharp.com/api/unsubscribe?x',
    postalAddress: 'PickSharp, PO Box 1',
  });
  assert.equal(subject, 'Weekly edge report: 1-0, +1.20u (Sep 21–Sep 27)');
  for (const body of [text, html]) {
    assert.ok(body.includes('https://wepicksharp.com/record?ref=email_recap'));
    assert.ok(body.includes('PickSharp, PO Box 1'));
    assert.ok(body.includes('1-800-GAMBLER'));
  }
});

// Daily results post: yesterday's settled publish-bar edges, one tweet, wins and losses.
const SAT = Date.parse('2026-09-27T13:31:00Z'); // Sunday 9:31 AM ET -> yesterday is Sat Sep 26
const graded = (o) => ({
  commence_time: '2026-09-26T16:00:00Z', grade: 'win', units: 0.95, ev: 0.03, clv: 0.021, clvEstimated: false,
  selection: 'Tennessee Volunteers +5.5', odds: -105, ...o,
});

test('daily results fire every day at 13:31 UTC only', () => {
  assert.equal(isDailyResultsTick(SAT), true);
  assert.equal(isDailyResultsTick(Date.parse('2026-09-28T13:31:00Z')), true);
  assert.equal(isDailyResultsTick(Date.parse('2026-09-27T13:36:00Z')), false);
});

test('daily results cover yesterday (Eastern) settled publish-bar edges only', () => {
  const res = buildDailyResults(
    record([
      graded(),
      graded({ grade: 'loss', units: -1, selection: 'Northwestern Wildcats ML', odds: 1300 }),
      graded({ commence_time: '2026-09-27T00:30:00Z', grade: 'push', units: 0 }), // Sat 8:30 PM ET -> yesterday
      graded({ ev: 0.012 }), // below the bar
      graded({ grade: 'pending', units: null }), // not settled
      graded({ commence_time: '2026-09-25T16:00:00Z' }), // two days ago -> season only
    ]),
    SAT
  );
  assert.equal(res.date, '20260926');
  assert.equal(res.label, 'Sep 26');
  assert.equal(res.entries.length, 3);
  assert.deepEqual([res.day.wins, res.day.losses, res.day.pushes], [1, 1, 1]);
  assert.equal(res.season.wins, 2);
});

test('no settled edges yesterday means nothing to post', () => {
  assert.equal(buildDailyResults(record([graded({ grade: 'pending', units: null })]), SAT), null);
});

test('tweet lists each edge with its result and CLV, the day and season lines, and the record link', () => {
  const res = buildDailyResults(
    record([graded(), graded({ grade: 'loss', units: -1, selection: 'Over 52.5', odds: -105, clv: 0.012, clvEstimated: true })]),
    SAT
  );
  const tweet = composeDailyResultsTweet(res, 'https://wepicksharp.com');
  assert.match(tweet, /Sep 26/);
  assert.match(tweet, /✅ Tennessee Volunteers \+5\.5 \(-105\) · CLV \+2\.1%/);
  assert.match(tweet, /❌ Over 52\.5 \(-105\) · CLV \+1\.2% est\./);
  assert.match(tweet, /1-1, -0\.05u/);
  assert.match(tweet, /wepicksharp\.com\/record\?ref=x_daily/);
});

test('a busy day is truncated to fit a tweet with a "+N more" line', () => {
  const many = Array.from({ length: 20 }, (_, i) => graded({ selection: `Some Long Team Name Number ${i} +3.5` }));
  const tweet = composeDailyResultsTweet(buildDailyResults(record(many), SAT), 'https://wepicksharp.com');
  assert.ok(tweet.length <= 280, `length ${tweet.length}`);
  assert.match(tweet, /\+\d+ more/);
  assert.match(tweet, /20-0/);
});
