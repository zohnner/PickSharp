// Admin summary for the edge logger. CLV = first_price * close_fair_prob - 1, counted
// only once the game has kicked off (before that the "close" is still moving).

const band = (ev) => (ev >= 0.03 ? '3%+' : ev >= 0.02 ? '2-3%' : '1-2%');
const sqlTimeMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const countBy = (rows, fn) => rows.reduce((acc, r) => ((acc[fn(r)] = (acc[fn(r)] || 0) + 1), acc), {});

// A "close" written well before kickoff (budget skip, pause, fetch failure, line moved
// off the exact point, write cap) is not a real closing line -- it's the birth snapshot.
// Only a close written within 20 minutes of kickoff is trusted as settled.
const CLOSE_GRACE_MS = 20 * 60 * 1000;
const hasKickedOff = (r, nowMs) => Date.parse(r.commence_time) <= nowMs;
export const isValidClose = (r, nowMs) => {
  if (r.close_fair_prob == null || !hasKickedOff(r, nowMs)) return false;
  return sqlTimeMs(r.close_updated_at) >= Date.parse(r.commence_time) - CLOSE_GRACE_MS;
};

// The track record is the product's proof, so holes in it must be loud. Checked once a
// day on the last grading tick (10:56 UTC), after every retry that morning has had its
// chance. rows: edges LEFT JOIN game_results (result_status, graded_at).
const HOUR_MS = 60 * 60 * 1000;
// Grading starts 4h after kickoff; anything that kicked off 5h+ before the check has
// been through at least one grading attempt.
const UNGRADED_AFTER_MS = 5 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

export function isProofCheckTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 10 && d.getUTCMinutes() === 56;
}

export function findProofGaps(rows, nowMs) {
  const ungraded = new Set();
  const unmatched = new Set();
  // A game's edges share one closing scan, so any edge with a valid close means the
  // scan ran; only games where none got one are reported.
  const closeByGame = new Map();
  for (const r of rows) {
    const kickoff = Date.parse(r.commence_time);
    if (!r.result_status && nowMs - kickoff >= UNGRADED_AFTER_MS) ungraded.add(r.game);
    if (r.result_status === 'unmatched' && nowMs - sqlTimeMs(r.graded_at) <= DAY_MS) unmatched.add(r.game);
    if (kickoff <= nowMs && nowMs - kickoff <= DAY_MS) {
      closeByGame.set(r.game, closeByGame.get(r.game) || isValidClose(r, nowMs));
    }
  }
  const missingClose = [...closeByGame].filter(([, ok]) => !ok).map(([game]) => game);
  return { ungraded: [...ungraded], unmatched: [...unmatched], missingClose };
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clvStats(rows) {
  const clvs = rows.map((r) => r.first_price * r.close_fair_prob - 1);
  if (clvs.length === 0) return { count: 0, avg: null, positiveShare: null };
  return {
    count: clvs.length,
    avg: clvs.reduce((a, b) => a + b, 0) / clvs.length,
    positiveShare: clvs.filter((c) => c > 0).length / clvs.length,
  };
}

export function summarizeEdges(edgeRows, scanRows, nowMs) {
  const isSettled = (r) => isValidClose(r, nowMs);
  const settled = edgeRows.filter(isSettled);
  const noClose = edgeRows.filter((r) => hasKickedOff(r, nowMs) && !isSettled(r)).length;
  const lifetimes = edgeRows.map((r) => (sqlTimeMs(r.last_edge_seen_at) - sqlTimeMs(r.first_seen_at)) / 60000);
  const skipped = countBy(scanRows.filter((s) => !s.ran), (s) => s.reason || 'unknown');

  const recent = [...edgeRows]
    .sort((a, b) => sqlTimeMs(b.first_seen_at) - sqlTimeMs(a.first_seen_at))
    .slice(0, 50)
    .map((r) => ({ ...r, clv: isSettled(r) ? r.first_price * r.close_fair_prob - 1 : null }));

  return {
    summary: {
      total: edgeRows.length,
      bySport: countBy(edgeRows, (r) => r.sport),
      byMarket: countBy(edgeRows, (r) => r.market),
      byBand: countBy(edgeRows, (r) => band(r.first_ev)),
      perDay: countBy(edgeRows, (r) => String(r.first_seen_at).slice(0, 10)),
      medianLifetimeMinutes: median(lifetimes),
      clv: {
        all: clvStats(settled),
        twoPlus: clvStats(settled.filter((r) => r.first_ev >= 0.02)),
        noClose,
      },
      scans: { ran: scanRows.filter((s) => s.ran).length, skipped },
    },
    recent,
  };
}
