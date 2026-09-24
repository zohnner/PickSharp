// Shin margin removal for a 2-way market. Proportional removal (divide each implied
// probability by the overround) over-credits longshots -- on 2026-09-23's live snapshot
// it produced 51 "edges" of which Shin kept 2 -- so PickSharp uses Shin exclusively.
export function shinFairProbs(prices) {
  if (!Array.isArray(prices) || prices.length !== 2) return null;
  if (prices.some((p) => !(Number.isFinite(p) && p > 1))) return null;

  const implied = prices.map((p) => 1 / p);
  const booksum = implied[0] + implied[1];
  if (booksum <= 1) return implied.map((x) => x / booksum); // no margin to remove

  const probsAt = (z) =>
    implied.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / booksum) - z) / (2 * (1 - z)));

  // Sum of probsAt(z) falls monotonically from sqrt(booksum) > 1 at z = 0; bisect for sum = 1.
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const [a, b] = probsAt(mid);
    if (a + b > 1) lo = mid;
    else hi = mid;
  }
  const [a, b] = probsAt(lo);
  const total = a + b;
  return [a / total, b / total];
}
