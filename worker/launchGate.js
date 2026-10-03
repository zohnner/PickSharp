import { LONGSHOT_AMERICAN } from './coreEdge.js';

// The go/no-go for paid subscriptions: "launch when the data clears the bar", as numbers.
// The edges must beat the closing line on average, by enough and over enough bets that
// it's very unlikely to be luck. Built from the same buildRecord output as /record.

const DAY_MS = 24 * 60 * 60 * 1000;

export const GATE = {
  minEdges: 100,
  minMeanClv: 0.01, // +1% average closing line value
  minDays: 21,
  // One-sided 95%: the average's lower bound must clear zero.
  z: 1.645,
  // +200 and longer moneylines are reported on /record but never count toward launch:
  // margin removal is least reliable there, so a streak could pass for skill.
  longshotOdds: LONGSHOT_AMERICAN,
};

// record: buildRecord output ({ publishBar, edges: [{ ev, market, odds, clv, clvEstimated, commence_time }] }).
export function evaluateLaunchGate(record, nowMs) {
  const bar = record.edges.filter((e) => e.ev >= record.publishBar);
  const longshot = (e) => e.market === 'h2h' && e.odds >= GATE.longshotOdds;
  const core = bar.filter((e) => e.clv != null && !longshot(e));
  const n = core.length;

  const meanClv = n > 0 ? core.reduce((s, e) => s + e.clv, 0) / n : null;
  const sd =
    n > 1 ? Math.sqrt(core.reduce((s, e) => s + (e.clv - meanClv) ** 2, 0) / (n - 1)) : null;
  const lowerBound = sd != null ? meanClv - (GATE.z * sd) / Math.sqrt(n) : null;
  const times = core.map((e) => Date.parse(e.commence_time));
  const spanDays = n > 0 ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;

  // Edges needed for the lower bound to clear zero at today's mean and spread -- only
  // meaningful once the mean is positive -- and never fewer than the minimum sample.
  const forSignificance = meanClv > 0 && sd > 0 ? Math.ceil(((GATE.z * sd) / meanClv) ** 2) : null;
  const target = forSignificance == null ? null : Math.max(GATE.minEdges, forSignificance);

  const checks = [
    { key: 'sample', label: `At least ${GATE.minEdges} edges with a closing line`, pass: n >= GATE.minEdges },
    { key: 'mean', label: `Average CLV of +${GATE.minMeanClv * 100}% or better`, pass: meanClv != null && meanClv >= GATE.minMeanClv },
    { key: 'significant', label: '95% confident the average is above zero', pass: lowerBound != null && lowerBound > 0 },
    { key: 'span', label: `At least ${GATE.minDays} days of results`, pass: spanDays >= GATE.minDays },
  ];

  return {
    ready: checks.every((c) => c.pass),
    checks,
    n,
    meanClv,
    lowerBound,
    spanDays,
    edgesNeeded: target == null ? null : Math.max(0, target - n),
    estimatedShare: n > 0 ? core.filter((e) => e.clvEstimated).length / n : null,
    excluded: {
      longshots: bar.filter((e) => longshot(e) && e.clv != null).length,
      noClose: bar.filter((e) => e.clv == null && !longshot(e)).length,
    },
    asOf: new Date(nowMs).toISOString(),
  };
}
