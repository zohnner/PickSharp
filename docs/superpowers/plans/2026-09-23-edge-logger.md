# Edge Logger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log Pinnacle-vs-US-book pricing edges on NFL/NCAAF game lines, capture each edge's closing line, and report volume and closing-line value (CLV), all within The Odds API's free 500-credit/month plan.

**Architecture:** Pure modules (`devig.js`, `edges.js`, `edgeSchedule.js`, `edgeReport.js`) hold all the math and decisions, each unit-tested with `node:test`. One I/O module (`edgeScan.js`) runs a scan: schedule check → free budget check → paid odds fetch → D1 writes. It's wired into the existing 5-minute cron in `worker/index.js`, with an admin JSON endpoint for results.

**Tech Stack:** Cloudflare Workers (ES modules), D1 (SQLite), The Odds API v4, `node:test` (Node 24, no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-23-edge-logger-design.md`

## Global Constraints

- Stay on the free 500-credit/month plan. The only paid call is `/v4/sports/{sport}/odds` with `bookmakers=` (≤10 books = 3 credits per call for 3 markets). `/v4/sports` (the budget check) is free.
- Margin removal is **Shin only**. Never proportional.
- No new cron triggers (the account is at Cloudflare's 5-trigger cap). Edge scans run only on ticks where `minute % 5 === 1` (the `1,6,...,56` cron), never on the `0,15,30` generation cron's ticks, so a kickoff can't be double-scanned.
- Boolean env vars use exact matching: `env.EDGE_SCAN_PAUSED === 'true'`.
- D1 allows 50 queries per Worker invocation on the free plan, so one scan must stay under that (upserts and close updates are each capped at 20).
- Nothing user-facing: no posting, no emails, no public pages.
- Tests run with `npm test` (`node --test "worker/**/*.test.js"`).
- Timestamps in `edges.commence_time` are stored exactly as the odds feed sends them (`YYYY-MM-DDTHH:MM:SSZ`, no milliseconds), and every ISO string compared against them must use the same format (see `toFeedIso`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `worker/devig.js` (create) | `shinFairProbs(prices)`: 2-way margin removal |
| `worker/edges.js` (create) | `findEdges`, `closingUpdates`, `edgeKey`: pure comparisons on an odds-feed payload |
| `worker/edgeSchedule.js` (create) | `toFeedIso`, `isEdgeTick`, `isDiscoveryTick`, `closingWindow`, `withinBudget`, `parseReserve`: pure timing and budget rules |
| `worker/edgeReport.js` (create) | `summarizeEdges(edgeRows, scanRows, nowMs)`: pure admin summary |
| `worker/edgeScan.js` (create) | `runEdgeScan(env, scheduledMs)`: I/O orchestration |
| `worker/oddsApi.js` (modify) | add `fetchSharpComparison`, `getRemainingCredits`, `EDGE_SPORTS` |
| `worker/schema.sql` (modify) | `edges` table + `edges_identity` index + `edge_scans` table |
| `worker/index.js` (modify) | cron wiring + `GET /api/admin/edges` |
| `wrangler.toml` (modify) | `EDGE_SCAN_PAUSED`, `EDGE_SCAN_RESERVE` vars |

**Addition beyond the spec's table list:** `edge_scans` (one row per due scan, whether it ran or was skipped). The spec requires the admin summary to report scans skipped by the budget guard, and that needs somewhere to record them.

---

### Task 1: Shin margin removal

**Files:**
- Create: `worker/devig.js`
- Test: `worker/devig.test.js`

**Interfaces:**
- Produces: `shinFairProbs(prices: [number, number]) → [number, number] | null` (null when not exactly 2 prices or any price ≤ 1).

- [ ] **Step 1: Write the failing test**

```js
// worker/devig.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shinFairProbs } from './devig.js';

const close = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `${a} !~ ${b}`);

test('fair probabilities sum to 1', () => {
  const [a, b] = shinFairProbs([1.25, 4.5]);
  close(a + b, 1, 1e-9);
});

test('an even market splits 50/50', () => {
  const [a, b] = shinFairProbs([1.95, 1.95]);
  close(a, 0.5);
  close(b, 0.5);
});

test('matches an independently computed reference (1.25 / 4.5)', () => {
  const [fav, dog] = shinFairProbs([1.25, 4.5]);
  close(fav, 0.788889);
  close(dog, 0.211111);
});

test('shades the longshot below proportional margin removal (the spike false-edge fix)', () => {
  const q = [1 / 1.25, 1 / 4.5];
  const proportionalDog = q[1] / (q[0] + q[1]); // 0.217391
  const [, shinDog] = shinFairProbs([1.25, 4.5]);
  assert.ok(shinDog < proportionalDog);
});

