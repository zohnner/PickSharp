import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTweet } from './tweetCopy.js';
import { tweetLength } from './x.js';

const pick = { author: 'SharpBettor', pick_text: 'Texas Longhorns -5.5 (-110)', game: 'Texas Longhorns @ Tennessee Volunteers' };

test('pick tweets carry no link: X bills link posts at $0.20 vs $0.015, so they point to the bio', () => {
  const tweet = composeTweet(pick);
  assert.doesNotMatch(tweet, /https?:\/\//);
  // A bare domain is auto-linked by X and billed as a link too.
  assert.doesNotMatch(tweet, /\.com/);
  assert.match(tweet, /link in bio/);
  assert.match(tweet, /Texas Longhorns -5\.5 \(-110\) \(Texas Longhorns @ Tennessee Volunteers\)/);
});

test('long pick text is trimmed to fit', () => {
  const tweet = composeTweet({ ...pick, pick_text: 'x'.repeat(400) });
  assert.ok(tweetLength(tweet) <= 280, `length ${tweetLength(tweet)}`);
  assert.match(tweet, /…/);
});
