# Audience Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the daily discovery scan's free odds data into search-indexable odds pages, free calculators, a daily edge email, a daily X price-gap post and an admin reply kit, all feeding one email list with source tracking.

**Architecture:** The 16:01 UTC discovery scan writes one JSON odds snapshot per sport to D1 (pure builder in `oddsSnapshot.js`). The Worker renders `/odds`, `/odds/:sport/:slug`, `/tools/*`, `/sitemap.xml` and `/robots.txt` as plain HTML (pure renderers in `pages.js`, I/O in `site.js`). The 16:06 tick emails the day's new core edges instead of the AI pick. The 16:11 tick posts price gaps. An admin endpoint serves reply lines.

**Tech Stack:** Cloudflare Workers (free plan), D1, plain ES modules, `node:test`, React + Vite admin panel, Resend, X API v2.

**Spec:** `docs/superpowers/specs/2026-10-02-audience-capture-design.md`

## Global Constraints

- **0 extra Odds API credits.** Nothing here may call the Odds API. Every surface reads `odds_snapshots`.
- **Workers free plan:** 10ms CPU and 50 D1 queries per invocation. No new cron triggers (account cap of 5); new jobs ride the existing `1,6,...,56 * * * *` tick through `scheduled()`'s `else` branch in `worker/index.js`.
- **Edges never leak before kickoff.** A snapshot side with `is_edge: true` is shown on pages only as a teaser until kickoff, and never appears in the price-gap post or the reply kit.
- **Escape every feed value** in HTML (team names come from the Odds API).
- **X:** only posts without links ("link in bio"). Every post goes through `postTweet` in `worker/x.js`, which already logs usage. Respect `POSTING_PAUSED === 'true'`.
- **Email:** sends go through the existing `sendToList` in `worker/email.js`, with the `daily_emails` once-per-ET-day claim. Respect `EMAIL_PAUSED === 'true'` and `missingEmailConfig`.
- **Responsible-gambling footer on every public page:** "21+ · Gambling problem? Call 1-800-GAMBLER".
- **Signup sources** must match `/^[a-z0-9_-]{1,32}$/` (enforced by `handleSubscribe`). Values: `x_reply`, `x_post`, `game_page`, `odds_index`, `tool`, `email`, `picks_page`.
- **Tests:** `node --test worker/*.test.js` must pass after every task. `npx vite build` must pass after any task touching `src/`.
- **Line endings:** the repo's worker files are CRLF. Edit with tools that preserve that (the Edit tool does).
- **Deploys and remote D1 changes are the owner's job.** Never run `wrangler deploy` or `--remote` writes.

## Deliberate deviations from the spec (decided while planning)

1. **Slugs use full team names,** e.g. `jacksonville-jaguars-at-cincinnati-bengals-2026-10-04`. They can't collide (the same two teams never play twice on one ET date), they're stable across days, and they match how people search ("Jaguars Bengals odds" and "Jacksonville Cincinnati odds"). This replaces the spec's mascot slugs and collision rule.
2. **Markets Pinnacle doesn't price are skipped.** Without a Pinnacle market there's no main line and no fair price; NFL/NCAAF almost always have one.
3. **The sitemap lists the games in the latest snapshot per sport** (the coming week), plus the static pages. Parsing 14 days of snapshots per sitemap request would risk the 10ms CPU limit. Past game pages stay reachable and indexed; they just leave the sitemap.

## File map

| File | Status | Responsibility |
|---|---|---|
| `worker/oddsSnapshot.js` | create | Pure: `buildSnapshot(events, nowMs)`, slugs, sport paths, ET ISO date |
| `worker/schema.sql` | modify | `odds_snapshots` and `price_gap_posts` tables |
| `worker/edgeScan.js` | modify | Discovery writes the snapshot (own try/catch) |
| `worker/pages.js` | create | Pure HTML/XML/text renderers, signup form, calculator JS |
| `worker/site.js` | create | I/O for public pages: routing, D1 reads, status codes, `safeReturnPath` |
| `worker/index.js` | modify | Route site paths; form-encoded `/api/subscribe`; new ticks; reply-kit endpoint; drop AI email |
| `wrangler.toml` | modify | `run_worker_first` gains site paths; `CF_ANALYTICS_TOKEN` var |
| `worker/edgeEmail.js` | create | Pure: `selectEmailEdges`, `composeEdgeEmail` |
| `worker/email.js` | modify | Extract `sendOncePerDay(env, compose)`; add `sendEdgeEmail` |
| `worker/priceGaps.js` | create | Pure: `isPriceGapTick`, `selectPriceGaps`, `composePriceGapTweet` |
| `worker/replyKit.js` | create | Pure: `buildReplyKit(games, siteUrl, nowMs)` |
| `worker/db.js` | modify | Funnel adds signups by source (7d/28d) |
| `src/lib/api.js`, `src/pages/AdminPanel.jsx`, `src/components/EmailCapture.jsx` | modify | Reply kit section, signups by source, copy now says edges |
| `docs/reply-kit.md` | create | The owner's guide for replying |

---

### Task 1: Odds snapshot builder and storage

**Files:**
- Create: `worker/oddsSnapshot.js`, `worker/oddsSnapshot.test.js`
- Modify: `worker/schema.sql` (append), `worker/edgeScan.js` (after the write-phase try/catch, before the final `recordScan`), `worker/edgeScan.test.js` (append)

**Interfaces:**
- Consumes: `shinFairProbs(prices)` (`worker/devig.js`), `isCoreEdge(ev, market, decimalPrice)` (`worker/coreEdge.js`), `etDate(isoOrMs) -> 'YYYYMMDD'` (`worker/grading.js`).
- Produces:
  - `buildSnapshot(events, nowMs) -> Game[]`, where `Game = { event_id, sport, game, home_team, away_team, commence_time, slug, markets: { spreads?: Side[], totals?: Side[], h2h?: Side[] } }` and `Side = { outcome, point, best_price, best_book, worst_price, worst_book, books, fair_prob, is_edge }`. Prices are decimal.
  - `MARKETS = ['spreads', 'totals', 'h2h']`, `gameSlug(ev) -> string`, `slugify(name) -> string`, `etIsoDate(isoOrMs) -> 'YYYY-MM-DD'`, `sportPath(sportKey) -> 'nfl'|'ncaaf'|'nba'|null`, `sportFromPath(path) -> sportKey|null`.
  - The D1 table `odds_snapshots(sport, snapshot_date, taken_at, payload)`, with `payload = JSON.stringify(Game[])` for that sport.

- [ ] **Step 1: Write the failing tests** in `worker/oddsSnapshot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, gameSlug, slugify, etIsoDate, sportPath, sportFromPath } from './oddsSnapshot.js';

const NOW = Date.parse('2026-10-02T16:01:00Z');
const mk = (key, markets) => ({ key, markets });
const evt = {
  id: 'e1', sport_key: 'americanfootball_nfl', commence_time: '2026-10-04T17:00:00Z',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars',
  bookmakers: [
    mk('pinnacle', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 1.95 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.95 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.91 }, { name: 'Under', point: 47.5, price: 1.91 }] },
      { key: 'h2h', outcomes: [{ name: 'Cincinnati Bengals', price: 1.38 }, { name: 'Jacksonville Jaguars', price: 3.2 }] },
    ]),
    mk('fanduel', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 2.1 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.8 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.87 }, { name: 'Over', point: 48.5, price: 2.05 }] },
      { key: 'h2h', outcomes: [{ name: 'Jacksonville Jaguars', price: 3.6 }] },
    ]),
    mk('draftkings', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 1.87 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.9 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.93 }] },
    ]),
  ],
};

test('slugs use full team names and the ET kickoff date', () => {
  assert.equal(gameSlug(evt), 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04');
  // 02:30 UTC Sunday is still Saturday in ET.
  assert.equal(gameSlug({ ...evt, commence_time: '2026-10-04T02:30:00Z' }), 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-03');
  assert.equal(slugify('Texas A&M Aggies'), 'texas-a-and-m-aggies');
  assert.equal(slugify('San José State Spartans'), 'san-jose-state-spartans');
  assert.equal(slugify("Hawai'i Rainbow Warriors"), 'hawaii-rainbow-warriors');
  assert.equal(etIsoDate('2026-10-04T02:30:00Z'), '2026-10-03');
});

test('sport paths map both ways', () => {
  assert.equal(sportPath('americanfootball_ncaaf'), 'ncaaf');
  assert.equal(sportFromPath('nfl'), 'americanfootball_nfl');
  assert.equal(sportFromPath('mlb'), null);
});

test('each side gets the best and worst US price, at the main line, with the fair price', () => {
  const [g] = buildSnapshot([evt], NOW);
  assert.equal(g.slug, 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04');
  const bengals = g.markets.spreads.find((s) => s.outcome === 'Cincinnati Bengals');
  assert.deepEqual(
    { best: [bengals.best_price, bengals.best_book], worst: [bengals.worst_price, bengals.worst_book], books: bengals.books, point: bengals.point },
    { best: [2.1, 'fanduel'], worst: [1.87, 'draftkings'], books: 2, point: -2.5 }
  );
  assert.ok(Math.abs(bengals.fair_prob - 0.5) < 1e-9);
  // 2.10 * 0.5 - 1 = 5% on a spread: a core edge.
  assert.equal(bengals.is_edge, true);
  const jaguars = g.markets.spreads.find((s) => s.outcome === 'Jacksonville Jaguars');
  assert.equal(jaguars.is_edge, false);
});

test('off-main-line prices (Over 48.5) are ignored', () => {
  const [g] = buildSnapshot([evt], NOW);
  const over = g.markets.totals.find((s) => s.outcome === 'Over');
  assert.deepEqual([over.best_price, over.best_book, over.worst_price], [1.93, 'draftkings', 1.87]);
  assert.equal(over.is_edge, false); // 1.93 vs fair 2.00: worse than fair
  // No US book prices the Under, so that side is dropped.
  assert.equal(g.markets.totals.length, 1);
});

test('longshot moneylines are never edges, whatever the EV', () => {
  const [g] = buildSnapshot([evt], NOW);
  const jag = g.markets.h2h.find((s) => s.outcome === 'Jacksonville Jaguars');
  assert.ok(jag.best_price * jag.fair_prob - 1 > 0.02);
  assert.equal(jag.is_edge, false);
});

test('started games and markets Pinnacle does not price are left out', () => {
  assert.deepEqual(buildSnapshot([{ ...evt, commence_time: '2026-10-02T16:00:00Z' }], NOW), []);
  const noPin = { ...evt, bookmakers: evt.bookmakers.filter((b) => b.key !== 'pinnacle') };
  assert.deepEqual(buildSnapshot([noPin], NOW)[0].markets, {});
});

test('a full Saturday slate builds well inside the CPU budget', () => {
  const games = Array.from({ length: 80 }, (_, i) => ({
    ...evt, id: `e${i}`, home_team: `Home ${i}`, away_team: `Away ${i}`,
    bookmakers: [evt.bookmakers[0], ...Array.from({ length: 8 }, (_, b) => ({ ...evt.bookmakers[1], key: `book${b}` }))],
  }));
  const t0 = performance.now();
  for (let r = 0; r < 5; r++) JSON.stringify(buildSnapshot(games, NOW));
  const perRun = (performance.now() - t0) / 5;
  assert.ok(perRun < 5, `buildSnapshot + stringify took ${perRun.toFixed(2)}ms`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test worker/oddsSnapshot.test.js`
Expected: FAIL with `Cannot find module './oddsSnapshot.js'`.

- [ ] **Step 3: Write `worker/oddsSnapshot.js`**

