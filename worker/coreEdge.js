// "Core" edges: the ones the launch gate counts, the only ones that get a paid closing
// scan, and the only ones eligible for the free daily post. One rule, in JS and in SQL,
// so the gate, the scanner and the proof check can't drift apart.

// The strategy's "would publish" bar; 1-2% edges are logged to see the distribution.
export const PUBLISH_BAR_EV = 0.02;
// +200 and longer moneylines: margin removal is least reliable there (favorite-longshot
// bias), so they're reported on /record but never count as core.
export const LONGSHOT_AMERICAN = 200;
export const LONGSHOT_DECIMAL = 3.0;

export function isCoreEdge(ev, market, decimalPrice) {
  return ev >= PUBLISH_BAR_EV && !(market === 'h2h' && decimalPrice >= LONGSHOT_DECIMAL);
}

// The same rule over edges rows.
export const CORE_EDGE_SQL =
  `(first_ev >= ${PUBLISH_BAR_EV} AND NOT (market = 'h2h' AND first_price >= ${LONGSHOT_DECIMAL}))`;

// Discovery logs only the top few edges per scan (D1 query limit), and longshots carry the
// biggest EVs, so ranking by EV alone would let them crowd out the edges the gate needs.
// found: findEdges output ({ ev, market, price }).
export function rankForLogging(found) {
  const core = (e) => (isCoreEdge(e.ev, e.market, e.price) ? 1 : 0);
  return [...found].sort((a, b) => core(b) - core(a) || b.ev - a.ev);
}