test('rejects anything but two valid decimal prices', () => {
  assert.equal(shinFairProbs([1.9]), null);
  assert.equal(shinFairProbs([1.9, 2.0, 3.0]), null);
  assert.equal(shinFairProbs([1.0, 2.0]), null);
  assert.equal(shinFairProbs([1.9, NaN]), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test worker/devig.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./devig.js`.

- [ ] **Step 3: Write the implementation**

```js
// worker/devig.js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test worker/devig.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/devig.js worker/devig.test.js
git commit -m "Add Shin margin removal for 2-way markets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Edge detection and closing-line extraction

**Files:**
- Create: `worker/edges.js`
- Test: `worker/edges.test.js`

**Interfaces:**
- Consumes: `shinFairProbs` (Task 1).
- Produces:
  - `MIN_LOGGED_EV = 0.01`
  - `edgeKey(row) → string` from `{event_id, market, outcome, point, book}` (`point` null for h2h).
  - `closingUpdates(events, nowMs) → Comparison[]`: every exact-match book-vs-Pinnacle comparison on events that haven't started.
  - `findEdges(events, nowMs) → Comparison[]`: the subset with `ev >= MIN_LOGGED_EV`.
  - `Comparison = {event_id, sport, game, commence_time, market, outcome, point, book, price, fair_prob, ev}`.
  - `events` is the raw Odds API `/odds` JSON array: `[{id, sport_key, commence_time, home_team, away_team, bookmakers: [{key, markets: [{key, outcomes: [{name, price, point?}]}]}]}]`.

- [ ] **Step 1: Write the failing test**

```js
// worker/edges.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEdges, closingUpdates, edgeKey, MIN_LOGGED_EV } from './edges.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

// Hand-built, shaped like a real /odds response (decimal odds).
const upcoming = {
  id: 'evt1',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-09-25T00:15:00Z',
  home_team: 'Green Bay Packers',
  away_team: 'Atlanta Falcons',
  bookmakers: [
    {
      key: 'pinnacle',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.25 }, { name: 'Atlanta Falcons', price: 4.5 }] },
        {
          key: 'spreads',
          outcomes: [
            { name: 'Green Bay Packers', price: 1.91, point: -7.5 },
            { name: 'Atlanta Falcons', price: 1.91, point: 7.5 },
          ],
        },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 44.5 }] }, // not 2-way: skipped
      ],
    },
    {
      key: 'fanduel',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.22 }, { name: 'Atlanta Falcons', price: 5.2 }] },
        { key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', price: 2.2, point: 7 }] }, // point mismatch
      ],
    },
    {
      key: 'draftkings',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 4.6 }] }],
    },
    {
      key: 'betmgm',
      markets: [{ key: 'spreads', outcomes: [{ name: 'Atlanta Falcons', price: 2.08, point: 7.5 }] }],
    },
  ],
};

const started = { ...upcoming, id: 'evt0', commence_time: '2026-09-24T11:00:00Z' };

test('finds the Shin edges and nothing else', () => {
  const edges = findEdges([upcoming, started], NOW);
  const keys = edges.map((e) => `${e.book}|${e.market}|${e.outcome}|${e.point}`).sort();
  assert.deepEqual(keys, ['betmgm|spreads|Atlanta Falcons|7.5', 'fanduel|h2h|Atlanta Falcons|null']);
});

test('computes EV from the Shin fair probability', () => {
  const fd = findEdges([upcoming], NOW).find((e) => e.book === 'fanduel');
  assert.ok(Math.abs(fd.fair_prob - 0.211111) < 1e-5);
  assert.ok(Math.abs(fd.ev - (0.211111 * 5.2 - 1)) < 1e-4);
  assert.equal(fd.game, 'Atlanta Falcons @ Green Bay Packers');
  assert.equal(fd.sport, 'americanfootball_nfl');
  assert.equal(fd.commence_time, '2026-09-25T00:15:00Z');
});

test('only exact point matches count (fanduel +7 vs pinnacle +7.5 is ignored)', () => {
  const all = closingUpdates([upcoming], NOW);
  assert.ok(!all.some((c) => c.book === 'fanduel' && c.market === 'spreads'));
});

test('closingUpdates includes below-threshold comparisons so logged edges keep a current close', () => {
  const all = closingUpdates([upcoming], NOW);
  const dk = all.find((c) => c.book === 'draftkings');
  assert.ok(dk, 'draftkings h2h comparison present');
  assert.ok(dk.ev < MIN_LOGGED_EV);
});

test('skips events that have started and events without Pinnacle', () => {
  const noPin = { ...upcoming, id: 'evt2', bookmakers: upcoming.bookmakers.filter((b) => b.key !== 'pinnacle') };
  assert.equal(closingUpdates([started, noPin], NOW).length, 0);
});

test('edgeKey treats null and undefined point the same', () => {
  const base = { event_id: 'e', market: 'h2h', outcome: 'X', book: 'b' };
  assert.equal(edgeKey({ ...base, point: null }), edgeKey({ ...base, point: undefined }));
  assert.notEqual(edgeKey({ ...base, point: 7.5 }), edgeKey({ ...base, point: null }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test worker/edges.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./edges.js`.

- [ ] **Step 3: Write the implementation**

```js
// worker/edges.js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test worker/edges.test.js`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/edges.js worker/edges.test.js
git commit -m "Add Pinnacle-vs-US-book edge detection with exact-point matching

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Scan timing and budget rules

**Files:**
- Create: `worker/edgeSchedule.js`
- Test: `worker/edgeSchedule.test.js`

**Interfaces:**
- Produces:
  - `CREDITS_PER_SPORT_SCAN = 3`
  - `DEFAULT_RESERVE = 150`
  - `toFeedIso(ms) → 'YYYY-MM-DDTHH:MM:SSZ'`
  - `isEdgeTick(ms) → boolean`: true only for the `1,6,...,56` cron (`minute % 5 === 1`).
  - `isDiscoveryTick(ms) → boolean`: true only at 16:01 UTC.
  - `closingWindow(ms) → {fromIso, toIso}`: `[ms+10min, ms+15min)` in feed format.
  - `withinBudget(remaining, sportsCount, reserve) → boolean`
  - `parseReserve(raw) → number`: a non-negative integer, else `DEFAULT_RESERVE`.

- [ ] **Step 1: Write the failing test**

```js
// worker/edgeSchedule.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toFeedIso, isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, parseReserve, DEFAULT_RESERVE,
} from './edgeSchedule.js';

const at = (iso) => Date.parse(iso);

test('toFeedIso drops milliseconds to match the odds feed format', () => {
  assert.equal(toFeedIso(at('2026-09-25T00:15:00.000Z')), '2026-09-25T00:15:00Z');
});

test('edge ticks are only the 1,6,...,56 cron, never the 0,15,30 generation cron', () => {
  assert.equal(isEdgeTick(at('2026-09-24T16:01:00Z')), true);
  assert.equal(isEdgeTick(at('2026-09-24T16:56:00Z')), true);
  assert.equal(isEdgeTick(at('2026-09-24T13:15:00Z')), false);
  assert.equal(isEdgeTick(at('2026-09-24T12:30:00Z')), false);
  assert.equal(isEdgeTick(at('2026-09-24T13:00:00Z')), false);
});

test('discovery fires once a day at 16:01 UTC', () => {
  assert.equal(isDiscoveryTick(at('2026-09-24T16:01:00Z')), true);
  assert.equal(isDiscoveryTick(at('2026-09-24T16:06:00Z')), false);
  assert.equal(isDiscoveryTick(at('2026-09-24T15:01:00Z')), false);
});

test('each kickoff falls in exactly one closing window across consecutive 5-minute ticks', () => {
  const kickoffs = ['2026-09-25T00:15:00Z', '2026-09-27T17:00:00Z', '2026-09-27T20:25:00Z', '2026-09-26T23:30:00Z'];
  const start = at('2026-09-24T00:01:00Z');
  for (const kickoff of kickoffs) {
    let hits = 0;
    for (let t = start; t < start + 4 * 24 * 3600e3; t += 5 * 60e3) {
      const { fromIso, toIso } = closingWindow(t);
      if (kickoff >= fromIso && kickoff < toIso) hits++;
    }
    assert.equal(hits, 1, kickoff);
  }
});

test('closing window is 10-15 minutes ahead of the tick', () => {
  assert.deepEqual(closingWindow(at('2026-09-25T00:01:00Z')), {
    fromIso: '2026-09-25T00:11:00Z',
    toIso: '2026-09-25T00:16:00Z',
  });
});

test('budget guard keeps the reserve for the AI pipeline', () => {
  assert.equal(withinBudget(157, 2, 150), true); // 157 - 6 = 151
  assert.equal(withinBudget(155, 2, 150), false); // 155 - 6 = 149
  assert.equal(withinBudget(null, 1, 150), false);
});

test('parseReserve falls back to the default on bad input', () => {
  assert.equal(parseReserve('200'), 200);
  assert.equal(parseReserve('0'), 0);
  assert.equal(parseReserve(undefined), DEFAULT_RESERVE);
  assert.equal(parseReserve(''), DEFAULT_RESERVE);
  assert.equal(parseReserve('-5'), DEFAULT_RESERVE);
  assert.equal(parseReserve('abc'), DEFAULT_RESERVE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test worker/edgeSchedule.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./edgeSchedule.js`.

- [ ] **Step 3: Write the implementation**

```js
// worker/edgeSchedule.js
// Timing and budget rules for the edge logger on The Odds API's free 500-credit plan.
// Derived from event.scheduledTime, never event.cron (undocumented format).

export const CREDITS_PER_SPORT_SCAN = 3; // h2h+spreads+totals, <=10 named bookmakers = 1 region
export const DEFAULT_RESERVE = 150; // credits always left for the AI pick pipeline

const MINUTE = 60 * 1000;

export function toFeedIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The 1,6,...,56 cron only. The 0,15,30 generation cron also reaches scheduled()'s
// fallback branch; scanning on its ticks too would double-scan kickoffs.
export function isEdgeTick(ms) {
  return new Date(ms).getUTCMinutes() % 5 === 1;
}

export function isDiscoveryTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 16 && d.getUTCMinutes() === 1;
}

// Ticks are 5 minutes apart and the window is 5 minutes wide, so every kickoff lands in
// exactly one window -- one closing scan, taken 10-15 minutes before kickoff.
export function closingWindow(ms) {
  return { fromIso: toFeedIso(ms + 10 * MINUTE), toIso: toFeedIso(ms + 15 * MINUTE) };
}

export function withinBudget(remaining, sportsCount, reserve) {
  if (!Number.isFinite(remaining)) return false;
  return remaining - CREDITS_PER_SPORT_SCAN * sportsCount >= reserve;
}

export function parseReserve(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return DEFAULT_RESERVE;
  return Number(raw.trim());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test worker/edgeSchedule.test.js`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add worker/edgeSchedule.js worker/edgeSchedule.test.js
git commit -m "Add edge logger scan timing and credit-reserve rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Odds API calls for the logger

**Files:**
- Modify: `worker/oddsApi.js` (append after `getEventProps`; add one import at the top)
- Test: `worker/oddsApi.test.js` (append)

**Interfaces:**
- Consumes: `toFeedIso` (Task 3); the existing `logQuota(res, label)` and `ODDS_API_BASE` in `oddsApi.js`.
- Produces:
  - `EDGE_SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf']`
  - `fetchSharpComparison(env, sportKey, nowMs) → Promise<events[]>` (throws on non-2xx)
  - `getRemainingCredits(env) → Promise<number | null>` (null on any failure or a missing header)

- [ ] **Step 1: Write the failing tests** (append to `worker/oddsApi.test.js`; the file's `beforeEach` already mocks `globalThis.fetch`, records `calls`, and defines `env = { ODDS_API_KEY: 'k' }`)

```js
import { fetchSharpComparison, getRemainingCredits, EDGE_SPORTS } from './oddsApi.js';

test('sharp comparison names pinnacle + US books, decimal odds, and a 7-day window', async () => {
  await fetchSharpComparison(env, 'americanfootball_nfl', Date.parse('2026-09-24T16:01:00Z'));
  const url = calls.at(-1);
  assert.match(url, /\/sports\/americanfootball_nfl\/odds\?/);
  assert.match(url, /bookmakers=pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,hardrockbet/);
  assert.match(url, /markets=h2h,spreads,totals/);
  assert.match(url, /oddsFormat=decimal/);
  assert.match(url, /commenceTimeTo=2026-10-01T16:01:00Z/);
  assert.doesNotMatch(url, /regions=/);
});

test('bookmaker list stays within 10 so it bills as one region', async () => {
  await fetchSharpComparison(env, 'americanfootball_nfl', Date.now());
  const books = new URL(calls.at(-1)).searchParams.get('bookmakers').split(',');
  assert.ok(books.length <= 10);
});

test('remaining credits come from the free /sports endpoint header', async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('[]', { status: 200, headers: { 'x-requests-remaining': '321' } });
  };
  assert.equal(await getRemainingCredits(env), 321);
  assert.match(calls.at(-1), /\/v4\/sports\?apiKey=/);
});

test('remaining credits is null when the call fails', async () => {
  globalThis.fetch = async () => { throw new Error('network'); };
  assert.equal(await getRemainingCredits(env), null);
});

test('edge sports are NFL and NCAAF only', () => {
  assert.deepEqual(EDGE_SPORTS, ['americanfootball_nfl', 'americanfootball_ncaaf']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test worker/oddsApi.test.js`
Expected: FAIL with a SyntaxError that `./oddsApi.js` does not provide an export named `fetchSharpComparison`.

- [ ] **Step 3: Write the implementation**

At the top of `worker/oddsApi.js`:

```js
import { toFeedIso } from './edgeSchedule.js';
```

Appended to `worker/oddsApi.js`:

```js
export const EDGE_SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf'];

// Up to 10 named bookmakers bill as one region (3 credits for 3 markets, verified live);
// Pinnacle is the sharp reference, the rest are books a US bettor can actually use.
const EDGE_BOOKMAKERS = 'pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,hardrockbet';
const EDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchSharpComparison(env, sportKey, nowMs) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${env.ODDS_API_KEY}&bookmakers=${EDGE_BOOKMAKERS}&markets=h2h,spreads,totals&oddsFormat=decimal&commenceTimeTo=${toFeedIso(nowMs + EDGE_WINDOW_MS)}`;
  const res = await fetch(url);
  logQuota(res, `${sportKey}/edges`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API edge request failed for ${sportKey}: ${res.status} ${body}`);
  }
  return res.json();
}

// /v4/sports costs 0 credits but still returns the quota headers -- used as a free
// balance check before every paid edge scan.
export async function getRemainingCredits(env) {
  try {
    const res = await fetch(`${ODDS_API_BASE}/sports?apiKey=${env.ODDS_API_KEY}`);
    const raw = res.headers.get('x-requests-remaining');
    const remaining = raw === null ? NaN : Number(raw);
    return Number.isFinite(remaining) ? remaining : null;
  } catch (err) {
    console.error('Odds API balance check failed:', err.message);
    return null;
  }
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/oddsApi.js worker/oddsApi.test.js
git commit -m "Add sharp-comparison odds fetch and free credit-balance check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Schema and scan orchestration

**Files:**
- Modify: `worker/schema.sql` (append)
- Create: `worker/edgeScan.js`
- Test: `worker/edgeScan.test.js`

**Interfaces:**
- Consumes: `findEdges`, `closingUpdates`, `edgeKey` (Task 2); `isEdgeTick`, `isDiscoveryTick`, `closingWindow`, `withinBudget`, `parseReserve`, `toFeedIso` (Task 3); `EDGE_SPORTS`, `fetchSharpComparison`, `getRemainingCredits` (Task 4).
- Produces: `runEdgeScan(env, scheduledMs, deps?) → Promise<{ran: boolean, reason?: string, kind?: string, found?: number, closesUpdated?: number}>`. `deps` (optional, for tests) overrides `{fetchSharpComparison, getRemainingCredits}`.

- [ ] **Step 1: Append the schema**

```sql
-- worker/schema.sql (append)
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  game TEXT NOT NULL,
  commence_time TEXT NOT NULL,          -- odds-feed format YYYY-MM-DDTHH:MM:SSZ
  market TEXT NOT NULL,                 -- h2h | spreads | totals
  outcome TEXT NOT NULL,
  point REAL,                           -- NULL for h2h
  book TEXT NOT NULL,
  first_price REAL NOT NULL,            -- decimal price when first seen
  first_fair_prob REAL NOT NULL,
  first_ev REAL NOT NULL,
  peak_ev REAL NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_edge_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  close_price REAL,
  close_fair_prob REAL,
  close_updated_at TEXT
);

-- NULLs are distinct in SQLite UNIQUE constraints, so h2h rows dedupe via a sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS edges_identity
  ON edges (event_id, market, outcome, COALESCE(point, -9999), book);

CREATE INDEX IF NOT EXISTS edges_commence ON edges (commence_time);

-- One row per scan that was due, whether it ran or was skipped, so thin data from
-- skipped scans is never mistaken for thin edges.
CREATE TABLE IF NOT EXISTS edge_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- discovery | closing
  sports TEXT NOT NULL,                 -- comma-separated sport keys
  ran INTEGER NOT NULL,                 -- 1 ran, 0 skipped
  reason TEXT,                          -- why skipped (NULL when ran)
  credits_remaining INTEGER,
  edges_found INTEGER,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Verify the upsert SQL against real SQLite (local D1)**

Run:
```bash
npx wrangler d1 execute sharpflow-db --local --file=./worker/schema.sql
npx wrangler d1 execute sharpflow-db --local --command "INSERT INTO edges (event_id, sport, game, commence_time, market, outcome, point, book, first_price, first_fair_prob, first_ev, peak_ev) VALUES ('e1','nfl','A @ B','2026-09-25T00:15:00Z','h2h','A',NULL,'fanduel',5.2,0.21,0.09,0.09) ON CONFLICT (event_id, market, outcome, COALESCE(point, -9999), book) DO UPDATE SET peak_ev = MAX(peak_ev, excluded.first_ev), last_edge_seen_at = datetime('now'); INSERT INTO edges (event_id, sport, game, commence_time, market, outcome, point, book, first_price, first_fair_prob, first_ev, peak_ev) VALUES ('e1','nfl','A @ B','2026-09-25T00:15:00Z','h2h','A',NULL,'fanduel',5.5,0.21,0.15,0.15) ON CONFLICT (event_id, market, outcome, COALESCE(point, -9999), book) DO UPDATE SET peak_ev = MAX(peak_ev, excluded.first_ev), last_edge_seen_at = datetime('now'); SELECT COUNT(*) n, first_price, peak_ev FROM edges WHERE event_id='e1';"
```
Expected: `n = 1`, `first_price = 5.2`, `peak_ev = 0.15`. If the `ON CONFLICT` target with an expression is rejected, stop and report back; don't work around it silently.

Clean up: `npx wrangler d1 execute sharpflow-db --local --command "DELETE FROM edges WHERE event_id='e1'"`

- [ ] **Step 3: Write the failing test**

```js
// worker/edgeScan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeScan } from './edgeScan.js';

// Minimal D1 stand-in: records every statement; SELECTs answer from `selects` by the
// first key (in insertion order) that the SQL contains.
function fakeDb(selects = {}) {
  const log = [];
  const stmt = (sql) => ({
    sql,
    args: [],
    bind(...args) { this.args = args; return this; },
    async all() {
      log.push({ sql, args: this.args });
      const key = Object.keys(selects).find((k) => sql.includes(k));
      return { results: key ? selects[key] : [] };
    },
    async run() { log.push({ sql, args: this.args }); return {}; },
  });
  return {
    log,
    prepare: (sql) => stmt(sql),
    async batch(stmts) { for (const s of stmts) log.push({ sql: s.sql, args: s.args }); return []; },
  };
}

const DISCOVERY = Date.parse('2026-09-24T16:01:00Z');
const QUIET = Date.parse('2026-09-24T16:06:00Z');

const evt = {
  id: 'evt1', sport_key: 'americanfootball_nfl', commence_time: '2026-09-25T00:15:00Z',
  home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons',
  bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.25 }, { name: 'Atlanta Falcons', price: 4.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 5.2 }] }] },
  ],
};

const deps = (remaining, events = [evt]) => ({
  getRemainingCredits: async () => remaining,
  fetchSharpComparison: async (_env, sport) => (sport === 'americanfootball_nfl' ? events : []),
});

const scanRows = (db) => db.log.filter((s) => s.sql.includes('INSERT INTO edge_scans'));

test('does nothing on ticks from the generation cron', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, Date.parse('2026-09-24T13:15:00Z'), deps(400));
  assert.equal(r.ran, false);
  assert.equal(db.log.length, 0);
});

test('does nothing (and records nothing) when no scan is due', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, QUIET, deps(400));
  assert.equal(r.ran, false);
  assert.equal(scanRows(db).length, 0);
});

test('paused: records a skipped discovery scan and spends nothing', async () => {
  const db = fakeDb();
  let fetched = false;
  const r = await runEdgeScan({ DB: db, EDGE_SCAN_PAUSED: 'true' }, DISCOVERY, {
    ...deps(400), fetchSharpComparison: async () => { fetched = true; return []; },
  });
  assert.equal(r.ran, false);
  assert.equal(fetched, false);
  assert.equal(scanRows(db).length, 1);
  assert.equal(scanRows(db)[0].args[2], 0); // ran = 0
});

test('budget guard: skips and records when the scan would cross the reserve', async () => {
  const db = fakeDb();
  let fetched = false;
  const r = await runEdgeScan({ DB: db, EDGE_SCAN_RESERVE: '150' }, DISCOVERY, {
    ...deps(155), fetchSharpComparison: async () => { fetched = true; return []; },
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'budget');
  assert.equal(fetched, false);
  assert.equal(scanRows(db)[0].args[3], 'budget');
});

test('discovery scan upserts found edges and records the scan', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  const r = await runEdgeScan({ DB: db }, DISCOVERY, deps(400));
  assert.equal(r.ran, true);
  assert.equal(r.kind, 'discovery');
  assert.equal(r.found, 1);
  const upserts = db.log.filter((s) => s.sql.includes('INSERT INTO edges') && s.sql.includes('ON CONFLICT'));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].args[7], 'fanduel');
  assert.equal(scanRows(db)[0].args[2], 1); // ran = 1
});

test('closing scan runs only for sports with a logged kickoff in the window, and writes closes', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z'); // window [00:11, 00:16) holds the 00:15 kickoff
  const db = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl' }],
    'FROM edges WHERE commence_time >': [
      { id: 7, event_id: 'evt1', market: 'h2h', outcome: 'Atlanta Falcons', point: null, book: 'fanduel' },
    ],
  });
  const scanned = [];
  const r = await runEdgeScan({ DB: db }, tick, {
    ...deps(400), fetchSharpComparison: async (_e, sport) => { scanned.push(sport); return [evt]; },
  });
  assert.equal(r.kind, 'closing');
  assert.deepEqual(scanned, ['americanfootball_nfl']);
  const closes = db.log.filter((s) => s.sql.includes('SET close_price'));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].args[0], 5.2); // close_price
  assert.equal(closes[0].args.at(-1), 7); // WHERE id = 7
});

test('all sport fetches failing records a skipped scan and writes no edges', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, DISCOVERY, {
    getRemainingCredits: async () => 400,
    fetchSharpComparison: async () => { throw new Error('boom'); },
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'fetch failed');
  assert.equal(db.log.filter((s) => s.sql.includes('INSERT INTO edges ')).length, 0);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test worker/edgeScan.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./edgeScan.js`.

- [ ] **Step 5: Write the implementation**

```js
// worker/edgeScan.js
// Edge logger orchestration: schedule check -> free balance check -> paid odds fetch ->
// D1 writes. All math and timing rules live in pure modules; this file only does I/O.
import { findEdges, closingUpdates, edgeKey } from './edges.js';
import {
  isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, parseReserve, toFeedIso,
} from './edgeSchedule.js';
import { EDGE_SPORTS, fetchSharpComparison, getRemainingCredits } from './oddsApi.js';

// D1 allows 50 queries per invocation on the free plan: 20 upserts + 20 close updates +
// the handful of selects/inserts around them stays under it.
const MAX_WRITES_PER_KIND = 20;

async function dueScan(db, scheduledMs) {
  if (isDiscoveryTick(scheduledMs)) return { kind: 'discovery', sports: EDGE_SPORTS };
  const { fromIso, toIso } = closingWindow(scheduledMs);
  const { results } = await db
    .prepare(`SELECT DISTINCT sport FROM edges WHERE commence_time >= ? AND commence_time < ?`)
    .bind(fromIso, toIso)
    .all();
  return { kind: 'closing', sports: results.map((r) => r.sport) };
}

function recordScan(db, { kind, sports, ran, reason = null, remaining = null, found = null }) {
  return db
    .prepare(
      `INSERT INTO edge_scans (kind, sports, ran, reason, credits_remaining, edges_found) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(kind, sports.join(','), ran, reason, remaining, found)
    .run();
}

export async function runEdgeScan(env, scheduledMs, deps = {}) {
  const fetchOdds = deps.fetchSharpComparison || fetchSharpComparison;
  const getBalance = deps.getRemainingCredits || getRemainingCredits;
  const db = env.DB;

  if (!isEdgeTick(scheduledMs)) return { ran: false, reason: 'not an edge tick' };

  const { kind, sports } = await dueScan(db, scheduledMs);
  if (sports.length === 0) return { ran: false, reason: 'nothing due' };

  if (env.EDGE_SCAN_PAUSED === 'true') {
    await recordScan(db, { kind, sports, ran: 0, reason: 'paused' });
    return { ran: false, reason: 'paused', kind };
  }

  const remaining = await getBalance(env);
  if (!withinBudget(remaining, sports.length, parseReserve(env.EDGE_SCAN_RESERVE))) {
    console.log(`[edges] ${kind} scan skipped by budget guard (remaining=${remaining})`);
    await recordScan(db, { kind, sports, ran: 0, reason: 'budget', remaining });
    return { ran: false, reason: 'budget', kind };
  }

  const results = await Promise.allSettled(sports.map((sport) => fetchOdds(env, sport, scheduledMs)));
  const events = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') events.push(...r.value);
    else console.error(`[edges] odds fetch failed for ${sports[i]}:`, r.reason?.message);
  });
  if (results.every((r) => r.status === 'rejected')) {
    await recordScan(db, { kind, sports, ran: 0, reason: 'fetch failed', remaining });
    return { ran: false, reason: 'fetch failed', kind };
  }

  // 1. Upsert edges: first_* fields stick; peak and last-seen advance.
  const found = findEdges(events, scheduledMs).sort((a, b) => b.ev - a.ev);
  if (found.length > MAX_WRITES_PER_KIND) {
    console.warn(`[edges] ${found.length} edges found, logging the top ${MAX_WRITES_PER_KIND}`);
  }
  const upserts = found.slice(0, MAX_WRITES_PER_KIND).map((e) =>
    db
      .prepare(
        `INSERT INTO edges (event_id, sport, game, commence_time, market, outcome, point, book,
           first_price, first_fair_prob, first_ev, peak_ev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, market, outcome, COALESCE(point, -9999), book)
         DO UPDATE SET peak_ev = MAX(peak_ev, excluded.first_ev), last_edge_seen_at = datetime('now')`
      )
      .bind(e.event_id, e.sport, e.game, e.commence_time, e.market, e.outcome, e.point, e.book,
        e.price, e.fair_prob, e.ev, e.ev)
  );
  if (upserts.length > 0) await db.batch(upserts);

  // 2. Refresh the closing line of every logged edge whose game hasn't started. The last
  //    write before kickoff stands as the close.
  const { results: openEdges } = await db
    .prepare(`SELECT id, event_id, market, outcome, point, book FROM edges WHERE commence_time > ?`)
    .bind(toFeedIso(scheduledMs))
    .all();
  const latest = new Map(closingUpdates(events, scheduledMs).map((c) => [edgeKey(c), c]));
  const closes = [];
  for (const row of openEdges) {
    const c = latest.get(edgeKey(row));
    if (!c) continue;
    closes.push(
      db
        .prepare(`UPDATE edges SET close_price = ?, close_fair_prob = ?, close_updated_at = datetime('now') WHERE id = ?`)
        .bind(c.price, c.fair_prob, row.id)
    );
  }
  if (closes.length > MAX_WRITES_PER_KIND) {
    console.warn(`[edges] ${closes.length} closes to refresh, writing ${MAX_WRITES_PER_KIND}`);
  }
  if (closes.length > 0) await db.batch(closes.slice(0, MAX_WRITES_PER_KIND));

  await recordScan(db, { kind, sports, ran: 1, remaining, found: found.length });
  console.log(`[edges] ${kind} scan: ${found.length} edges, ${closes.length} closes updated`);
  return { ran: true, kind, found: found.length, closesUpdated: closes.length };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, including the 7 new `edgeScan` tests.

- [ ] **Step 7: Commit**

```bash
git add worker/schema.sql worker/edgeScan.js worker/edgeScan.test.js
git commit -m "Add edge logger scan orchestration and edges/edge_scans tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin summary, cron wiring and config

**Files:**
- Create: `worker/edgeReport.js`
- Test: `worker/edgeReport.test.js`
- Modify: `worker/index.js` (imports; route table right after the `/api/admin/pipeline-status` route; the `scheduled()` fallback branch)
- Modify: `wrangler.toml` (`[vars]`)

**Interfaces:**
- Consumes: `runEdgeScan` (Task 5); the existing `requireAdmin(request, env)` and `json(body, status?)` in `index.js`.
- Produces: `summarizeEdges(edgeRows, scanRows, nowMs) → {summary, recent}`, served at `GET /api/admin/edges`.

- [ ] **Step 1: Write the failing test**

```js
// worker/edgeReport.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEdges } from './edgeReport.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const row = (o) => ({
  sport: 'americanfootball_nfl', market: 'h2h', first_price: 5.0, first_ev: 0.025,
  first_seen_at: '2026-09-24 16:01:00', last_edge_seen_at: '2026-09-24 16:01:00',
  commence_time: '2026-09-25T00:15:00Z', close_fair_prob: null, ...o,
});