```js
// The daily odds board: for every upcoming game the discovery scan fetched, each side's
// best and worst US-book price at the main line and Pinnacle's fair price. Built from the
// events the scan already paid for, so it costs no Odds API credits. Feeds the /odds pages,
// the price-gap post and the reply kit. Pure: no I/O.
import { shinFairProbs } from './devig.js';
import { isCoreEdge } from './coreEdge.js';
import { etDate } from './grading.js';

export const MARKETS = ['spreads', 'totals', 'h2h'];

const SPORT_PATHS = { americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'ncaaf', basketball_nba: 'nba' };
export const sportPath = (sport) => SPORT_PATHS[sport] || null;
export const sportFromPath = (path) => Object.keys(SPORT_PATHS).find((k) => SPORT_PATHS[k] === path) || null;

export function etIsoDate(isoOrMs) {
  const d = etDate(isoOrMs);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Full team names: the same two teams never meet twice on one ET date, so slugs can't
// collide and stay the same in every day's snapshot.
export function gameSlug(ev) {
  return `${slugify(ev.away_team)}-at-${slugify(ev.home_team)}-${etIsoDate(ev.commence_time)}`;
}

// Pinnacle's line is the main line; a market it doesn't price has no fair price, so it's
// skipped rather than guessed at.
function sidesFor(ev, marketKey) {
  const pinMarket = ev.bookmakers.find((b) => b.key === 'pinnacle')?.markets?.find((m) => m.key === marketKey);
  if (!pinMarket) return [];
  const fair = shinFairProbs((pinMarket.outcomes || []).map((o) => o.price));
  const usBooks = ev.bookmakers.filter((b) => b.key !== 'pinnacle');

  return (pinMarket.outcomes || [])
    .map((pin, i) => {
      const point = pin.point ?? null;
      const quotes = [];
      for (const book of usBooks) {
        const market = (book.markets || []).find((m) => m.key === marketKey);
        const o = (market?.outcomes || []).find((x) => x.name === pin.name && (x.point ?? null) === point);
        if (o && o.price > 1) quotes.push({ book: book.key, price: o.price });
      }
      if (quotes.length === 0) return null;
      quotes.sort((a, b) => b.price - a.price);
      const best = quotes[0];
      const worst = quotes[quotes.length - 1];
      const fair_prob = fair ? fair[i] : null;
      return {
        outcome: pin.name,
        point,
        best_price: best.price,
        best_book: best.book,
        worst_price: worst.price,
        worst_book: worst.book,
        books: quotes.length,
        fair_prob,
        // Same rule and inputs as the edges the email sends, so the teaser hides exactly those.
        is_edge: fair_prob != null && isCoreEdge(best.price * fair_prob - 1, marketKey, best.price),
      };
    })
    .filter(Boolean);
}

export function buildSnapshot(events, nowMs) {
  return (events || [])
    .filter((ev) => Date.parse(ev.commence_time) > nowMs)
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time) || String(a.id).localeCompare(String(b.id)))
    .map((ev) => {
      const markets = {};
      for (const key of MARKETS) {
        const sides = sidesFor(ev, key);
        if (sides.length > 0) markets[key] = sides;
      }
      return {
        event_id: ev.id,
        sport: ev.sport_key,
        game: `${ev.away_team} @ ${ev.home_team}`,
        home_team: ev.home_team,
        away_team: ev.away_team,
        commence_time: ev.commence_time,
        slug: gameSlug(ev),
        markets,
      };
    });
}
```

- [ ] **Step 4: Run the snapshot tests**

Run: `node --test worker/oddsSnapshot.test.js`
Expected: PASS (7 tests). If the CPU test fails, report the measured time; don't loosen the bound without telling the reviewer.

- [ ] **Step 5: Add the tables** by appending to `worker/schema.sql`:

```sql
-- Daily odds board per sport, written by the 16:01 UTC discovery scan (oddsSnapshot.js).
-- payload: JSON array of games (buildSnapshot). Rows older than 14 days are pruned.
CREATE TABLE IF NOT EXISTS odds_snapshots (
  sport TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,          -- ET date of the scan, YYYY-MM-DD
  taken_at TEXT NOT NULL,               -- ISO time of the scan
  payload TEXT NOT NULL,
  PRIMARY KEY (sport, snapshot_date)
);

-- One price-gap post per ET day (priceGaps.js). status: NULL -> sending -> posted.
CREATE TABLE IF NOT EXISTS price_gap_posts (
  date TEXT PRIMARY KEY,
  status TEXT,
  tweet_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 6: Write the failing scan tests** (append to `worker/edgeScan.test.js`):

```js
test('discovery writes the day\'s odds snapshot per sport and prunes old ones; closing scans do not', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  await runEdgeScan({ DB: db }, DISCOVERY, deps(400));
  const snap = db.log.filter((s) => s.sql.includes('INTO odds_snapshots'));
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].args.slice(0, 2), ['americanfootball_nfl', '2026-09-24']);
  assert.equal(JSON.parse(snap[0].args[3])[0].slug, 'atlanta-falcons-at-green-bay-packers-2026-09-24');
  const prune = db.log.find((s) => s.sql.includes('DELETE FROM odds_snapshots'));
  assert.deepEqual(prune.args, ['2026-09-10']);

  const closing = fakeDb({ 'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl', market: 'h2h' }], 'FROM edges WHERE commence_time >': [] });
  await runEdgeScan({ DB: closing }, Date.parse('2026-09-25T00:01:00Z'), deps(400));
  assert.equal(closing.log.some((s) => s.sql.includes('odds_snapshots')), false);
});

test('a snapshot write failure does not fail the discovery scan', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  const batch = db.batch;
  db.batch = async (stmts) => {
    if (stmts.some((s) => s.sql.includes('odds_snapshots'))) throw new Error('D1 down');
    return batch(stmts);
  };
  const r = await runEdgeScan({ DB: db }, DISCOVERY, deps(400));
  assert.equal(r.ran, true);
});
```

Run: `node --test worker/edgeScan.test.js`
Expected: the two new tests FAIL (no `odds_snapshots` statements).

- [ ] **Step 7: Write the snapshot from discovery.** In `worker/edgeScan.js`, add the import next to the other imports:

```js
import { buildSnapshot, etIsoDate } from './oddsSnapshot.js';
```

Add this function above `runEdgeScan`:

```js
const SNAPSHOT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

// Discovery only: the day's odds board for the public pages (one row per sport, plus the
// prune). Never throws -- a failure here must not cost the scan its edges.
async function writeSnapshot(db, events, scheduledMs) {
  try {
    const bySport = new Map();
    for (const g of buildSnapshot(events, scheduledMs)) {
      bySport.set(g.sport, [...(bySport.get(g.sport) || []), g]);
    }
    const date = etIsoDate(scheduledMs);
    const takenAt = new Date(scheduledMs).toISOString();
    const stmts = [...bySport].map(([sport, games]) =>
      db
        .prepare('INSERT OR REPLACE INTO odds_snapshots (sport, snapshot_date, taken_at, payload) VALUES (?, ?, ?, ?)')
        .bind(sport, date, takenAt, JSON.stringify(games))
    );
    stmts.push(db.prepare('DELETE FROM odds_snapshots WHERE snapshot_date < ?').bind(etIsoDate(scheduledMs - SNAPSHOT_KEEP_MS)));
    await db.batch(stmts);
  } catch (err) {
    console.error('[edges] odds snapshot write failed:', err.message);
  }
}
```

In `runEdgeScan`, directly before `await recordScan(db, { kind, sports, ran: 1, remaining, found: found.length });`, add:

```js
  if (kind === 'discovery') await writeSnapshot(db, events, scheduledMs);
