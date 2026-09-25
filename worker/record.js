// Public track record: every logged edge whose game has kicked off, graded against the
// final score and scored for closing line value. Only past games are ever exposed --
// live edges stay private for the future paid product.
import { gradeEdge, unitsFor } from './grading.js';
import { isValidClose } from './edgeReport.js';

// The strategy's "would publish" bar; 1-2% edges are logged to see the distribution.
export const PUBLISH_BAR_EV = 0.02;

const BOOK_NAMES = {
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  williamhill_us: 'Caesars',
  espnbet: 'ESPN BET',
  betrivers: 'BetRivers',
  fanatics: 'Fanatics',
  hardrockbet: 'Hard Rock Bet',
  ballybet: 'Bally Bet',
  betonlineag: 'BetOnline',
  bovada: 'Bovada',
  mybookieag: 'MyBookie',
  lowvig: 'LowVig',
};

export function americanOdds(decimal) {
  if (!(decimal > 1)) return null;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}

function selectionLabel(r) {
  const fmtPoint = (p) => (p > 0 ? `+${p}` : `${p}`);
  if (r.market === 'totals') return `${r.outcome} ${r.point}`;
  if (r.market === 'spreads') return `${r.outcome} ${fmtPoint(r.point)}`;
  return `${r.outcome} ML`;
}

// The same selection is logged once per book that mispriced it; the record counts it
// once, at the book with the largest edge -- the one a subscriber would have been sent.
function bestPerSelection(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = [r.event_id, r.market, r.outcome, r.point ?? 'null'].join('|');
    const cur = best.get(key);
    if (!cur || r.first_ev > cur.first_ev) best.set(key, r);
  }
  return [...best.values()];
}

export function stats(entries) {
  const count = (g) => entries.filter((e) => e.grade === g).length;
  const wins = count('win');
  const losses = count('loss');
  const pushes = count('push');
  const units = entries.reduce((sum, e) => sum + (e.units ?? 0), 0);
  const clvs = entries.map((e) => e.clv).filter((c) => c != null);
  return {
    edges: entries.length,
    wins,
    losses,
    pushes,
    pending: count('pending'),
    units,
    roi: wins + losses > 0 ? units / (wins + losses) : null,
    clv: {
      count: clvs.length,
      avg: clvs.length > 0 ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
      positiveShare: clvs.length > 0 ? clvs.filter((c) => c > 0).length / clvs.length : null,
    },
  };
}

// rows: edges LEFT JOIN game_results (home_team, away_team, home_score, away_score, result_status).
export function buildRecord(rows, nowMs) {
  const past = rows.filter((r) => Date.parse(r.commence_time) <= nowMs);
  const entries = bestPerSelection(past)
    .map((r) => {
      let grade = 'pending';
      if (r.result_status === 'final') grade = gradeEdge(r, r) ?? 'void';
      else if (r.result_status === 'unmatched') grade = 'void';
      const settled = grade === 'win' || grade === 'loss' || grade === 'push';
      return {
        id: r.id,
        sport: r.sport,
        game: r.game,
        commence_time: r.commence_time,
        selection: selectionLabel(r),
        book: BOOK_NAMES[r.book] || r.book,
        odds: americanOdds(r.first_price),
        ev: r.first_ev,
        clv: isValidClose(r, nowMs) ? r.first_price * r.close_fair_prob - 1 : null,
        grade,
        units: settled ? unitsFor(grade, r.first_price) : null,
        score: r.result_status === 'final' ? `${r.away_score}-${r.home_score}` : null,
      };
    })
    .sort((a, b) => Date.parse(b.commence_time) - Date.parse(a.commence_time) || b.ev - a.ev);

  return {
    publishBar: PUBLISH_BAR_EV,
    summary: {
      bar: stats(entries.filter((e) => e.ev >= PUBLISH_BAR_EV)),
      all: stats(entries),
    },
    edges: entries,
  };
}