test('CLV only counts games that have kicked off and have a close', () => {
  const edges = [
    row({ close_fair_prob: 0.22 }), // 5.0*0.22-1 = +0.10
    row({ close_fair_prob: 0.18 }), // 5.0*0.18-1 = -0.10
    row({ close_fair_prob: 0.30, commence_time: '2026-10-05T17:00:00Z' }), // not started: excluded
    row({ close_fair_prob: null }), // no close: excluded
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.equal(summary.clv.all.count, 2);
  assert.ok(Math.abs(summary.clv.all.avg - 0) < 1e-9);
  assert.equal(summary.clv.all.positiveShare, 0.5);
});

test('bands and the 2%+ CLV subset', () => {
  const edges = [
    row({ first_ev: 0.015, close_fair_prob: 0.25 }),
    row({ first_ev: 0.025, close_fair_prob: 0.25 }),
    row({ first_ev: 0.04, close_fair_prob: 0.25 }),
  ];
  const { summary } = summarizeEdges(edges, [], NOW);
  assert.deepEqual(summary.byBand, { '1-2%': 1, '2-3%': 1, '3%+': 1 });
  assert.equal(summary.clv.twoPlus.count, 2);
});

test('median lifetime in minutes', () => {
  const edges = [
    row({ last_edge_seen_at: '2026-09-24 16:01:00' }), // 0
    row({ last_edge_seen_at: '2026-09-24 16:31:00' }), // 30
    row({ last_edge_seen_at: '2026-09-24 18:01:00' }), // 120
  ];
  assert.equal(summarizeEdges(edges, [], NOW).summary.medianLifetimeMinutes, 30);
});

test('reports skipped scans by reason so missing data is visible', () => {
  const scans = [
    { kind: 'discovery', ran: 1, reason: null },
    { kind: 'discovery', ran: 0, reason: 'budget' },
    { kind: 'closing', ran: 0, reason: 'budget' },
  ];
  const { summary } = summarizeEdges([], scans, NOW);
  assert.deepEqual(summary.scans, { ran: 1, skipped: { budget: 2 } });
});

test('empty input gives nulls, not NaN', () => {
  const { summary, recent } = summarizeEdges([], [], NOW);
  assert.equal(summary.total, 0);
  assert.equal(summary.clv.all.avg, null);
  assert.equal(summary.medianLifetimeMinutes, null);
  assert.deepEqual(recent, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test worker/edgeReport.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./edgeReport.js`.

- [ ] **Step 3: Write the implementation**

```js
// worker/edgeReport.js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test worker/edgeReport.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Wire it into `worker/index.js`**

Add the imports right after `import { dropConflictingPicks } from './pickConflicts.js';`:

```js
import { runEdgeScan } from './edgeScan.js';
import { summarizeEdges } from './edgeReport.js';
```

Add the route immediately after the `/api/admin/pipeline-status` route block:

```js
      if (pathname === '/api/admin/edges' && request.method === 'GET') {
        return handleAdminEdges(request, env);
      }
```

Add the handler directly below `handleAdminFunnel`:

```js
async function handleAdminEdges(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { results: edgeRows } = await env.DB.prepare(`SELECT * FROM edges`).all();
  const { results: scanRows } = await env.DB.prepare(`SELECT kind, ran, reason FROM edge_scans`).all();
  return json(summarizeEdges(edgeRows, scanRows, Date.now()));
}
```

In `scheduled()`, replace the final branch:

```js
    } else {
      ctx.waitUntil(handleDailyPostCheck(env));
    }
```

with:

```js
    } else {
      ctx.waitUntil(handleDailyPostCheck(env));
      // Edge logger rides the same 5-minute cron (no new trigger -- account-wide cap).
      // runEdgeScan itself ignores the generation cron's 0/15/30 ticks that also land here.
      ctx.waitUntil(
        runEdgeScan(env, event.scheduledTime).catch((err) =>
          console.error('[edges] runEdgeScan threw unexpectedly:', err.message)
        )
      );
    }
```

- [ ] **Step 6: Add the config vars to `wrangler.toml`** (in `[vars]`, after `XAI_DISCOVERY_BUDGET_CEILING_USD`)

```toml
# Edge logger (docs/superpowers/specs/2026-09-23-edge-logger-design.md). Exact "true" pauses.
EDGE_SCAN_PAUSED = "false"
# Odds API credits always left for the AI pick pipeline (free 500/month plan).
EDGE_SCAN_RESERVE = "150"
```

- [ ] **Step 7: Verify everything together**

Run: `npm test && node --check worker/index.js && npx wrangler deploy --dry-run --outdir "$TEMP/psdry"`
Expected: all tests pass; the dry-run bundle succeeds (`--dry-run: exiting now.`).

- [ ] **Step 8: Commit**

```bash
git add worker/edgeReport.js worker/edgeReport.test.js worker/index.js wrangler.toml
git commit -m "Wire the edge logger into the 5-minute cron and add /api/admin/edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Migrate, deploy, verify in production

**Files:** none (operations only). This changes production, so the controller runs it, not a subagent.

- [ ] **Step 1: Apply the schema to the production D1 database**

Run: `npm run db:migrate:remote`
Expected: success. Every statement in `schema.sql` is `IF NOT EXISTS`, so existing tables are untouched.

Verify: `npx wrangler d1 execute sharpflow-db --remote --command "SELECT name FROM sqlite_master WHERE name IN ('edges','edge_scans','edges_identity')"`
Expected: all three names.

- [ ] **Step 2: Deploy**

Run: `npm run worker:deploy`
Expected: `Current Version ID: ...`, both cron schedules listed unchanged, and `EDGE_SCAN_PAUSED ("false")` / `EDGE_SCAN_RESERVE ("150")` in the bindings.

- [ ] **Step 3: Smoke-test**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://wepicksharp.com/api/admin/edges`
Expected: `401` (the route exists and is admin-gated).

- [ ] **Step 4: Verify the first real discovery scan (next 16:01 UTC)**

After 16:01 UTC, run:
```bash
npx wrangler d1 execute sharpflow-db --remote --command "SELECT * FROM edge_scans ORDER BY id DESC LIMIT 5"
npx wrangler d1 execute sharpflow-db --remote --command "SELECT sport, market, outcome, point, book, first_price, round(first_ev*100,2) ev_pct, commence_time FROM edges ORDER BY first_ev DESC LIMIT 10"
```
Expected: one `discovery` row with `ran = 1`, or `ran = 0, reason = 'budget'` if credits are below reserve + 6 (which is correct behavior and should be reported). If it ran, edge rows exist with plausible EV (single-digit percent; a 20%+ EV means margin removal has regressed to proportional).

---

## Self-Review

- **Spec coverage:**
  - Scan request → Task 4.
  - Discovery/closing timing and no-double-scan → Task 3 plus the `isEdgeTick` guard in Task 5.
  - Budget guard and reserve → Tasks 3 and 5.
  - Kill switch → Tasks 5 and 6.
  - Shin → Task 1.
  - `findEdges` / `closingUpdates`, exact points → Task 2.
  - `edges` table and expression index → Task 5.
  - Upsert, close refresh and batching within D1 limits → Task 5.
  - CLV at read time and admin summary, including skipped scans → Task 6.
  - Error handling (catch in `scheduled`, per-sport isolation, all-failed no-op) → Tasks 5 and 6.
  - Testing section → each task, plus Task 7's production check.
  - Addition: the `edge_scans` table (needed for the spec's skipped-scan requirement), noted under File Structure.
- **Placeholders:** none. Every code step has complete code.
- **Type consistency:**
  - `edgeKey` is used identically on `Comparison` objects and on DB rows (both carry `event_id, market, outcome, point, book`).
  - `closingWindow` returns `{fromIso, toIso}`, used in `dueScan`.
  - `withinBudget(remaining, sportsCount, reserve)` has the same arity in the tests and in `edgeScan`.
  - `summarizeEdges(edgeRows, scanRows, nowMs)` has the same signature in the handler and the tests.
  - `MAX_WRITES_PER_KIND` is used for both upserts and closes.
