// One live edge a day, posted to X right after the daily discovery scan: the public
// taste of the paid product. It spends no Odds API credits (it reads what the 16:01 UTC
// scan just logged) and one X post. Its result lands in the next morning's results post.
import { PUBLISH_BAR_EV, BOOK_NAMES, americanOdds, selectionLabel } from './record.js';
import { tweetLength, TWEET_LIMIT } from './x.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Five minutes after the 16:01 UTC discovery scan has written today's edges.
export function isFreeEdgeTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 16 && d.getUTCMinutes() === 6;
}

// Only prices first seen in the scan that just ran are posted: an edge logged on an
// earlier day keeps its first price in the table, which may no longer be on offer.
const FRESH_WITHIN = 30 * MIN;
// Enough lead time to place the bet, and close enough that the price is still likely there.
const MIN_LEAD = 30 * MIN;
const MAX_LEAD = 48 * HOUR;
// +200 and longer: margin removal is least reliable there (see record.js SEGMENTS), so the
// one edge we put our name on publicly is never a longshot.
const LONGSHOT_DECIMAL = 3.0;

const sqlMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));

export function selectFreeEdge(rows, nowMs) {
  const eligible = rows.filter((r) => {
    const lead = Date.parse(r.commence_time) - nowMs;
    return (
      r.first_ev >= PUBLISH_BAR_EV &&
      nowMs - sqlMs(r.first_seen_at) <= FRESH_WITHIN &&
      lead >= MIN_LEAD &&
      lead <= MAX_LEAD &&
      !(r.market === 'h2h' && r.first_price >= LONGSHOT_DECIMAL)
    );
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) => (r.first_ev > best.first_ev ? r : best));
}

const SPORTS = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'NCAAF', basketball_nba: 'NBA' };
const fmtOdds = (o) => (o > 0 ? `+${o}` : `${o}`);

function kickoffEt(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  return `${day} ${time} ET`;
}

// Long college team names can overflow a tweet, so the copy degrades in steps: the bet,
// the matchup, the link and the responsible-gambling line are never dropped.
export function composeFreeEdgeTweet(edge, siteUrl) {
  const book = BOOK_NAMES[edge.book] || edge.book;
  const fair = fmtOdds(americanOdds(1 / edge.first_fair_prob));
  const ev = `+${(edge.first_ev * 100).toFixed(1)}% edge`;
  const build = ({ source, caption }) =>
    [
      '🎯 Free edge of the day',
      '',
      `${selectionLabel(edge)} (${fmtOdds(americanOdds(edge.first_price))}) at ${book}`,
      edge.game,
      `${SPORTS[edge.sport] || edge.sport} · ${kickoffEt(edge.commence_time)}`,
      `Fair price ${fair}${source ? ' (Pinnacle no-vig)' : ''} → ${ev}`,
      '',
      ...(caption ? ['Prices move; check yours. Graded tomorrow, win or lose:'] : []),
      `${siteUrl}/record?ref=x_free_edge`,
      '21+ · 1-800-GAMBLER',
    ].join('\n');
  const variants = [
    { source: true, caption: true },
    { source: false, caption: true },
    { source: false, caption: false },
  ];
  for (const v of variants) {
    const text = build(v);
    if (tweetLength(text) <= TWEET_LIMIT) return text;
  }
  return build(variants.at(-1));
}
