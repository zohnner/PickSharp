// The daily odds board: for every upcoming game the discovery scan fetched, each side's
// best and worst US-book price at the main line and Pinnacle's fair price. Built from the
// events the scan already paid for, so it costs no Odds API credits. Feeds the /odds pages,
// the price-gap post and the reply kit. Pure: no I/O.
import { shinFairProbs } from './devig.js';
import { isCoreEdge } from './coreEdge.js';
import { etDate } from './grading.js';

export const MARKETS = ['spreads', 'totals', 'h2h'];

const SPORT_PATHS = { americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'ncaaf', basketball_nba: 'nba' };
export const sportPath = (sport) => SPORT_PATHS[sport] || null;
export const sportFromPath = (path) => Object.keys(SPORT_PATHS).find((k) => SPORT_PATHS[k] === path) || null;

export function etIsoDate(isoOrMs) {
  const d = etDate(isoOrMs);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Full team names: the same two teams never meet twice on one ET date, so slugs can't
// collide and stay the same in every day's snapshot.
export function gameSlug(ev, etIso = etIsoDate(ev.commence_time)) {
  return `${slugify(ev.away_team)}-at-${slugify(ev.home_team)}-${etIso}`;
}

// Pinnacle's line is the main line; a market it doesn't price has no fair price, so it's
// skipped rather than guessed at.
function sidesFor(ev, marketKey) {
  const pinMarket = ev.bookmakers.find((b) => b.key === 'pinnacle')?.markets?.find((m) => m.key === marketKey);
  if (!pinMarket) return [];
  const fair = shinFairProbs((pinMarket.outcomes || []).map((o) => o.price));
  const usBooks = ev.bookmakers.filter((b) => b.key !== 'pinnacle');

  return (pinMarket.outcomes || [])
    .map((pin, i) => {
      const point = pin.point ?? null;
      const quotes = [];
      for (const book of usBooks) {
        const market = (book.markets || []).find((m) => m.key === marketKey);
        const o = (market?.outcomes || []).find((x) => x.name === pin.name && (x.point ?? null) === point);
        if (o && o.price > 1) quotes.push({ book: book.key, price: o.price });
      }
      if (quotes.length === 0) return null;
      quotes.sort((a, b) => b.price - a.price);
      const best = quotes[0];
      const worst = quotes[quotes.length - 1];
      const fair_prob = fair ? fair[i] : null;
      return {
        outcome: pin.name,
        point,
        best_price: best.price,
        best_book: best.book,
        worst_price: worst.price,
        worst_book: worst.book,
        books: quotes.length,
        fair_prob,
        // Same rule and inputs as the edges the email sends, so the teaser hides exactly those.
        is_edge: fair_prob != null && isCoreEdge(best.price * fair_prob - 1, marketKey, best.price),
      };
    })
    .filter(Boolean);
}

// Runs inside the discovery scan's 10ms CPU budget: kickoff times are parsed once, and the
// ET date (an Intl call) is worked out once per kickoff time, which many games share.
export function buildSnapshot(events, nowMs) {
  const etByKickoff = new Map();
  const etFor = (iso) => {
    if (!etByKickoff.has(iso)) etByKickoff.set(iso, etIsoDate(iso));
    return etByKickoff.get(iso);
  };
  return (events || [])
    .map((ev) => ({ ev, ms: Date.parse(ev.commence_time) }))
    .filter(({ ms }) => ms > nowMs)
    .sort((a, b) => a.ms - b.ms || String(a.ev.id).localeCompare(String(b.ev.id)))
    .map(({ ev }) => {
      const markets = {};
      for (const key of MARKETS) {
        const sides = sidesFor(ev, key);
        if (sides.length > 0) markets[key] = sides;
      }
      return {
        event_id: ev.id,
        sport: ev.sport_key,
        game: `${ev.away_team} @ ${ev.home_team}`,
        home_team: ev.home_team,
        away_team: ev.away_team,
        commence_time: ev.commence_time,
        slug: gameSlug(ev, etFor(ev.commence_time)),
        markets,
      };
    });
}
