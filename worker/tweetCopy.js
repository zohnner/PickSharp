const MAX_TWEET_LENGTH = 280;

export function composeTweet(pick, siteUrl) {
  const link = `${siteUrl}/picks?ref=x_bot`;
  const prefix = `🔒 Today's FREE pick from ${pick.author}: `;
  const gameSuffix = ` (${pick.game})`;
  const suffix = `\nUnlock the rest of today's sharpest picks 👉 ${link}`;

  const fixedLength = prefix.length + gameSuffix.length + suffix.length;
  const maxPickTextLength = MAX_TWEET_LENGTH - fixedLength;

  let pickText = pick.pick_text;
  if (pickText.length > maxPickTextLength) {
    pickText = [...pickText].slice(0, Math.max(0, maxPickTextLength - 1)).join('') + '…';
  }

  return `${prefix}${pickText}${gameSuffix}${suffix}`;
}