```

- [ ] **Step 8: Run all worker tests**

Run: `node --test worker/*.test.js`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add worker/oddsSnapshot.js worker/oddsSnapshot.test.js worker/schema.sql worker/edgeScan.js worker/edgeScan.test.js
git commit -m "Save a daily odds snapshot from the discovery scan for public pages"
```

---

### Task 2: Public odds pages, signup form and routing

**Files:**
- Create: `worker/pages.js`, `worker/pages.test.js`, `worker/site.js`, `worker/site.test.js`
- Modify: `worker/index.js` (`handleSubscribe`; routing before `if (!pathname.startsWith('/api/'))`), `wrangler.toml` (`[assets]` `run_worker_first`; `[vars]` `CF_ANALYTICS_TOKEN`)

**Interfaces:**
- Consumes: Task 1's `Game`/`Side` shapes, `MARKETS`, `sportPath`, `sportFromPath`, `etIsoDate`; `americanOdds`, `selectionLabel`, `BOOK_NAMES`, `buildRecord` from `worker/record.js`.
- Produces:
  - `pages.js`: `escapeHtml(s)`, `fmtAmerican(decimal) -> '+105'|'-110'|'—'`, `signupSource(src, fallback)`, `signupForm({ source, returnTo, subscribed, error, cta })`, `layout({ title, description, canonical, body, analyticsToken })`, `renderGamePage(opts)`, `renderOddsIndex(opts)`. Task 3 adds the calculators, sitemap and robots to this same file.
  - `site.js`: `isSitePath(pathname) -> boolean`, `handleSite(request, env, nowMs?) -> Response`, `safeReturnPath(p) -> string`, `loadLatestGames(db) -> { games: Game[], takenAt: string|null }`. Tasks 5 and 6 reuse `loadLatestGames`.

- [ ] **Step 1: Write the failing renderer tests** in `worker/pages.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, fmtAmerican, signupSource, signupForm, renderGamePage, renderOddsIndex } from './pages.js';

const side = (o) => ({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 2.1, best_book: 'fanduel', worst_price: 1.87, worst_book: 'draftkings', books: 2, fair_prob: 0.5, is_edge: false, ...o });
const game = {
  event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z',
  slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04',
  markets: {
    spreads: [side({ is_edge: true }), side({ outcome: 'Jacksonville Jaguars', point: 2.5, best_price: 1.9, best_book: 'draftkings', worst_price: 1.8, worst_book: 'fanduel' })],
    totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.93, best_book: 'draftkings', fair_prob: 0.5236 })],
  },
};
const BEFORE = Date.parse('2026-10-02T17:00:00Z');
const AFTER = Date.parse('2026-10-04T21:00:00Z');
const base = { game, takenAt: '2026-10-02T16:01:00.000Z', source: 'game_page', siteUrl: 'https://wepicksharp.com' };

test('escaping and odds formatting', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(fmtAmerican(2.1), '+110');
  assert.equal(fmtAmerican(1.87), '-115');
  assert.equal(fmtAmerican(null), '—');
});

test('signup source takes a valid ?src, otherwise the page default', () => {
  assert.equal(signupSource('x_reply', 'game_page'), 'x_reply');
  assert.equal(signupSource('<script>', 'game_page'), 'game_page');
  assert.equal(signupSource(null, 'tool'), 'tool');
});

test('signup form posts the source and return path, and thanks a subscriber instead', () => {
  const f = signupForm({ source: 'x_reply', returnTo: '/odds', cta: 'Get edges' });
  assert.match(f, /method="post" action="\/api\/subscribe"/);
  assert.match(f, /name="source" value="x_reply"/);
  assert.match(f, /name="return_to" value="\/odds"/);
  assert.match(signupForm({ source: 'tool', returnTo: '/', subscribed: true }), /on the list/);
  assert.match(signupForm({ source: 'tool', returnTo: '/', error: true, cta: 'x' }), /didn't look right/);
});

test('game page before kickoff: title, prices, fair price, and edge sides hidden behind the teaser', () => {
  const html = renderGamePage({ ...base, nowMs: BEFORE });
  assert.match(html, /<title>Jacksonville Jaguars vs Cincinnati Bengals odds: best line &amp; fair price \(Oct 4\)<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/wepicksharp.com\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04"/);
  assert.match(html, /Prices as of 12:01 PM ET/);
  assert.match(html, /Jacksonville Jaguars \+2.5/);
  assert.match(html, /-111 <span class="book">DraftKings<\/span>/);
  // The edge side shows the teaser, never its price.
  assert.match(html, /Edge found on this side/);
  assert.doesNotMatch(html, /\+110 <span class="book">FanDuel/);
  assert.match(html, /1-800-GAMBLER/);
});

test('game page after kickoff reveals prices and our logged edges with results', () => {
  const revealed = [{ selection: 'Cincinnati Bengals -2.5', book: 'FanDuel', odds: 110, ev: 0.05, grade: 'win', clv: 0.021, clvEstimated: false }];
  const html = renderGamePage({ ...base, nowMs: AFTER, revealed, score: '17-24' });
  assert.doesNotMatch(html, /Edge found on this side/);
  assert.match(html, /\+110 <span class="book">FanDuel/);
  assert.match(html, /Final: Jacksonville Jaguars 17, Cincinnati Bengals 24/);
  assert.match(html, /Cincinnati Bengals -2.5 at FanDuel \+110 · 5.0% edge · WIN · CLV \+2.1%/);
});

test('team names from the feed are escaped', () => {
  const evil = { ...game, away_team: '<img src=x>', game: '<img src=x> @ Cincinnati Bengals' };
  assert.doesNotMatch(renderGamePage({ ...base, game: evil, nowMs: BEFORE }), /<img src=x>/);
});

test('odds index lists upcoming games by sport and counts today\'s edges', () => {
  const html = renderOddsIndex({ games: [game], takenAt: base.takenAt, nowMs: BEFORE, source: 'odds_index', siteUrl: base.siteUrl });
  assert.match(html, /href="\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04"/);
  assert.match(html, /<h2>NFL<\/h2>/);
  assert.match(html, /1 edge found today/);
});
```

(`fmtAmerican(1.9)` is `-111`: `americanOdds` rounds `-100 / 0.9`.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test worker/pages.test.js`
Expected: FAIL with `Cannot find module './pages.js'`.

- [ ] **Step 3: Write `worker/pages.js`**

```js
// Server-rendered public pages: plain HTML so search engines index them without running
// React. Pure string builders -- site.js loads the data and picks the status code. Every
// value that came from a feed goes through escapeHtml.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { MARKETS, sportPath } from './oddsSnapshot.js';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtAmerican(decimal) {
  const o = americanOdds(decimal);
  if (o == null) return '—';
  return o > 0 ? `+${o}` : `${o}`;
}

const bookName = (key) => BOOK_NAMES[key] || key;
const MARKET_TITLES = { spreads: 'Spread', totals: 'Total', h2h: 'Moneyline' };
const SPORT_LABELS = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'College football', basketball_nba: 'NBA' };
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const ET = 'America/New_York';
// Some ICU builds put a narrow no-break space before AM/PM; normalize it.
const timeEt = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET }).replace(/ /g, ' ');
const kickoffEt = (iso) =>
  `${new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: ET })}, ${timeEt(iso)} ET`;
const shortDateEt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET });

const SRC_PATTERN = /^[a-z0-9_-]{1,32}$/;
export function signupSource(src, fallback) {
  return typeof src === 'string' && SRC_PATTERN.test(src) ? src : fallback;
}

export function signupForm({ source, returnTo, subscribed = false, error = false, cta = 'Get every edge we find, free by email.' }) {
  if (subscribed) {
    return `<p class="ok" id="signup">✅ You're on the list. Each day's edges arrive by email after the noon ET scan.</p>`;
  }
  return `<form class="signup" id="signup" method="post" action="/api/subscribe">
  <p>${escapeHtml(cta)}</p>
  ${error ? `<p class="err">That email didn't look right. Try again?</p>` : ''}
  <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address">
  <input type="hidden" name="source" value="${escapeHtml(source)}">
  <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
  <button type="submit">Get edges free</button>
  <small>Free during our public trial. Unsubscribe anytime.</small>
</form>`;
}

const CSS = `body{margin:0;background:#0a0a0a;color:#e5e5e5;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
main,header,footer{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;gap:16px;align-items:center;border-bottom:1px solid #262626}
header a{color:#e5e5e5;text-decoration:none}header .brand{font-weight:700;margin-right:auto}
a{color:#34d399}h1{font-size:1.5rem;line-height:1.25}h2{font-size:1.15rem;margin-top:28px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:.95rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #262626}th{color:#a3a3a3;font-weight:500}
.book{color:#a3a3a3;font-size:.85em}.edge td{color:#fbbf24}.muted{color:#a3a3a3;font-size:.9rem}
.signup{margin:24px 0;padding:16px;border:1px solid #262626;border-radius:8px;background:#141414}
.signup input[type=email]{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5}
.signup button{padding:10px 16px;border:0;border-radius:6px;background:#10b981;color:#04130d;font-weight:700;cursor:pointer}
.signup small{display:block;margin-top:8px;color:#a3a3a3}.ok{color:#34d399}.err{color:#f87171}
footer{border-top:1px solid #262626;color:#a3a3a3;font-size:.85rem}
.calc label{display:block;margin:12px 0 4px}.calc input{padding:8px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5;width:140px}
.calc output{display:block;margin-top:12px;font-size:1.1rem}`;

export function layout({ title, description, canonical, body, analyticsToken }) {
  const analytics = analyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(analyticsToken)}"}'></script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="/favicon-32.png">
<style>${CSS}</style>${analytics}</head>
<body><header><a class="brand" href="/">PickSharp</a><a href="/odds">Odds</a><a href="/tools/no-vig-calculator">Tools</a><a href="/record">Record</a></header>
<main>${body}</main>
<footer><p>21+ · Gambling problem? Call 1-800-GAMBLER. Prices are a daily snapshot and can move; confirm at the book before betting.</p>
<p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></footer></body></html>`;
}

function sideRow(market, side, started) {
  const label = escapeHtml(selectionLabel({ market, outcome: side.outcome, point: side.point }));
  if (side.is_edge && !started) {
    return `<tr class="edge"><td>${label}</td><td colspan="3">🔒 Edge found on this side. <a href="#signup">Get it free by email</a></td></tr>`;
  }
  const fair = side.fair_prob == null ? '—' : fmtAmerican(1 / side.fair_prob);
  return `<tr><td>${label}</td><td>${fmtAmerican(side.best_price)} <span class="book">${escapeHtml(bookName(side.best_book))}</span></td><td>${fmtAmerican(side.worst_price)} <span class="book">${escapeHtml(bookName(side.worst_book))}</span></td><td>${fair}</td></tr>`;
}

function marketTable(market, sides, started) {
  return `<h2>${MARKET_TITLES[market]}</h2>
<table><thead><tr><th>Bet</th><th>Best price</th><th>Worst price</th><th>Fair price</th></tr></thead>
<tbody>${sides.map((s) => sideRow(market, s, started)).join('')}</tbody></table>`;
}

function revealedList(revealed) {
  if (revealed.length === 0) return '';
  const items = revealed
    .map((e) => {
      const odds = e.odds > 0 ? `+${e.odds}` : `${e.odds}`;
      const clv = e.clv == null ? 'no close' : `CLV ${pct(e.clv)}${e.clvEstimated ? ' (est.)' : ''}`;
      return `<li>${escapeHtml(e.selection)} at ${escapeHtml(e.book)} ${odds} · ${(e.ev * 100).toFixed(1)}% edge · ${escapeHtml(String(e.grade).toUpperCase())} · ${clv}</li>`;
    })
    .join('');
  return `<h2>Our logged edges on this game</h2><ul>${items}</ul><p class="muted">Every edge we log is graded on <a href="/record">our public record</a>, wins and losses.</p>`;
}

// opts: { game, takenAt, nowMs, revealed?, score? ('away-home'), source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderGamePage({ game, takenAt, nowMs, revealed = [], score = null, source, subscribed, error, siteUrl, analyticsToken }) {
  const started = Date.parse(game.commence_time) <= nowMs;
  const path = `/odds/${sportPath(game.sport)}/${game.slug}`;
  const matchup = `${game.away_team} vs ${game.home_team}`;
  const tables = MARKETS.filter((m) => game.markets[m]?.length).map((m) => marketTable(m, game.markets[m], started)).join('');
  const [away, home] = score ? score.split('-') : [];
  const body = `<h1>${escapeHtml(matchup)} odds</h1>
<p class="muted">${escapeHtml(SPORT_LABELS[game.sport] || '')} · Kickoff ${kickoffEt(game.commence_time)} · Prices as of ${timeEt(takenAt)} ET</p>
${score ? `<p><strong>Final: ${escapeHtml(game.away_team)} ${escapeHtml(away)}, ${escapeHtml(game.home_team)} ${escapeHtml(home)}</strong></p>` : ''}
<p>The best and worst price across US sportsbooks for each bet, next to the fair price: Pinnacle's line with the bookmaker's margin removed. A price better than fair is an edge.</p>
${tables || '<p>No lines posted yet.</p>'}
${started ? revealedList(revealed) : ''}
${signupForm({ source, returnTo: path, subscribed, error, cta: started ? 'Get the next edges free by email.' : 'Get every edge we find, free by email, before kickoff.' })}`;
  return layout({
    title: `${matchup} odds: best line & fair price (${shortDateEt(game.commence_time)})`,
    description: `${matchup} odds compared across DraftKings, FanDuel, BetMGM, Caesars and more, with the no-vig fair price for the spread, total and moneyline.`,
    canonical: `${siteUrl}${path}`,
    body,
    analyticsToken,
  });
}

// opts: { games, takenAt, nowMs, source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderOddsIndex({ games, takenAt, nowMs, source, subscribed, error, siteUrl, analyticsToken }) {
  const upcoming = games.filter((g) => Date.parse(g.commence_time) > nowMs);
  const edgeCount = upcoming.reduce((n, g) => n + Object.values(g.markets).flat().filter((s) => s.is_edge).length, 0);
  const bySport = new Map();
  for (const g of upcoming) bySport.set(g.sport, [...(bySport.get(g.sport) || []), g]);
  const sections = [...bySport]
    .map(([sport, list]) => `<h2>${escapeHtml(SPORT_LABELS[sport] || sport)}</h2><table><tbody>${list
      .map((g) => `<tr><td><a href="/odds/${sportPath(g.sport)}/${g.slug}">${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}</a></td><td class="muted">${kickoffEt(g.commence_time)}</td></tr>`)
      .join('')}</tbody></table>`)
    .join('');
  const body = `<h1>Football odds: best lines and fair prices</h1>
<p class="muted">${takenAt ? `Prices as of ${timeEt(takenAt)} ET, ${shortDateEt(takenAt)}` : 'Prices update daily around noon ET'}</p>
<p><strong>${edgeCount} edge${edgeCount === 1 ? '' : 's'} found today.</strong> Each one is a price better than fair at a US book.</p>
${signupForm({ source, returnTo: '/odds', subscribed, error, cta: 'Get them free by email.' })}
${sections || '<p>No upcoming games in today\'s scan.</p>'}`;
  return layout({
    title: 'NFL & college football odds: best lines and fair prices today',
    description: 'Compare NFL and college football odds across US sportsbooks, with the no-vig fair price for every spread, total and moneyline.',
    canonical: `${siteUrl}/odds`,
    body,
    analyticsToken,
  });
}
```

- [ ] **Step 4: Run the renderer tests**

Run: `node --test worker/pages.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing site tests** in `worker/site.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSitePath, safeReturnPath, handleSite } from './site.js';

const game = {
  event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z',
  slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04', markets: {},
};
const snapRow = { sport: 'americanfootball_nfl', snapshot_date: '2026-10-02', taken_at: '2026-10-02T16:01:00.000Z', payload: JSON.stringify([game]) };

// D1 stand-in: answers by the first key the SQL contains.
const fakeDb = (answers) => ({
  prepare: (sql) => ({
    bind() { return this; },
    async all() { const k = Object.keys(answers).find((x) => sql.includes(x)); return { results: k ? answers[k] : [] }; },
    async first() { const k = Object.keys(answers).find((x) => sql.includes(x)); return k ? answers[k][0] ?? null : null; },
  }),
});
const env = (answers = {}) => ({ DB: fakeDb(answers), PUBLIC_SITE_URL: 'https://wepicksharp.com' });
const get = (path, e, nowMs = Date.parse('2026-10-02T18:00:00Z')) => handleSite(new Request(`https://wepicksharp.com${path}`), e, nowMs);

test('site paths', () => {
  for (const p of ['/odds', '/odds/nfl/x', '/tools/ev-calculator', '/sitemap.xml', '/robots.txt']) assert.equal(isSitePath(p), true, p);
  for (const p of ['/', '/record', '/api/odds', '/oddsx']) assert.equal(isSitePath(p), false, p);
});

test('return paths must be same-site paths', () => {
  assert.equal(safeReturnPath('/odds/nfl/x'), '/odds/nfl/x');
  assert.equal(safeReturnPath('//evil.com'), '/odds');
  assert.equal(safeReturnPath('https://evil.com'), '/odds');
  assert.equal(safeReturnPath(undefined), '/odds');
});

test('a known game page renders from the snapshot', async () => {
  const res = await get('/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply', env({ 'FROM odds_snapshots': [snapRow] }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Jacksonville Jaguars vs Cincinnati Bengals odds/);
  assert.match(html, /name="source" value="x_reply"/);
});

test('unknown sport or slug is 404; a slug older than the 14-day window is 410', async () => {
  assert.equal((await get('/odds/mlb/a-at-b-2026-10-04', env())).status, 404);
  assert.equal((await get('/odds/nfl/a-at-b-2026-10-04', env({ 'FROM odds_snapshots': [snapRow] }))).status, 404);
  assert.equal((await get('/odds/nfl/a-at-b-2026-09-01', env())).status, 410);
  assert.equal((await get('/odds/nfl/not-a-slug', env())).status, 404);
});

test('odds index renders the latest snapshot', async () => {
  const res = await get('/odds', env({ 'FROM odds_snapshots': [snapRow] }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /jacksonville-jaguars-at-cincinnati-bengals-2026-10-04/);
});
```

Run: `node --test worker/site.test.js`
Expected: FAIL with `Cannot find module './site.js'`.

- [ ] **Step 6: Write `worker/site.js`**

```js
// I/O for the public pages: reads odds_snapshots (and, after kickoff, the game's logged
// edges), then hands plain data to pages.js. Responses are cached for 5 minutes at the edge,
// which keeps crawler traffic off D1 and inside the CPU budget.
import { renderGamePage, renderOddsIndex, signupSource } from './pages.js';
import { sportFromPath } from './oddsSnapshot.js';
import { buildRecord } from './record.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 14;

export function isSitePath(pathname) {
  return (
    pathname === '/odds' ||
    pathname.startsWith('/odds/') ||
    pathname.startsWith('/tools/') ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt'
  );
}

// Where the signup form sends the visitor back to. Same-site paths only, so the form can't
// be used as an open redirect.
export function safeReturnPath(p) {
  return typeof p === 'string' && p.length <= 300 && /^\/(?!\/)[^\s\\]*$/.test(p) ? p : '/odds';
}

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=300' : 'public, max-age=60' },
  });

// The newest snapshot of each sport, merged and sorted by kickoff.
export async function loadLatestGames(db) {
  const { results } = await db
    .prepare(
      `SELECT sport, snapshot_date, taken_at, payload FROM odds_snapshots o
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM odds_snapshots WHERE sport = o.sport)`
    )
    .all();
  const games = results.flatMap((r) => JSON.parse(r.payload));
  games.sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  const takenAt = results.map((r) => r.taken_at).sort().at(-1) || null;
  return { games, takenAt };
}

// A game appears in every snapshot from up to 7 days before kickoff; the newest one taken
// on or before its kickoff date has its last pre-game prices.
async function loadGame(db, sport, slug, gameDate) {
  const { results } = await db
    .prepare('SELECT taken_at, payload FROM odds_snapshots WHERE sport = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 2')
    .bind(sport, gameDate)
    .all();
  for (const row of results) {
    const game = JSON.parse(row.payload).find((g) => g.slug === slug);
    if (game) return { game, takenAt: row.taken_at };
  }
  return null;
}

async function loadReveal(db, game, nowMs) {
  const { results } = await db
    .prepare(
      `SELECT e.*, g.home_team, g.away_team, g.home_score, g.away_score, g.status AS result_status
       FROM edges e LEFT JOIN game_results g ON g.event_id = e.event_id WHERE e.event_id = ?`
    )
    .bind(game.event_id)
    .all();
  const revealed = buildRecord(results, nowMs).edges;
  const final = results.find((r) => r.result_status === 'final');
  return { revealed, score: final ? `${final.away_score}-${final.home_score}` : null };
}

function formState(url) {
  return { subscribed: url.searchParams.get('subscribed') === '1', error: url.searchParams.get('subscribe_error') === '1' };
}

export async function handleSite(request, env, nowMs = Date.now()) {
  const url = new URL(request.url);
  const { pathname } = url;
  const siteUrl = env.PUBLIC_SITE_URL || url.origin;
  const common = { siteUrl, analyticsToken: env.CF_ANALYTICS_TOKEN, ...formState(url) };
  const src = url.searchParams.get('src');

  if (pathname === '/odds') {
    const { games, takenAt } = await loadLatestGames(env.DB);
    return html(renderOddsIndex({ ...common, games, takenAt, nowMs, source: signupSource(src, 'odds_index') }));
  }

  const match = pathname.match(/^\/odds\/([a-z]+)\/([a-z0-9-]+)$/);
  if (match) {
    const sport = sportFromPath(match[1]);
    const dateMatch = match[2].match(/(\d{4}-\d{2}-\d{2})$/);
    if (!sport || !dateMatch) return html('<h1>Not found</h1>', 404);
    const found = await loadGame(env.DB, sport, match[2], dateMatch[1]);
    if (!found) {
      const expired = Date.parse(`${dateMatch[1]}T23:59:59Z`) < nowMs - KEEP_DAYS * DAY_MS;
      return expired ? html('<h1>This game\'s odds page has expired</h1><p><a href="/odds">Today\'s odds</a></p>', 410) : html('<h1>Not found</h1>', 404);
    }
    const started = Date.parse(found.game.commence_time) <= nowMs;
    const reveal = started ? await loadReveal(env.DB, found.game, nowMs) : { revealed: [], score: null };
    return html(renderGamePage({ ...common, ...found, ...reveal, nowMs, source: signupSource(src, 'game_page') }));
  }

  return html('<h1>Not found</h1>', 404);
}
```

- [ ] **Step 7: Run the site tests**

Run: `node --test worker/site.test.js`
Expected: PASS.

- [ ] **Step 8: Accept the HTML form in `/api/subscribe`.** In `worker/index.js`, add to the imports:

```js
import { isSitePath, handleSite, safeReturnPath } from './site.js';
```

Replace the whole `handleSubscribe` function with:

```js
// JSON from the React app; a plain form POST from the server-rendered pages, which get a
// 303 back to the page they came from (with ?subscribed=1 or ?subscribe_error=1).
async function handleSubscribe(request, env) {
  const isForm = (request.headers.get('Content-Type') || '').includes('application/x-www-form-urlencoded');
  const body = isForm ? Object.fromEntries(await request.formData()) : await request.json().catch(() => ({}));
  const { email: rawEmail, buyer_token, source } = body;
  const fail = (message) => {
    if (!isForm) return json({ error: message }, 400);
    return Response.redirect(new URL(`${safeReturnPath(body.return_to)}?subscribe_error=1#signup`, request.url).toString(), 303);
  };
  const email = normalizeEmail(rawEmail);
  if (!email) return fail('Please enter a valid email address');
  if (buyer_token !== undefined && (typeof buyer_token !== 'string' || buyer_token.length > 64)) {
    return fail('invalid buyer_token');
  }
  if (source !== undefined && (typeof source !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(source))) {
    return fail('invalid source');
  }
  await insertEmailSignup(env.DB, { email, buyerToken: buyer_token, source });
  // Signing up again is an explicit opt back in after an earlier unsubscribe.
  await env.DB.prepare('DELETE FROM email_unsubscribes WHERE email = ?').bind(email).run();
  if (isForm) {
    return Response.redirect(new URL(`${safeReturnPath(body.return_to)}?subscribed=1#signup`, request.url).toString(), 303);
  }
  return json({ ok: true });
}
```

- [ ] **Step 9: Route the site paths.** In `worker/index.js`'s `fetch`, directly above:

```js
      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }
```

insert:

```js
      if (isSitePath(pathname) && request.method === 'GET') {
        return await handleSite(request, env);
      }
```

- [ ] **Step 10: Let the Worker answer those paths before static assets.** In `wrangler.toml` change

```toml
run_worker_first = ["/api/*"]
```

to

```toml
run_worker_first = ["/api/*", "/odds", "/odds/*", "/tools/*", "/sitemap.xml", "/robots.txt"]
```

and add under `[vars]`, next to `PUBLIC_SITE_URL`:

```toml
# Cloudflare Web Analytics token for the server-rendered /odds and /tools pages. Empty
# leaves the beacon off. Public by design (it ships in page HTML), so it's a var, not a secret.
CF_ANALYTICS_TOKEN = ""
```

- [ ] **Step 11: Run all worker tests**

Run: `node --test worker/*.test.js`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add worker/pages.js worker/pages.test.js worker/site.js worker/site.test.js worker/index.js wrangler.toml
git commit -m "Serve server-rendered odds pages with an email signup form"
```

---

### Task 3: Calculators, sitemap and robots.txt

**Files:**
- Modify: `worker/pages.js` (append), `worker/pages.test.js` (append), `worker/site.js` (`handleSite` branches), `worker/site.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `layout`, `signupForm`, `escapeHtml`, `loadLatestGames`; `shinFairProbs` (`worker/devig.js`, test only).
- Produces: `CALC_JS` (string of browser JS that defines `toDecimal`, `toAmerican`, `shinFair`), `renderNoVigCalculator(opts)`, `renderEvCalculator(opts)`, `renderSitemap(siteUrl, entries: { path, lastmod? }[])`, `robotsTxt(siteUrl)`. Opts: `{ source, subscribed?, error?, siteUrl, analyticsToken? }`.

- [ ] **Step 1: Write the failing tests.** Add these imports at the top of `worker/pages.test.js`, next to the existing ones:

```js
import { CALC_JS, renderNoVigCalculator, renderEvCalculator, renderSitemap, robotsTxt } from './pages.js';
import { shinFairProbs } from './devig.js';
```

and append:

```js
const calc = new Function(`${CALC_JS}; return { toDecimal, toAmerican, shinFair };`)();

test('the browser calculator math matches the engine', () => {
  assert.equal(calc.toDecimal(-110), 1 + 100 / 110);
  assert.equal(calc.toDecimal(150), 2.5);
  assert.equal(calc.toAmerican(2.5), 150);
  assert.equal(calc.toAmerican(1.5), -200);
  for (const pair of [[1.91, 1.91], [1.5, 2.7], [1.2, 5.5], [3.2, 1.38]]) {
    const js = calc.shinFair(pair);
    const engine = shinFairProbs(pair);
    assert.ok(Math.abs(js[0] - engine[0]) < 1e-9 && Math.abs(js[1] - engine[1]) < 1e-9, String(pair));
  }
  assert.equal(calc.shinFair([1.9, 2.2]), null); // no margin to remove
});

test('calculator pages carry the script, a how-to, and the signup form', () => {
  const nv = renderNoVigCalculator({ source: 'tool', siteUrl: 'https://wepicksharp.com' });
  assert.match(nv, /<title>No-vig fair odds calculator/);
  assert.match(nv, /function shinFair/);
  assert.match(nv, /name="source" value="tool"/);
  const ev = renderEvCalculator({ source: 'tool', siteUrl: 'https://wepicksharp.com' });
  assert.match(ev, /<title>Expected value \(EV\) betting calculator/);
});

test('sitemap and robots', () => {
  const xml = renderSitemap('https://wepicksharp.com', [{ path: '/odds', lastmod: '2026-10-02' }, { path: '/tools/ev-calculator' }]);
  assert.match(xml, /<loc>https:\/\/wepicksharp.com\/odds<\/loc><lastmod>2026-10-02<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/wepicksharp.com\/tools\/ev-calculator<\/loc>/);
  const robots = robotsTxt('https://wepicksharp.com');
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/wepicksharp.com\/sitemap.xml/);
});
```

Append to `worker/site.test.js`:

```js
test('tools, sitemap and robots are served', async () => {
  const e = env({ 'FROM odds_snapshots': [snapRow] });
  assert.equal((await get('/tools/no-vig-calculator', e)).status, 200);
  assert.equal((await get('/tools/ev-calculator', e)).status, 200);
  assert.equal((await get('/tools/nope', e)).status, 404);
  const sm = await get('/sitemap.xml', e);
  assert.match(sm.headers.get('Content-Type'), /application\/xml/);
  const xml = await sm.text();
  assert.match(xml, /\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04/);
  assert.match(xml, /\/record/);
  const robots = await get('/robots.txt', e);
  assert.match(robots.headers.get('Content-Type'), /text\/plain/);
});
```

Run: `node --test worker/pages.test.js worker/site.test.js`
Expected: FAIL (`CALC_JS` and the others are not exported).

- [ ] **Step 2: Append the calculators, sitemap and robots to `worker/pages.js`**

```js
// Browser copy of the engine's math (devig.js shinFairProbs). pages.test.js checks the two
// agree, so the calculator never shows a different fair price than the edges use.
export const CALC_JS = `
function toDecimal(a){a=Number(a);if(!isFinite(a)||(a>-100&&a<100))return null;return a>0?1+a/100:1+100/-a}
function toAmerican(d){if(!(d>1))return null;return d>=2?Math.round((d-1)*100):-Math.round(100/(d-1))}
function shinFair(prices){
  if(!prices||prices.length!==2||prices.some(function(p){return !(p>1)}))return null;
  var x=[1/prices[0],1/prices[1]],s=x[0]+x[1];if(s<=1)return null;
  function at(z){return x.map(function(v){return(Math.sqrt(z*z+4*(1-z)*v*v/s)-z)/(2*(1-z))})}
  var lo=0,hi=0.999;for(var i=0;i<100;i++){var m=(lo+hi)/2,p=at(m);if(p[0]+p[1]>1)lo=m;else hi=m}
  var r=at(lo),t=r[0]+r[1];if(Math.abs(t-1)>1e-9)return null;return[r[0]/t,r[1]/t]}
function fmtA(a){return a==null?'—':(a>0?'+'+a:String(a))}`;

const NO_VIG_UI = `
function run(){var a=toDecimal(document.getElementById('a').value),b=toDecimal(document.getElementById('b').value),out=document.getElementById('out');
if(!a||!b){out.textContent='Enter both sides as American odds, e.g. -110 and -110.';return}
var f=shinFair([a,b]);if(!f){out.textContent='These prices have no margin to remove.';return}
var margin=(1/a+1/b-1)*100;
out.textContent='Fair odds: '+fmtA(toAmerican(1/f[0]))+' / '+fmtA(toAmerican(1/f[1]))+' · Win chance: '+(f[0]*100).toFixed(1)+'% / '+(f[1]*100).toFixed(1)+'% · Bookmaker margin: '+margin.toFixed(2)+'%'}
document.getElementById('calc').addEventListener('input',run);run();`;

const EV_UI = `
function run(){var p=toDecimal(document.getElementById('price').value),f=toDecimal(document.getElementById('fair').value),out=document.getElementById('out');
if(!p||!f){out.textContent='Enter your odds and the fair odds, e.g. +105 and -102.';return}
var ev=(p/f-1)*100;out.textContent='Expected value: '+(ev>=0?'+':'')+ev.toFixed(2)+'% per bet'+(ev>0?' (a +EV bet)':'')}
document.getElementById('calc').addEventListener('input',run);run();`;

// opts: { source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderNoVigCalculator({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<h1>No-vig fair odds calculator</h1>
<p>Enter both sides of a two-way bet (spread, total or moneyline) in American odds. The calculator removes the bookmaker's margin (the "vig") and shows the fair odds and each side's true win chance.</p>
<form class="calc" id="calc" onsubmit="return false">
<label for="a">Side A odds</label><input id="a" inputmode="numeric" value="-110">
<label for="b">Side B odds</label><input id="b" inputmode="numeric" value="-110">
<output id="out"></output></form>
<h2>How it works</h2>
<p>A book's two prices add up to more than 100% implied probability; the excess is its margin. We remove it with the Shin method, which accounts for books shading longshots more than favorites. It's the same method PickSharp uses on Pinnacle's lines to find edges: when a US book offers a better price than the fair price, the bet is +EV.</p>
<p>Next: check a price against fair with the <a href="/tools/ev-calculator">EV calculator</a>, or see <a href="/odds">today's fair prices for every game</a>.</p>
${signupForm({ source, returnTo: '/tools/no-vig-calculator', subscribed, error, cta: 'Get the bets that beat the fair price, free by email.' })}
<script>${CALC_JS}${NO_VIG_UI}</script>`;
  return layout({
    title: 'No-vig fair odds calculator (remove the vig)',
    description: 'Free no-vig calculator: remove the bookmaker margin from any two-way line and get the fair odds and true win probability.',
    canonical: `${siteUrl}/tools/no-vig-calculator`,
    body,
    analyticsToken,
  });
}

export function renderEvCalculator({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<h1>Expected value (EV) betting calculator</h1>
<p>Enter the odds you can bet and the fair odds for the same side. The calculator shows your expected profit per bet as a percentage of the stake.</p>
<form class="calc" id="calc" onsubmit="return false">
<label for="price">Your odds</label><input id="price" inputmode="numeric" value="+105">
<label for="fair">Fair odds</label><input id="fair" inputmode="numeric" value="-102">
<output id="out"></output></form>
<h2>Where the fair odds come from</h2>
<p>Use the <a href="/tools/no-vig-calculator">no-vig calculator</a> on a sharp book's line (Pinnacle is the usual reference), or take the fair price from <a href="/odds">our daily odds pages</a>. A bet is +EV when your price pays more than the fair price implies.</p>
${signupForm({ source, returnTo: '/tools/ev-calculator', subscribed, error, cta: 'Get today\'s +EV bets free by email.' })}
<script>${CALC_JS}${EV_UI}</script>`;
  return layout({
    title: 'Expected value (EV) betting calculator',
    description: 'Free EV calculator for sports bets: compare your odds to the fair odds and see your expected value per bet.',
    canonical: `${siteUrl}/tools/ev-calculator`,
    body,
    analyticsToken,
  });
}

export function renderSitemap(siteUrl, entries) {
  const urls = entries
    .map((e) => `<url><loc>${escapeHtml(siteUrl + e.path)}</loc>${e.lastmod ? `<lastmod>${escapeHtml(e.lastmod)}</lastmod>` : ''}</url>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

export function robotsTxt(siteUrl) {
  return `User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /dashboard\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}
```

- [ ] **Step 3: Serve them from `handleSite`.** In `worker/site.js`, replace the existing `./pages.js` and `./oddsSnapshot.js` import lines with:

```js
import { renderGamePage, renderOddsIndex, renderNoVigCalculator, renderEvCalculator, renderSitemap, robotsTxt, signupSource } from './pages.js';
import { etIsoDate, sportFromPath, sportPath } from './oddsSnapshot.js';
```

Then in `handleSite`, directly above the final `return html('<h1>Not found</h1>', 404);`, add:

```js
  const TOOLS = { '/tools/no-vig-calculator': renderNoVigCalculator, '/tools/ev-calculator': renderEvCalculator };
  if (TOOLS[pathname]) return html(TOOLS[pathname]({ ...common, source: signupSource(src, 'tool') }));

  if (pathname === '/robots.txt') {
    return new Response(robotsTxt(siteUrl), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }

  if (pathname === '/sitemap.xml') {
    const { games, takenAt } = await loadLatestGames(env.DB);
    const today = takenAt ? etIsoDate(takenAt) : undefined;
    const entries = [
      { path: '/odds', lastmod: today },
      { path: '/tools/no-vig-calculator' },
      { path: '/tools/ev-calculator' },
      { path: '/record', lastmod: today },
      ...games.map((g) => ({ path: `/odds/${sportPath(g.sport)}/${g.slug}`, lastmod: today })),
    ];
    return new Response(renderSitemap(siteUrl, entries), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }
```

- [ ] **Step 4: Run all worker tests**

Run: `node --test worker/*.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/pages.js worker/pages.test.js worker/site.js worker/site.test.js
git commit -m "Add no-vig and EV calculators, sitemap.xml and robots.txt"
```

---

### Task 4: Daily edge email replaces the AI pick email

**Files:**
- Create: `worker/edgeEmail.js`, `worker/edgeEmail.test.js`
- Modify: `worker/email.js` (extract `sendOncePerDay`, add `sendEdgeEmail`), `worker/index.js` (`postSlot` drops `sendDailyEmail`; new `runEdgeEmail` on the free-edge tick), `src/components/EmailCapture.jsx` (copy)

**Interfaces:**
- Consumes: `isCoreEdge` (`worker/coreEdge.js`), `americanOdds`, `selectionLabel`, `BOOK_NAMES` (`worker/record.js`), `sendToList(env, compose)` (`worker/email.js`), `isFreeEdgeTick(ms)` (`worker/freeEdge.js`, true at 16:06 UTC).
- Produces: `selectEmailEdges(rows, nowMs) -> EdgeRow[]` (edges rows, one per selection, EV descending), `composeEdgeEmail(edges, { siteUrl, unsubscribeLink, postalAddress }) -> { subject, text, html }`, `sendEdgeEmail(env, edges) -> { sent, reason?, recipients? }`.

- [ ] **Step 1: Write the failing tests** in `worker/edgeEmail.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEmailEdges, composeEdgeEmail } from './edgeEmail.js';

const NOW = Date.parse('2026-10-03T16:06:00Z');
const row = (o) => ({
  id: 1, event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  commence_time: '2026-10-04T17:00:00Z', market: 'spreads', outcome: 'Cincinnati Bengals', point: -2.5,
  book: 'fanduel', first_price: 2.1, first_fair_prob: 0.5, first_ev: 0.05, first_seen_at: '2026-10-03 16:01:30', ...o,
});

test('only core edges first seen in this scan, kicking off later, one per selection', () => {
  const rows = [
    row({}),
    row({ id: 2, book: 'espnbet', first_price: 2.05, first_ev: 0.025 }), // same selection, smaller edge
    row({ id: 3, market: 'h2h', outcome: 'Jacksonville Jaguars', point: null, first_price: 3.6, first_ev: 0.08 }), // longshot
    row({ id: 4, first_ev: 0.015, outcome: 'Over', market: 'totals', point: 47.5 }), // under 2%
    row({ id: 5, first_seen_at: '2026-10-02 16:01:30', outcome: 'Under', market: 'totals', point: 47.5 }), // yesterday's
    row({ id: 6, commence_time: '2026-10-03T16:00:00Z', outcome: 'Over', market: 'totals', point: 44 }), // already started
    row({ id: 7, outcome: 'Jacksonville Jaguars', point: 2.5, first_ev: 0.03 }),
  ];
  assert.deepEqual(selectEmailEdges(rows, NOW).map((r) => r.id), [1, 7]);
});

test('the email lists each edge with book, price, fair price, EV and kickoff, plus the trial framing and footer', () => {
  const edges = selectEmailEdges([row({}), row({ id: 7, outcome: 'Jacksonville Jaguars', point: 2.5, first_ev: 0.03, first_price: 2.06, first_fair_prob: 0.5 })], NOW);
  const { subject, text, html } = composeEdgeEmail(edges, { siteUrl: 'https://wepicksharp.com', unsubscribeLink: 'https://wepicksharp.com/u?x', postalAddress: '1 Main St' });
  assert.equal(subject, '2 edges today: Cincinnati Bengals -2.5 +110 at FanDuel');
  assert.match(text, /Cincinnati Bengals -2.5 at FanDuel \+110 \(fair \+100\) · \+5.0% EV · Sun, Oct 4, 1:00 PM ET/);
  assert.match(text, /Free during our public trial/);
  assert.match(text, /https:\/\/wepicksharp.com\/record\?src=email/);
  assert.match(text, /1 Main St/);
  assert.match(html, /https:\/\/wepicksharp.com\/u\?x/);
  assert.equal(composeEdgeEmail(edges.slice(0, 1), { siteUrl: 'x', unsubscribeLink: 'y', postalAddress: 'z' }).subject, '1 edge today: Cincinnati Bengals -2.5 +110 at FanDuel');
});

test('team names are escaped in the HTML', () => {
  const { html } = composeEdgeEmail([row({ outcome: '<b>x</b>' })], { siteUrl: 'x', unsubscribeLink: 'y', postalAddress: 'z' });
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
```

Run: `node --test worker/edgeEmail.test.js`
Expected: FAIL with `Cannot find module './edgeEmail.js'`.

- [ ] **Step 2: Write `worker/edgeEmail.js`**

```js
// The daily edge email: every core edge the 16:01 UTC scan just found, free during the
// public trial. Pure: picks the edges and writes the message; email.js sends it.
import { isCoreEdge } from './coreEdge.js';
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';

const FRESH_WITHIN_MS = 30 * 60 * 1000;
const sqlMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const selKey = (r) => [r.event_id, r.market, r.outcome, r.point ?? 'null'].join('|');

// rows: edges rows. Only prices first seen in the scan that just ran (an older first price
// may be gone), on games not yet started, core only, best book per selection.
export function selectEmailEdges(rows, nowMs) {
  const best = new Map();
  for (const r of rows) {
    if (!isCoreEdge(r.first_ev, r.market, r.first_price)) continue;
    if (nowMs - sqlMs(r.first_seen_at) > FRESH_WITHIN_MS) continue;
    if (!(Date.parse(r.commence_time) > nowMs)) continue;
    const prev = best.get(selKey(r));
    if (!prev || r.first_ev > prev.first_ev) best.set(selKey(r), r);
  }
  return [...best.values()].sort((a, b) => b.first_ev - a.first_ev);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const kickoffEt = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(/ /g, ' ');
  return `${day}, ${time} ET`;
};
const line = (e) =>
  `${selectionLabel(e)} at ${BOOK_NAMES[e.book] || e.book} ${fmt(e.first_price)} (fair ${fmt(1 / e.first_fair_prob)}) · +${(e.first_ev * 100).toFixed(1)}% EV · ${kickoffEt(e.commence_time)}`;

export function composeEdgeEmail(edges, { siteUrl, unsubscribeLink, postalAddress }) {
  const top = edges[0];
  const subject = `${edges.length} edge${edges.length === 1 ? '' : 's'} today: ${selectionLabel(top)} ${fmt(top.first_price)} at ${BOOK_NAMES[top.book] || top.book}`;
  const record = `${siteUrl}/record?src=email`;
  const trial = 'Free during our public trial. Every edge is tracked with its result and closing line on our public record.';
  const text = [
    "Today's edges (prices as of the noon ET scan; confirm at the book before betting):",
    '',
    ...edges.map((e) => `• ${e.game}\n  ${line(e)}`),
    '',
    trial,
    record,
    '',
    '21+ · Gambling problem? Call 1-800-GAMBLER.',
    `Unsubscribe: ${unsubscribeLink}`,
    postalAddress,
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#171717;max-width:560px">
<p>Today's edges <span style="color:#737373">(prices as of the noon ET scan; confirm at the book before betting)</span>:</p>
<ul>${edges.map((e) => `<li style="margin-bottom:10px"><strong>${escapeHtml(e.game)}</strong><br>${escapeHtml(line(e))}</li>`).join('')}</ul>
<p>${escapeHtml(trial)} <a href="${escapeHtml(record)}">See the record</a>.</p>
<p style="color:#737373;font-size:12px">21+ · Gambling problem? Call 1-800-GAMBLER.<br><a href="${escapeHtml(unsubscribeLink)}">Unsubscribe</a> · ${escapeHtml(postalAddress)}</p></div>`;
  return { subject, text, html };
}
```

- [ ] **Step 3: Run the edge email tests**

Run: `node --test worker/edgeEmail.test.js`
Expected: PASS. (`fair +100` comes from fair_prob 0.5 → decimal 2.0 → `+100`.)

- [ ] **Step 4: Generalize the once-a-day send.** In `worker/email.js`, add after the `usage.js` import:

```js
import { composeEdgeEmail } from './edgeEmail.js';
```

Then replace the whole `sendDailyEmail` function with:

```js
// Never throws. Sends one list email per ET day, whichever caller claims the day first.
// compose(unsubscribeLink, postalAddress) -> { subject, text, html }.
async function sendOncePerDay(env, compose) {
  if (env.EMAIL_PAUSED === 'true') return { sent: false, reason: 'EMAIL_PAUSED is set' };
  const missing = missingEmailConfig(env);
  if (missing.length > 0) return { sent: false, reason: `not configured: ${missing.join(', ')}` };

  try {
    // Claim the day first so a concurrent caller or cron redelivery can't double-send.
    const claim = await env.DB.prepare(`INSERT OR IGNORE INTO daily_emails (date) VALUES (date('now', '-4 hours'))`).run();
    if (claim.meta.changes === 0) return { sent: false, reason: 'already sent today' };

    const { recipients, delivered, errors } = await sendToList(env, compose);
    if (recipients === 0) {
      await env.DB.prepare(`UPDATE daily_emails SET recipients = 0 WHERE date = date('now', '-4 hours')`).run();
      return { sent: true, recipients: 0 };
    }

    if (delivered === 0) {
      // Nothing went out: release the claim so a later run can retry.
      await env.DB.prepare(`DELETE FROM daily_emails WHERE date = date('now', '-4 hours')`).run();
      return { sent: false, reason: `Resend rejected every batch: ${errors.join('; ')}` };
    }
    await env.DB.prepare(`UPDATE daily_emails SET recipients = ? WHERE date = date('now', '-4 hours')`)
      .bind(delivered)
      .run();
    return { sent: true, recipients: delivered, ...(errors.length > 0 && { errors }) };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// The old AI free-pick email. Kept for the manual admin path; the daily list email is
// now sendEdgeEmail.
export async function sendDailyEmail(env, pick) {
  if (env.EMAIL_PAUSED === 'true') return { sent: false, reason: 'EMAIL_PAUSED is set' };
  const missing = missingEmailConfig(env);
  if (missing.length > 0) return { sent: false, reason: `not configured: ${missing.join(', ')}` };
  if (!pick) return { sent: false, reason: 'no pick' };
  return sendOncePerDay(env, pickComposer(env, pick));
}

// Never throws. edges: selectEmailEdges output.
export async function sendEdgeEmail(env, edges) {
  if (!edges || edges.length === 0) return { sent: false, reason: 'no new core edges' };
  return sendOncePerDay(env, (unsubscribeLink, postalAddress) =>
    composeEdgeEmail(edges, { siteUrl: env.PUBLIC_SITE_URL, unsubscribeLink, postalAddress })
  );
}
```

(`sendDailyEmail` keeps its original check order -- paused, config, then pick -- so the existing `email.test.js` expectations still hold.)

- [ ] **Step 5: Check the existing email tests still pass**

Run: `node --test worker/email.test.js`
Expected: PASS.

- [ ] **Step 6: Stop the AI pick email and send edges at 16:06.** In `worker/index.js`:

(a) In `postSlot`, delete these lines:

```js
  // The list gets the same free pick as the tweet, once per day (sendDailyEmail guards
  // that), from whichever slot posts first.
  const email = await sendDailyEmail(env, freePick);
  console.log(`[${slot}] email:`, JSON.stringify(email));
```

and change `return { posted: true, tweet_id: tweetId, pick_count: picks.length, email };` to `return { posted: true, tweet_id: tweetId, pick_count: picks.length };`. Then run `grep -n "freePick" worker/index.js`; if the line in `postSlot` that computes `freePick` is now its only use there, delete it too.

(b) Add `sendEdgeEmail` to the existing `./email.js` import, and add `import { selectEmailEdges } from './edgeEmail.js';`.

(c) Add next to `runFreeEdge`:

```js
// Never throws. Emails the list every core edge the 16:01 scan just found (once per ET day).
async function runEdgeEmail(env, nowMs) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM edges WHERE first_seen_at >= datetime(?, 'unixepoch', '-1 hour')`
    )
      .bind(Math.floor(nowMs / 1000))
      .all();
    return await sendEdgeEmail(env, selectEmailEdges(results, nowMs));
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
```

(d) In `scheduled()`, inside the existing `if (isFreeEdgeTick(event.scheduledTime)) { ... }` block, add a second line:

```js
        ctx.waitUntil(runEdgeEmail(env, event.scheduledTime).then((r) => console.log('[edge-email]', JSON.stringify(r))));
```

- [ ] **Step 7: Update the React signup copy.** In `src/components/EmailCapture.jsx`, change

```jsx
        ✅ You're on the list — we'll email you the day's free pick.
```

to

```jsx
        ✅ You're on the list. Each day's edges arrive by email after the noon ET scan.
```

Read the rest of the component: any other text that promises "the day's free pick" (heading, helper text, button) must promise the day's edges instead, free during the public trial.

- [ ] **Step 8: Run tests and build**

Run: `node --test worker/*.test.js` then `npx vite build`
Expected: all PASS; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add worker/edgeEmail.js worker/edgeEmail.test.js worker/email.js worker/index.js src/components/EmailCapture.jsx
git commit -m "Email the day's core edges instead of the AI pick"
```

---

### Task 5: Daily X price-gap post

**Files:**
- Create: `worker/priceGaps.js`, `worker/priceGaps.test.js`
- Modify: `worker/index.js` (`runPriceGaps` + tick in `scheduled()`)

**Interfaces:**
- Consumes: Task 1's `Game`/`Side`; `loadLatestGames(db)` (`worker/site.js`); `americanOdds`, `selectionLabel`, `BOOK_NAMES` (`worker/record.js`); `tweetLength`, `TWEET_LIMIT`, `postTweet` (`worker/x.js`); `etDate` (`worker/grading.js`).
- Produces: `isPriceGapTick(ms)` (true at 16:11 UTC), `centsGap(bestDecimal, worstDecimal) -> number`, `selectPriceGaps(games, nowMs, { limit = 3, minCents = 15, withinMs = 36h } = {}) -> Gap[]` with `Gap = { game, market, side }`, `composePriceGapTweet(gaps) -> string`.

- [ ] **Step 1: Write the failing tests** in `worker/priceGaps.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPriceGapTick, centsGap, selectPriceGaps, composePriceGapTweet } from './priceGaps.js';
import { tweetLength } from './x.js';

const NOW = Date.parse('2026-10-03T16:11:00Z');
const side = (o) => ({ outcome: 'Cincinnati Bengals', point: null, best_price: 1.8, best_book: 'fanduel', worst_price: 1.69, worst_book: 'betmgm', books: 5, fair_prob: 0.55, is_edge: false, ...o });
const game = (o, markets) => ({
  event_id: 'e1', sport: 'americanfootball_nfl', home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars',
  commence_time: '2026-10-04T17:00:00Z', slug: 's', markets, ...o,
});

test('fires daily at 16:11 UTC only', () => {
  assert.equal(isPriceGapTick(Date.parse('2026-10-03T16:11:00Z')), true);
  assert.equal(isPriceGapTick(Date.parse('2026-10-03T16:06:00Z')), false);
});

test('cents are measured across the even-money line', () => {
  assert.equal(centsGap(1.8, 1.69), 20); // -125 vs -145
  assert.equal(centsGap(2.05, 1.95), 10); // +105 vs -105
  assert.equal(centsGap(2.5, 2.3), 20); // +150 vs +130
});

test('picks the biggest same-bet gaps of 15+ cents, skipping edges and far-off games', () => {
  const games = [
    game({}, {
      h2h: [side({}), side({ outcome: 'Jacksonville Jaguars', best_price: 2.25, best_book: 'draftkings', worst_price: 2.1, worst_book: 'fanduel' })],
      spreads: [side({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 2.1, is_edge: true, worst_price: 1.8 })],
    }),
    game({ event_id: 'e2', home_team: 'Ohio State Buckeyes', away_team: 'Iowa Hawkeyes', commence_time: '2026-10-03T19:30:00Z' }, {
      totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.95, best_book: 'williamhill_us', worst_price: 1.82, worst_book: 'draftkings' })],
    }),
    game({ event_id: 'e3', commence_time: '2026-10-06T17:00:00Z' }, { h2h: [side({ best_price: 2.5, worst_price: 1.5 })] }),
  ];
  const gaps = selectPriceGaps(games, NOW);
  // Ranked by implied-probability gap: Over 0.0366, Bengals ML 0.0362, Jaguars ML 0.0317.
  assert.deepEqual(gaps.map((g) => [g.game.event_id, g.side.outcome]), [['e2', 'Over'], ['e1', 'Cincinnati Bengals'], ['e1', 'Jacksonville Jaguars']]);
  // The Jaguars gap is exactly 15 cents (+125 vs +110) and qualifies; raising the bar drops everything.
  assert.equal(selectPriceGaps(games, NOW, { minCents: 21 }).length, 0);
});

test('the tweet names the bet, both prices and books, with no link', () => {
  const gaps = selectPriceGaps([game({}, { h2h: [side({})], totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.95, best_book: 'williamhill_us', worst_price: 1.82, worst_book: 'draftkings' })] })], NOW);
  const t = composePriceGapTweet(gaps);
  assert.match(t, /^Same bet, different price 👇/);
  assert.match(t, /Cincinnati Bengals ML: -125 FanDuel \/ -145 BetMGM/);
  assert.match(t, /Over 47.5 \(Jaguars @ Bengals\): -105 Caesars \/ -122 DraftKings/);
  assert.doesNotMatch(t, /https?:/);
  assert.ok(tweetLength(t) <= 280);
});
```

Run: `node --test worker/priceGaps.test.js`
Expected: FAIL with `Cannot find module './priceGaps.js'`.

- [ ] **Step 2: Write `worker/priceGaps.js`**

```js
// The daily "same bet, different price" post: line shopping made concrete, with no fair
// price and never an edge side, so it gives away nothing the email sells. Pure.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { tweetLength, TWEET_LIMIT } from './x.js';

const HOUR_MS = 60 * 60 * 1000;

export function isPriceGapTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() === 16 && d.getUTCMinutes() === 11;
}

// Distance in "cents" the way bettors count it: -125 to -145 is 20, +105 to -105 is 10.
const toCentsScale = (decimal) => {
  const o = americanOdds(decimal);
  return o >= 100 ? o - 100 : o + 100; // -110 -> -10, +105 -> 5
};
export function centsGap(bestDecimal, worstDecimal) {
  return toCentsScale(bestDecimal) - toCentsScale(worstDecimal);
}

export function selectPriceGaps(games, nowMs, { limit = 3, minCents = 15, withinMs = 36 * HOUR_MS } = {}) {
  const gaps = [];
  for (const game of games) {
    const kickoff = Date.parse(game.commence_time);
    if (!(kickoff > nowMs && kickoff - nowMs <= withinMs)) continue;
    for (const [market, sides] of Object.entries(game.markets)) {
      for (const side of sides) {
        if (side.is_edge || side.books < 2) continue;
        if (centsGap(side.best_price, side.worst_price) < minCents) continue;
        gaps.push({ game, market, side, size: 1 / side.worst_price - 1 / side.best_price });
      }
    }
  }
  return gaps.sort((a, b) => b.size - a.size).slice(0, limit).map(({ game, market, side }) => ({ game, market, side }));
}

const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const lastWord = (name) => String(name).trim().split(/\s+/).at(-1);
const book = (key) => BOOK_NAMES[key] || key;

function gapLine({ game, market, side }) {
  const label = selectionLabel({ market, outcome: side.outcome, point: side.point });
  const context = market === 'totals' ? ` (${lastWord(game.away_team)} @ ${lastWord(game.home_team)})` : '';
  return `${label}${context}: ${fmt(side.best_price)} ${book(side.best_book)} / ${fmt(side.worst_price)} ${book(side.worst_book)}`;
}

export function composePriceGapTweet(gaps) {
  const head = 'Same bet, different price 👇';
  const tail = 'Shopping the line is the easiest edge in betting. Full boards: link in bio. 21+';
  let lines = gaps.map(gapLine);
  while (lines.length > 1 && tweetLength([head, '', ...lines, '', tail].join('\n')) > TWEET_LIMIT) lines = lines.slice(0, -1);
  return [head, '', ...lines, '', tail].join('\n');
}
```

- [ ] **Step 3: Run the price-gap tests**

Run: `node --test worker/priceGaps.test.js`
Expected: PASS. (If the ordering assertion fails, print the computed `size` of each gap before changing anything: Over 1.95/1.82 is 0.0366, Bengals 1.80/1.69 is 0.0362, Jaguars 2.25/2.10 is 0.0317.)

- [ ] **Step 4: Post it once a day.** In `worker/index.js`, add `loadLatestGames` to the existing `./site.js` import (from Task 2) and add:

```js
import { isPriceGapTick, selectPriceGaps, composePriceGapTweet } from './priceGaps.js';
```

Add next to `runFreeEdge`:

```js
// Never throws. Posts the day's biggest same-bet price gaps to X, at most once per ET date.
async function runPriceGaps(env, nowMs) {
  try {
    if (env.POSTING_PAUSED === 'true') return { ran: false, reason: 'posting paused' };
    const { games } = await loadLatestGames(env.DB);
    const gaps = selectPriceGaps(games, nowMs);
    if (gaps.length === 0) return { ran: false, reason: 'no gaps of 15+ cents on games within 36h' };

    const date = etDate(nowMs);
    await env.DB.prepare('INSERT OR IGNORE INTO price_gap_posts (date) VALUES (?)').bind(date).run();
    const claim = await env.DB.prepare(`UPDATE price_gap_posts SET status = 'sending' WHERE date = ? AND status IS NULL`)
      .bind(date)
      .run();
    if (claim.meta.changes !== 1) return { ran: false, reason: 'already posted' };

    try {
      const tweetId = await postTweet(env, composePriceGapTweet(gaps));
      await env.DB.prepare(`UPDATE price_gap_posts SET status = 'posted', tweet_id = ? WHERE date = ?`).bind(tweetId, date).run();
      return { ran: true, tweet: tweetId, gaps: gaps.length };
    } catch (err) {
      await env.DB.prepare('UPDATE price_gap_posts SET status = NULL WHERE date = ?').bind(date).run();
      await sendAdminAlert(env, 'price-gaps', 'price-gap tweet failed', [`The price-gap post did not go out: ${err.message}`]);
      return { ran: false, reason: `failed: ${err.message}` };
    }
  } catch (err) {
    return { ran: false, reason: err.message };
  }
}
```

In `scheduled()`, after the `if (isFreeEdgeTick(...)) { ... }` block, add:

```js
      if (isPriceGapTick(event.scheduledTime)) {
        ctx.waitUntil(runPriceGaps(env, event.scheduledTime).then((r) => console.log('[price-gaps]', JSON.stringify(r))));
      }
```

Confirm `etDate`, `postTweet` and `sendAdminAlert` are already imported in `index.js` (`runFreeEdge` uses all three): `grep -n "etDate\|postTweet\|sendAdminAlert" worker/index.js | head -5`.

- [ ] **Step 5: Run all worker tests**

Run: `node --test worker/*.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/priceGaps.js worker/priceGaps.test.js worker/index.js
git commit -m "Post the day's biggest same-bet price gaps to X"
```

---

### Task 6: Reply kit (endpoint, admin section, guide)

**Files:**
- Create: `worker/replyKit.js`, `worker/replyKit.test.js`, `docs/reply-kit.md`
- Modify: `worker/index.js` (route `GET /api/admin/reply-kit`), `src/lib/api.js` (`getReplyKit`), `src/pages/AdminPanel.jsx` (new section)

**Interfaces:**
- Consumes: Task 1's `Game`/`Side`, `sportPath`; `loadLatestGames` (`worker/site.js`); `centsGap` (`worker/priceGaps.js`); `americanOdds`, `selectionLabel`, `BOOK_NAMES` (`worker/record.js`); `requireAdmin(request, env)` and `json(body, status)` (already in `worker/index.js`).
- Produces: `buildReplyKit(games, siteUrl, nowMs, { withinMs = 36h } = {}) -> { game, kickoff, url, lines: string[] }[]`; `GET /api/admin/reply-kit -> { games: ReplyKitGame[] }`; `getReplyKit()` in `src/lib/api.js`.

- [ ] **Step 1: Write the failing tests** in `worker/replyKit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyKit } from './replyKit.js';

const NOW = Date.parse('2026-10-03T16:00:00Z');
const side = (o) => ({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 1.95, best_book: 'espnbet', worst_price: 1.85, worst_book: 'betmgm', books: 6, fair_prob: 0.5, is_edge: false, ...o });
const g = (o, markets) => ({ event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals', home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z', slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04', markets, ...o });

test('two ready-to-paste lines per game from its biggest non-edge gaps, linking the board with src=x_reply', () => {
  const kit = buildReplyKit([g({}, {
    spreads: [side({}), side({ outcome: 'Jacksonville Jaguars', point: 2.5, is_edge: true, best_price: 2.2 })],
    totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.91, best_book: 'fanduel', worst_price: 1.87, worst_book: 'draftkings' })],
  })], 'https://wepicksharp.com', NOW);
  assert.equal(kit.length, 1);
  assert.equal(kit[0].url, 'https://wepicksharp.com/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply');
  assert.equal(kit[0].lines[0], 'Best price on Cincinnati Bengals -2.5 today is -105 at ESPN BET (worst -118 at BetMGM). Full board: https://wepicksharp.com/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply');
  assert.equal(kit[0].lines.length, 2);
  assert.ok(kit[0].lines.every((l) => !l.includes('Jacksonville Jaguars +2.5')), 'edge sides never appear');
});

test('only games kicking off within 36h, soonest first', () => {
  const kit = buildReplyKit([
    g({ event_id: 'late', commence_time: '2026-10-06T17:00:00Z' }, { spreads: [side({})] }),
    g({ event_id: 'soon', commence_time: '2026-10-03T19:30:00Z', slug: 'a-at-b-2026-10-03' }, { spreads: [side({})] }),
  ], 'https://wepicksharp.com', NOW);
  assert.deepEqual(kit.map((k) => k.url.includes('a-at-b')), [true]);
});
```

Run: `node --test worker/replyKit.test.js`
Expected: FAIL with `Cannot find module './replyKit.js'`.

- [ ] **Step 2: Write `worker/replyKit.js`**

```js
// Ready-to-paste X replies for the owner's manual sessions: one number-first line per bet,
// linking the game's board. Edge sides are left out, matching the public pages. Pure.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { sportPath } from './oddsSnapshot.js';
import { centsGap } from './priceGaps.js';

const HOUR_MS = 60 * 60 * 1000;
const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const book = (key) => BOOK_NAMES[key] || key;

export function buildReplyKit(games, siteUrl, nowMs, { withinMs = 36 * HOUR_MS } = {}) {
  return games
    .filter((g) => {
      const kickoff = Date.parse(g.commence_time);
      return kickoff > nowMs && kickoff - nowMs <= withinMs;
    })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))
    .map((g) => {
      const url = `${siteUrl}/odds/${sportPath(g.sport)}/${g.slug}?src=x_reply`;
      const lines = Object.entries(g.markets)
        .flatMap(([market, sides]) => sides.filter((s) => !s.is_edge && s.books >= 2).map((side) => ({ market, side })))
        .sort((a, b) => centsGap(b.side.best_price, b.side.worst_price) - centsGap(a.side.best_price, a.side.worst_price))
        .slice(0, 2)
        .map(({ market, side }) =>
          `Best price on ${selectionLabel({ market, outcome: side.outcome, point: side.point })} today is ${fmt(side.best_price)} at ${book(side.best_book)} (worst ${fmt(side.worst_price)} at ${book(side.worst_book)}). Full board: ${url}`
        );
      return { game: g.game, kickoff: g.commence_time, url, lines };
    })
    .filter((k) => k.lines.length > 0);
}
```

- [ ] **Step 3: Run the reply-kit tests**

Run: `node --test worker/replyKit.test.js`
Expected: PASS.

- [ ] **Step 4: Add the endpoint.** In `worker/index.js`, add `import { buildReplyKit } from './replyKit.js';` and, next to `handleAdminFunnel`:

```js
async function handleAdminReplyKit(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { games } = await loadLatestGames(env.DB);
  return json({ games: buildReplyKit(games, env.PUBLIC_SITE_URL, Date.now()) });
}
```

and in `fetch`, next to the `/api/admin/funnel` route:

```js
      if (pathname === '/api/admin/reply-kit' && request.method === 'GET') {
        return await handleAdminReplyKit(request, env);
      }
```

- [ ] **Step 5: Add the client call.** In `src/lib/api.js`, after `getUsage`:

```js
export async function getReplyKit() {
  const headers = await authHeaders();
  return request('/admin/reply-kit', { headers });
}
```

- [ ] **Step 6: Add the admin section.** In `src/pages/AdminPanel.jsx`:

(a) Add `getReplyKit` to the `../lib/api.js` import.

(b) Next to the other `useState` hooks (around `const [launch, setLaunch] = useState(null);`), add:

```jsx
  const [replyKit, setReplyKit] = useState(null);
  const [copied, setCopied] = useState(null);
```

(c) In the same effect that calls `getLaunchGate()`, add:

```jsx
      getReplyKit()
        .then((r) => setReplyKit(r.games))
        .catch(() => setReplyKit([]));
```

(d) Directly after the closing of the `{funnel && ( ... )}` block, add:

```jsx
      {replyKit && (
        <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="text-sm font-semibold text-white">Reply kit</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Paste by hand from the X app into game-day threads (free). Number first, ~15 a session, never the same line twice. See docs/reply-kit.md.
          </p>
          {replyKit.length === 0 && <p className="mt-3 text-sm text-neutral-400">No games in the next 36 hours.</p>}
          {replyKit.map((g) => (
            <div key={g.url} className="mt-4">
              <p className="text-sm font-medium text-white">
                {g.game} <span className="text-neutral-500">· {formatGameTime(g.kickoff)}</span>
              </p>
              {g.lines.map((line) => (
                <div key={line} className="mt-2 flex items-start gap-2">
                  <p className="flex-1 text-sm text-neutral-300">{line}</p>
                  <button
                    type="button"
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                    onClick={() => navigator.clipboard.writeText(line).then(() => setCopied(line))}
                  >
                    {copied === line ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
```

(`formatGameTime(isoString)` already exists at the top of `AdminPanel.jsx`.)

- [ ] **Step 7: Write the guide** `docs/reply-kit.md`:

```markdown
# Reply kit: 2 hours a week on X

The admin panel's **Reply kit** has ready-to-paste lines for games in the next 36 hours.
Each line gives a real price difference and links that game's odds board with
`?src=x_reply`, so signups from replies show up under that source.

## When
- Thursday evening, Saturday late morning (college), Sunday late morning (NFL).
  ~40 minutes each.

## Where
- Game-day threads from large NFL/college accounts, team beat writers, and betting
  accounts ("Who you got?", "Best bet today?", line-movement posts).
- Search X for the matchup ("Jaguars Bengals") or the team, sorted by Latest.

## How
1. Reply only where the line is relevant to the thread's question.
2. Lead with the number. Adjust the wording so it answers the person, e.g.
   "If you like the Bengals, -2.5 is -105 at ESPN BET right now vs -118 at BetMGM."
3. About 15 replies a session. Never paste the identical text twice in a session;
   X throttles duplicate replies.
4. Post from the X app (manual posts are free; API posts with links cost $0.20).

## Never
- Reply to minors or to anyone talking about gambling problems or losses they
  can't afford.
- Promise wins or call anything a lock. We sell price, not predictions.
- Reply to the same account more than once a day.

## Check what works
The admin funnel shows signups by source. After 4 weeks, compare `x_reply` with the
other sources and decide whether these 2 hours stay here.
```

- [ ] **Step 8: Run tests and build**

Run: `node --test worker/*.test.js` then `npx vite build`
Expected: all PASS; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add worker/replyKit.js worker/replyKit.test.js worker/index.js src/lib/api.js src/pages/AdminPanel.jsx docs/reply-kit.md
git commit -m "Add the X reply kit to the admin panel"
```

---

### Task 7: Signups by source in the admin funnel

**Files:**
- Create: `worker/funnel.test.js` (there is no `worker/db.test.js`)
- Modify: `worker/db.js` (`getFunnelSummary`), `src/pages/AdminPanel.jsx` (funnel block)

**Interfaces:**
- Consumes: the `email_signups(source, created_at)` table.
- Produces: `getFunnelSummary(db)` additionally returns `signups_by_source: { source: string, last_7: number, last_28: number }[]`, sorted by `last_28` descending, with `NULL` sources reported as `'unknown'`.

- [ ] **Step 1: Write the failing test** in `worker/funnel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFunnelSummary } from './db.js';

test('funnel reports signups by source for the last 7 and 28 days', async () => {
  const seen = [];
  const db = {
    prepare: (sql) => ({
      bind() { return this; },
      async all() {
        seen.push(sql);
        if (sql.includes('GROUP BY source')) return { results: [{ source: 'x_reply', last_7: 3, last_28: 5 }, { source: null, last_7: 0, last_28: 1 }] };
        return { results: [] };
      },
      async first() { return { count: 0, total: 0, today: 0 }; },
    }),
  };
  const summary = await getFunnelSummary(db);
  assert.deepEqual(summary.signups_by_source, [
    { source: 'x_reply', last_7: 3, last_28: 5 },
    { source: 'unknown', last_7: 0, last_28: 1 },
  ]);
  assert.ok(seen.some((s) => s.includes("datetime('now', '-28 days')")));
});
```

Run: `node --test worker/funnel.test.js`
Expected: FAIL (`signups_by_source` is undefined). If it fails for a different reason (the stub doesn't fit how `getFunnelSummary` calls D1, e.g. `.first()` with `.catch`), read `getFunnelSummary` in full and adjust the stub, not the function.

- [ ] **Step 2: Add the query.** Read `getFunnelSummary` in `worker/db.js` in full. Before its `return`, add:

```js
  // First-touch channel of each signup (pages pass ?src= through to the form), so the
  // owner can see which distribution channel is worth the time.
  const { results: bySource } = await db
    .prepare(
      `SELECT source,
              SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last_7,
              COUNT(*) AS last_28
       FROM email_signups WHERE created_at >= datetime('now', '-28 days')
       GROUP BY source ORDER BY last_28 DESC`
    )
    .all()
    .catch(() => ({ results: [] }));
```

and add to the returned object (keep every existing field and its order):

```js
    signups_by_source: bySource.map((r) => ({ source: r.source || 'unknown', last_7: r.last_7, last_28: r.last_28 })),
```

- [ ] **Step 3: Run the tests**

Run: `node --test worker/*.test.js`
Expected: all PASS.

- [ ] **Step 4: Show it in the admin panel.** In `src/pages/AdminPanel.jsx`, inside the `{funnel && ( ... )}` block, after the grid of counts that ends with the "Email signups" tile, add:

```jsx
          {funnel.signups_by_source?.length > 0 && (
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr><th className="py-1">Signups by source</th><th>7 days</th><th>28 days</th></tr>
              </thead>
              <tbody className="text-neutral-300">
                {funnel.signups_by_source.map((r) => (
                  <tr key={r.source}><td className="py-1">{r.source}</td><td>{r.last_7}</td><td>{r.last_28}</td></tr>
                ))}
              </tbody>
            </table>
          )}
```

- [ ] **Step 5: Run tests and build**

Run: `node --test worker/*.test.js` then `npx vite build`
Expected: all PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add worker/db.js worker/funnel.test.js src/pages/AdminPanel.jsx
git commit -m "Show email signups by source in the admin funnel"
```

---

### Task 8: Final check and owner hand-off

**Files:** none new.

- [ ] **Step 1: Full verification**

Run: `node --test worker/*.test.js` and `npx vite build`
Expected: all PASS; build succeeds. Report the test count.

- [ ] **Step 2: Local smoke test of the pages** (no remote calls). Apply the schema locally with `npx wrangler d1 execute sharpflow-db --local --file worker/schema.sql`, run `npx wrangler dev --local` in the background, then fetch `http://localhost:8787/odds`, `/tools/no-vig-calculator`, `/robots.txt` and `/sitemap.xml` and confirm 200s with HTML/XML/text bodies. (The local DB has no snapshot, so `/odds` shows "No upcoming games".) Stop the dev server afterwards; orphaned wrangler processes are a known problem in this repo.

- [ ] **Step 3: Hand off to the owner** with these steps, in order:
  1. Create the two tables in production:
     `npx wrangler d1 execute sharpflow-db --remote --command "CREATE TABLE IF NOT EXISTS odds_snapshots (sport TEXT NOT NULL, snapshot_date TEXT NOT NULL, taken_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (sport, snapshot_date)); CREATE TABLE IF NOT EXISTS price_gap_posts (date TEXT PRIMARY KEY, status TEXT, tweet_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));"`
  2. `npx wrangler deploy`
  3. After the next 16:01 UTC scan, open `https://wepicksharp.com/odds` and one game page.
  4. In Google Search Console, submit `https://wepicksharp.com/sitemap.xml`.
  5. Optional: turn on Cloudflare Web Analytics for the domain, put its token in `CF_ANALYTICS_TOKEN` in `wrangler.toml`, and redeploy.
  6. Use the Reply kit on the admin panel on game days; the guide is `docs/reply-kit.md`.
