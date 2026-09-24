import { shinFairProbs } from './devig.js';

// Logged at 1%+ so the full distribution is visible; 2%+ is the "would publish" bar.
export const MIN_LOGGED_EV = 0.01;

export function edgeKey({ event_id, market, outcome, point, book }) {
  return [event_id, market, outcome, point ?? 'null', book].join('|');
}

// Every book-vs-Pinnacle comparison with the same market, outcome name and exact point.
// Alternate-line pricing (e.g. book +7 vs Pinnacle +7.5) is out of scope.
export function closingUpdates(events, nowMs) {
  const comparisons = [];
  for (const ev of events || []) {
    if (!(Date.parse(ev.commence_time) > nowMs)) continue;
    const pinnacle = (ev.bookmakers || []).find((b) => b.key === 'pinnacle');
    if (!pinnacle) continue;

    for (const pinMarket of pinnacle.markets || []) {
      const pinOutcomes = pinMarket.outcomes || [];
      const fair = shinFairProbs(pinOutcomes.map((o) => o.price));
      if (!fair) continue;

      pinOutcomes.forEach((pinOutcome, i) => {
        const point = pinOutcome.point ?? null;
        for (const book of ev.bookmakers) {
          if (book.key === 'pinnacle') continue;
          const market = (book.markets || []).find((m) => m.key === pinMarket.key);
          const outcome = (market?.outcomes || []).find(
            (o) => o.name === pinOutcome.name && (o.point ?? null) === point
          );
          if (!outcome || !(outcome.price > 1)) continue;
          comparisons.push({
            event_id: ev.id,
            sport: ev.sport_key,
            game: `${ev.away_team} @ ${ev.home_team}`,
            commence_time: ev.commence_time,
            market: pinMarket.key,
            outcome: pinOutcome.name,
            point,
            book: book.key,
            price: outcome.price,
            fair_prob: fair[i],
            ev: fair[i] * outcome.price - 1,
          });
        }
      });
    }
  }
  return comparisons;
}

export function findEdges(events, nowMs) {
  return closingUpdates(events, nowMs).filter((c) => c.ev >= MIN_LOGGED_EV);
}
