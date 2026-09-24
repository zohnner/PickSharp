// Admin summary for the edge logger. CLV = first_price * close_fair_prob - 1, counted
// only once the game has kicked off (before that the "close" is still moving).

const band = (ev) => (ev >= 0.03 ? '3%+' : ev >= 0.02 ? '2-3%' : '1-2%');
const sqlTimeMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const countBy = (rows, fn) => rows.reduce((acc, r) => ((acc[fn(r)] = (acc[fn(r)] || 0) + 1), acc), {});

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
  const isSettled = (r) => r.close_fair_prob != null && Date.parse(r.commence_time) <= nowMs;
  const settled = edgeRows.filter(isSettled);
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
      clv: { all: clvStats(settled), twoPlus: clvStats(settled.filter((r) => r.first_ev >= 0.02)) },
      scans: { ran: scanRows.filter((s) => s.ran).length, skipped },
    },
    recent,
  };
}
