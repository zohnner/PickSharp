// Ready-to-paste X replies for the owner's manual sessions: one number-first line per bet,
// linking the game's board. Edge sides are left out, matching the public pages. Pure.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { sportPath } from './oddsSnapshot.js';
import { centsGap } from './priceGaps.js';

const HOUR_MS = 60 * 60 * 1000;
const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const book = (key) => BOOK_NAMES[key] || key;

export function buildReplyKit(games, siteUrl, nowMs, { withinMs = 36 * HOUR_MS } = {}) {
  return games
    .filter((g) => {
      const kickoff = Date.parse(g.commence_time);
      return kickoff > nowMs && kickoff - nowMs <= withinMs;
    })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))
    .map((g) => {
      const url = `${siteUrl}/odds/${sportPath(g.sport)}/${g.slug}?src=x_reply`;
      const lines = Object.entries(g.markets)
        .flatMap(([market, sides]) => sides.filter((s) => !s.is_edge && s.books >= 2).map((side) => ({ market, side })))
        .sort((a, b) => centsGap(b.side.best_price, b.side.worst_price) - centsGap(a.side.best_price, a.side.worst_price))
        .slice(0, 2)
        .map(({ market, side }) =>
          `Best price on ${selectionLabel({ market, outcome: side.outcome, point: side.point })} today is ${fmt(side.best_price)} at ${book(side.best_book)} (worst ${fmt(side.worst_price)} at ${book(side.worst_book)}). Full board: ${url}`
        );
      return { game: g.game, kickoff: g.commence_time, url, lines };
    })
    .filter((k) => k.lines.length > 0);
}
