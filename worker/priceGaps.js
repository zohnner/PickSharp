// The daily "same bet, different price" post: line shopping made concrete, with no fair
// price and never an edge side, so it gives away nothing the email sells. Pure.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { tweetLength, TWEET_LIMIT } from './x.js';

const HOUR_MS = 60 * 60 * 1000;

export function isPriceGapTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 16 && d.getUTCMinutes() === 11;
}

// Distance in "cents" the way bettors count it: -125 to -145 is 20, +105 to -105 is 10.
const toCentsScale = (decimal) => {
  const o = americanOdds(decimal);
  return o >= 100 ? o - 100 : o + 100; // -110 -> -10, +105 -> 5
};
export function centsGap(bestDecimal, worstDecimal) {
  return toCentsScale(bestDecimal) - toCentsScale(worstDecimal);
}

export function selectPriceGaps(games, nowMs, { limit = 3, minCents = 15, withinMs = 36 * HOUR_MS } = {}) {
  const gaps = [];
  for (const game of games) {
    const kickoff = Date.parse(game.commence_time);
    if (!(kickoff > nowMs && kickoff - nowMs <= withinMs)) continue;
    for (const [market, sides] of Object.entries(game.markets)) {
      for (const side of sides) {
        if (side.is_edge || side.books < 2) continue;
        if (centsGap(side.best_price, side.worst_price) < minCents) continue;
        gaps.push({ game, market, side, size: 1 / side.worst_price - 1 / side.best_price });
      }
    }
  }
  return gaps.sort((a, b) => b.size - a.size).slice(0, limit).map(({ game, market, side }) => ({ game, market, side }));
}

const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const lastWord = (name) => String(name).trim().split(/\s+/).at(-1);
const book = (key) => BOOK_NAMES[key] || key;

function gapLine({ game, market, side }) {
  const label = selectionLabel({ market, outcome: side.outcome, point: side.point });
  const context = market === 'totals' ? ` (${lastWord(game.away_team)} @ ${lastWord(game.home_team)})` : '';
  return `${label}${context}: ${fmt(side.best_price)} ${book(side.best_book)} / ${fmt(side.worst_price)} ${book(side.worst_book)}`;
}

export function composePriceGapTweet(gaps) {
  const head = 'Same bet, different price 👇';
  const tail = 'Shopping the line is the easiest edge in betting. Full boards: link in bio. 21+';
  let lines = gaps.map(gapLine);
  while (lines.length > 1 && tweetLength([head, '', ...lines, '', tail].join('\n')) > TWEET_LIMIT) lines = lines.slice(0, -1);
  return [head, '', ...lines, '', tail].join('\n');
}
