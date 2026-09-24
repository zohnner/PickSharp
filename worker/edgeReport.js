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
const isValidClose = (r, nowMs) => {
  if (r.close_fair_prob == null || !hasKickedOff(r, nowMs)) return false;
  return sqlTimeMs(r.close_updated_at) >= Date.parse(r.commence_time) - CLOSE_GRACE_MS;
};

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
