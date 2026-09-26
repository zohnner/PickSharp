import { tweetLength, TWEET_LIMIT } from './x.js';

// No link in the tweet: X's pay-per-use API bills a post with a URL at $0.20 against
// $0.015 without, and these post several times a game day. The profile bio carries the
// site link (and X shows link-free posts more widely anyway). Don't name the domain in
// the text either -- X auto-links it and bills it as a link.
export function composeTweet(pick) {
  const prefix = `🔒 Today's FREE pick from ${pick.author}: `;
  const gameSuffix = ` (${pick.game})`;
  const suffix = `\nUnlock the rest of today's sharpest picks: link in bio 👆`;

  const maxPickTextLength = TWEET_LIMIT - tweetLength(prefix + gameSuffix + suffix);
  let pickText = pick.pick_text;
  if (tweetLength(pickText) > maxPickTextLength) {
    // The ellipsis weighs 2 under X's counting (see tweetLength).
    pickText = [...pickText].slice(0, Math.max(0, maxPickTextLength - 2)).join('') + '…';
  }

  return `${prefix}${pickText}${gameSuffix}${suffix}`;
}
