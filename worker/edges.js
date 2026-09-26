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

const closeKey = ({ event_id, market, outcome }) => [event_id, market, outcome].join('|');

// Pinnacle's fair probability for every side it prices, at whatever line it's on now.
// CLV only needs this fair price, so a close no longer depends on the logged book still
// offering the exact number -- which is exactly what fails when the line moves our way.
export function pinnacleCloses(events, nowMs) {
  const closes = new Map();
  for (const ev of events || []) {
    if (!(Date.parse(ev.commence_time) > nowMs)) continue;
    const pinnacle = (ev.bookmakers || []).find((b) => b.key === 'pinnacle');
    for (const m of pinnacle?.markets || []) {
      const outcomes = m.outcomes || [];
      const fair = shinFairProbs(outcomes.map((o) => o.price));
      if (!fair) continue;
      outcomes.forEach((o, i) => {
        closes.set(closeKey({ event_id: ev.id, market: m.key, outcome: o.name }), {
          point: o.point ?? null,
          fair_prob: fair[i],
          commence_time: ev.commence_time,
        });
      });
    }
  }
  return closes;
}

// Rough win probability per point of line near the middle of the distribution. Flat
// values ignore football's key numbers (3, 7), so a moved-line CLV is an estimate and
// is labeled as one wherever it's shown.
const PROB_PER_POINT = {
  americanfootball_nfl: { spreads: 0.03, totals: 0.025 },
  americanfootball_ncaaf: { spreads: 0.025, totals: 0.02 },
  basketball_nba: { spreads: 0.03, totals: 0.02 },
};
// Past a few points the linear estimate stops meaning much; leave those without a close.
const MAX_ESTIMATE_POINTS = 3;

// edge: { event_id, sport, market, outcome, point }. Returns { fair_prob, point, estimated }
// where point is Pinnacle's closing line, or null when there's no usable close.
export function closeForEdge(edge, pinCloses) {
  const pin = pinCloses.get(closeKey(edge));
  if (!pin) return null;
  if ((edge.point ?? null) === pin.point) {
    return { fair_prob: pin.fair_prob, point: pin.point, estimated: false, commence_time: pin.commence_time };
  }
  const perPoint = PROB_PER_POINT[edge.sport]?.[edge.market];
  if (!perPoint || edge.point == null || pin.point == null) return null;
  // Points of line the logged bet has over the closing line: a higher spread number is
  // better for that side, as is a lower total for Over and a higher total for Under.
  const better =
    edge.market === 'totals'
      ? edge.outcome === 'Over' ? pin.point - edge.point : edge.point - pin.point
      : edge.point - pin.point;
  if (Math.abs(better) > MAX_ESTIMATE_POINTS) return null;
  const fair_prob = Math.min(0.99, Math.max(0.01, pin.fair_prob + better * perPoint));
  return { fair_prob, point: pin.point, estimated: true, commence_time: pin.commence_time };
}

export function findEdges(events, nowMs) {
  return closingUpdates(events, nowMs).filter((c) => c.ev >= MIN_LOGGED_EV);
}
