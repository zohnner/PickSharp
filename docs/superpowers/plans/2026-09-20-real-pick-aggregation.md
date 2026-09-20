# Real Pick Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fabricated-pick pipeline with manual admin intake of real picks from PickSharp's 5 tracked X accounts, independently verified against the real tweet before ever being shown or tweeted about, with price tier derived from real market odds instead of AI-inferred confidence.

**Architecture:** The admin panel gets a "source tweet URL" field; submitting one inserts an unverified, invisible pick. `POST /api/admin/post-slot` (already the batched grounding-check pass) is extended to also re-fetch the real tweet via X's API, verify author + content match, compute a price tier from real odds, and only then mark the pick visible. No cloud routine involved — this whole flow runs through the Worker, which has no egress restriction (unlike the cloud-routine sandbox that blocked automated discovery).

**Tech Stack:** Cloudflare Workers, D1 (SQLite), vanilla `fetch` (no SDKs, matching existing `oddsApi.js`/`x.js`/`stripe.js` pattern), React/Vite frontend.

**Spec:** `docs/superpowers/specs/2026-09-19-real-pick-aggregation-design.md` (read the amendment note at the top — automated discovery is deferred, this plan implements the manual-intake phase only).

## Global Constraints

- Any pick with a `source_tweet_id` requires `game_time_utc` — no exceptions, regardless of `slot`.
- `confidence` is never admin-entered for a source-tweet pick. It's submitted as a `"medium"` placeholder, invisible until `post-slot` overwrites it with a value computed from real market odds.
- A pick with `source_tweet_id` is excluded from `/api/picks/today` (and therefore uneligible for checkout) until `verified = 1`. Manual entries with no `source_tweet_id` are unaffected — unchanged, immediate visibility.
- `author` on a source-tweet pick must be exactly one of: `@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`.
- `POSTING_PAUSED` stays `"true"` in production throughout this plan. Nothing here lifts it.
- No new test framework — this codebase has none (`package.json` has no test runner configured). Every task's verification step uses this project's established convention: `wrangler dev` locally + `curl`, matching how every prior feature in this codebase has actually been verified.
- Live end-to-end verification of anything touching the real X API is blocked until `X_BEARER_TOKEN` is obtained and set (parallel to how `ODDS_API_KEY`/`ANTHROPIC_API_KEY` blocked earlier work) — code these tasks fully, defer only the final live-key smoke test.

---

## File Structure

- `worker/schema.sql` — modified: new `picks` columns, new `ingested_tweets` table, fabricated seed data removed.
- `worker/db.js` — modified: `insertPick` accepts source-tweet fields, new `isTweetIngested`/`markPickVerified` helpers, `getTodaysPicksRaw` gains a visibility gate + opt-out param, dead `insertGeneratedPicks` removed.
- `worker/index.js` — modified: `handleAdminCreatePick` validates/forces source-tweet fields, `handlePostSlot` gains the verification+tiering pass, affiliate-link default now env-driven.
- `worker/xVerify.js` — new: raw X API v2 tweet re-fetch, one responsibility (mirrors `oddsApi.js`'s shape).
- `worker/tiering.js` — new: market-odds → price-tier computation, one responsibility.
- `src/pages/AdminPanel.jsx` — modified: source-tweet-URL field, author dropdown, slot picker, verification status display.
- `wrangler.toml` — modified: new `AFFILIATE_LINK` var.

---

### Task 1: Schema migration and db.js data-layer changes

**Files:**
- Modify: `worker/schema.sql`
- Modify: `worker/db.js`

**Interfaces:**
- Produces: `insertPick(db, pick)` (extended — now accepts `source_tweet_url`, `source_tweet_id`), `isTweetIngested(db, tweetId): Promise<boolean>`, `markPickVerified(db, id, confidence): Promise<void>`, `getTodaysPicksRaw(db, { includeUnverified = false } = {}): Promise<Array>` (now gated by default).
- Removes: `insertGeneratedPicks` (confirmed 0 call sites in current codebase — dead code from the superseded AI-generation pipeline).

- [ ] **Step 1: Update `worker/schema.sql`**

In the `picks` table definition, add three columns (after `game_time_utc TEXT,`):

```sql
CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  pick_type TEXT NOT NULL CHECK (pick_type IN ('spread', 'moneyline', 'prop', 'over_under')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  game TEXT NOT NULL,
  game_time TEXT NOT NULL,
  affiliate_link TEXT NOT NULL DEFAULT 'https://ak.draftkings.com',
  slot TEXT,
  game_time_utc TEXT,
  source_tweet_url TEXT,
  source_tweet_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Add a new table (anywhere after the `picks` table, e.g. right after `daily_posts`):

```sql
CREATE TABLE IF NOT EXISTS ingested_tweets (
  tweet_id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Delete the fabricated seed block entirely (the `INSERT INTO picks (...) VALUES ('@CodyBrownBets', 'Kansas City -5.5', ...)` block, 5 lines including the `INSERT INTO picks` header line). Leave the `picker_stats` seed `INSERT OR IGNORE` block untouched — it's unrelated (generic default stats, not fabricated pick content).

- [ ] **Step 2: Apply the migration to the local dev D1 database**

Run (from the worktree root):
```
npx wrangler d1 execute sharpflow-db --local --command "ALTER TABLE picks ADD COLUMN source_tweet_url TEXT;"
npx wrangler d1 execute sharpflow-db --local --command "ALTER TABLE picks ADD COLUMN source_tweet_id TEXT;"
npx wrangler d1 execute sharpflow-db --local --command "ALTER TABLE picks ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;"
npx wrangler d1 execute sharpflow-db --local --command "CREATE TABLE IF NOT EXISTS ingested_tweets (tweet_id TEXT PRIMARY KEY, author TEXT NOT NULL, ingested_at TEXT NOT NULL DEFAULT (datetime('now')));"
```
Expected: each command prints `🚣 Executed 1 command` with no error. (Production migration is a separate step in Task 8 — do not run these with `--remote` here.)

- [ ] **Step 3: Update `insertPick` in `worker/db.js`**

Replace the existing `insertPick` function:

```js
export async function insertPick(db, pick) {
  const {
    author, pick_text, pick_type, confidence, game, game_time,
    affiliate_link, slot, game_time_utc, source_tweet_url, source_tweet_id,
  } = pick;

  const insertStmt = db
    .prepare(
      `INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, affiliate_link, slot, game_time_utc, source_tweet_url, source_tweet_id)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'https://ak.draftkings.com'), ?, ?, ?, ?)`
    )
    .bind(
      author, pick_text, pick_type, confidence, game, game_time,
      affiliate_link || null, slot || 'manual', game_time_utc || null,
      source_tweet_url || null, source_tweet_id || null
    );

  if (source_tweet_id) {
    const ingestStmt = db
      .prepare(`INSERT INTO ingested_tweets (tweet_id, author) VALUES (?, ?)`)
      .bind(source_tweet_id, author);
    const [insertResult] = await db.batch([insertStmt, ingestStmt]);
    return insertResult.meta.last_row_id;
  }

  const result = await insertStmt.run();
  return result.meta.last_row_id;
}
```

- [ ] **Step 4: Add `isTweetIngested` and `markPickVerified` to `worker/db.js`**

Add these two new exported functions (anywhere after `insertPick`):

```js
export async function isTweetIngested(db, tweetId) {
  const row = await db.prepare('SELECT 1 FROM ingested_tweets WHERE tweet_id = ?').bind(tweetId).first();
  return Boolean(row);
}

export async function markPickVerified(db, id, confidence) {
  await db.prepare('UPDATE picks SET verified = 1, confidence = ? WHERE id = ?').bind(confidence, id).run();
}
```

- [ ] **Step 5: Remove dead `insertGeneratedPicks`**

Delete the entire `insertGeneratedPicks` function from `worker/db.js` (the one taking `(db, picks, slot)` and using `db.batch`). Confirm no other file imports it: run `grep -rn insertGeneratedPicks worker/` — expected: no output (only the definition existed, already deleted).

- [ ] **Step 6: Add the visibility gate to `getTodaysPicksRaw`**

Replace the existing function:

```js
export async function getTodaysPicksRaw(db, { includeUnverified = false } = {}) {
  const gate = includeUnverified ? '' : 'AND (p.verified = 1 OR p.source_tweet_id IS NULL)';
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
              p.affiliate_link, p.slot, p.game_time_utc, p.source_tweet_url, p.source_tweet_id, p.verified,
              p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
       FROM picks p
       LEFT JOIN picker_stats s ON s.author = p.author
       WHERE date(p.created_at, '-4 hours') = date('now', '-4 hours')
       ${gate}
       ORDER BY p.created_at ASC`
    )
    .all();
  return results;
}
```

This is called from 5 places (`handleGetPicksToday`, `handleCheckoutPick`, `handleCheckoutBundle`, `handleDailyPostCheck`, `handlePostSlot`). The first four all call it with no second argument, so they keep the safe default (gated — unverified picks stay invisible and unpurchasable). Only `handlePostSlot` needs to see unverified picks (so it can verify them) — that call site is updated in Task 5, not here.

- [ ] **Step 7: Add the new columns to `getPicks` (admin list) too**

In `getPicks`, update the `SELECT` to also return `p.slot, p.game_time_utc, p.source_tweet_url, p.source_tweet_id, p.verified` (admin should see verification status for everything, no gate needed — this is the authenticated admin's own list view).

- [ ] **Step 8: Verify locally**

```
npm run worker:dev
```
In another terminal:
```
curl -s http://localhost:8787/api/picks/today
```
Expected: `{"picks":[]}` — the fabricated seed rows are gone (schema.sql no longer seeds them, and this is a fresh local DB after Step 2's migration). No errors in the `wrangler dev` console.

- [ ] **Step 9: Commit**

```
git add worker/schema.sql worker/db.js
git commit -m "Add source-tweet columns, ingestion dedup table, and visibility gate to picks"
```

---

### Task 2: Extend `POST /api/admin/picks` to accept and validate source-tweet fields

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `isTweetIngested(db, tweetId)`, `insertPick(db, pick)` from Task 1.
- Produces: `TRACKED_AUTHORS` (const array), `parseTweetId(url)` (function) — both used again in Task 5/6.

- [ ] **Step 1: Add imports and constants**

At the top of `worker/index.js`, extend the `db.js` import to include `isTweetIngested`:

```js
import {
  getPicks,
  insertPick,
  deletePickById,
  upsertUser,
  getUserById,
  getTodaysPicksRaw,
  getPicksByIds,
  freePickId,
  getUnlockedPickIds,
  insertUnlocks,
  isTweetIngested,
} from './db.js';
```

Add near the top-level constants (after `CORS_HEADERS`):

```js
const TRACKED_AUTHORS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];

function parseTweetId(url) {
  const match = url.match(/status\/(\d+)/);
  return match ? match[1] : null;
}
```

- [ ] **Step 2: Rewrite `handleAdminCreatePick`**

Replace the existing function:

```js
async function handleAdminCreatePick(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const pick = await request.json();

  if (!pick.author || !pick.pick_text || !pick.pick_type || !pick.confidence || !pick.game || !pick.game_time) {
    return json({ error: 'Missing required pick fields' }, 400);
  }

  let sourceTweetId = null;
  if (pick.source_tweet_url) {
    sourceTweetId = parseTweetId(pick.source_tweet_url);
    if (!sourceTweetId) {
      return json({ error: 'source_tweet_url must contain a status/<id> segment' }, 400);
    }
    if (!TRACKED_AUTHORS.includes(pick.author)) {
      return json({ error: `author must be one of the tracked accounts: ${TRACKED_AUTHORS.join(', ')}` }, 400);
    }
    if (await isTweetIngested(env.DB, sourceTweetId)) {
      return json({ error: 'This tweet has already been submitted' }, 400);
    }
  }

  const needsGameTimeUtc = (pick.slot && pick.slot !== 'manual') || sourceTweetId;
  if (needsGameTimeUtc && !pick.game_time_utc) {
    return json({ error: 'game_time_utc is required for non-manual slots and for picks with a source tweet' }, 400);
  }

  const id = await insertPick(env.DB, {
    ...pick,
    affiliate_link: pick.affiliate_link || env.AFFILIATE_LINK || null,
    source_tweet_url: sourceTweetId ? pick.source_tweet_url : null,
    source_tweet_id: sourceTweetId,
    confidence: sourceTweetId ? 'medium' : pick.confidence,
  });
  return json({ id }, 201);
}
```

(The `env.AFFILIATE_LINK` fallback here is Task 7's swappable-affiliate-link piece — included now since it's the same function; Task 7 just adds the `wrangler.toml` var.)

- [ ] **Step 3: Verify locally**

With `wrangler dev` running:
```
curl -s -X POST http://localhost:8787/api/admin/picks \
  -H "x-admin-secret: test-admin-secret" -H "Content-Type: application/json" \
  -d '{"author":"@SharpFootball","pick_text":"Kansas City Chiefs -5.5","pick_type":"spread","confidence":"high","game":"Baltimore Ravens @ Kansas City Chiefs","game_time":"Sept 21 1:00 PM","game_time_utc":"2026-09-21T18:00:00Z","source_tweet_url":"https://x.com/SharpFootball/status/1234567890123456789"}'
```
Expected: `201` with an `id`. Then:
```
curl -s -X POST http://localhost:8787/api/admin/picks \
  -H "x-admin-secret: test-admin-secret" -H "Content-Type: application/json" \
  -d '{"author":"@SharpFootball","pick_text":"dup","pick_type":"spread","confidence":"high","game":"Baltimore Ravens @ Kansas City Chiefs","game_time":"x","game_time_utc":"2026-09-21T18:00:00Z","source_tweet_url":"https://x.com/SharpFootball/status/1234567890123456789"}'
```
Expected: `400 {"error":"This tweet has already been submitted"}` (same tweet ID). Then confirm the first pick is invisible on the public endpoint:
```
curl -s http://localhost:8787/api/picks/today
```
Expected: `{"picks":[]}` — the inserted pick has `verified=0`, correctly hidden by Task 1's gate.

- [ ] **Step 4: Commit**

```
git add worker/index.js
git commit -m "Validate and accept source-tweet fields on POST /api/admin/picks"
```

---

### Task 3: X API tweet re-fetch module

**Files:**
- Create: `worker/xVerify.js`

**Interfaces:**
- Produces: `fetchTweet(env, tweetId): Promise<{text: string, username: string}>`, `TweetNotFoundError` (class) — both consumed by Task 5.

- [ ] **Step 1: Write `worker/xVerify.js`**

```js
const X_API_BASE = 'https://api.x.com/2';

export class TweetNotFoundError extends Error {}

export async function fetchTweet(env, tweetId) {
  const url = `${X_API_BASE}/tweets/${tweetId}?expansions=author_id&user.fields=username`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  });

  if (res.status === 404) {
    throw new TweetNotFoundError(`Tweet ${tweetId} not found`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API request failed for tweet ${tweetId}: ${res.status} ${body}`);
  }

  const data = await res.json();
  if (!data.data) {
    throw new TweetNotFoundError(`Tweet ${tweetId} not found`);
  }

  const username = data.includes?.users?.[0]?.username;
  return { text: data.data.text, username };
}
```

- [ ] **Step 2: Verify the module loads without syntax errors**

```
node --check worker/xVerify.js
```
Expected: no output, exit code 0. (Live verification against a real tweet is deferred to Task 8 — no `X_BEARER_TOKEN` exists yet.)

- [ ] **Step 3: Commit**

```
git add worker/xVerify.js
git commit -m "Add X API v2 tweet re-fetch module for post-slot verification"
```

---

### Task 4: Market-odds price-tier computation module

**Files:**
- Create: `worker/tiering.js`

**Interfaces:**
- Produces: `computeConfidenceFromOdds(pick, oddsGames): 'high' | 'medium' | 'low'`, `findMatchingGame(pick, oddsGames)` — consumed by Task 5.

- [ ] **Step 1: Write `worker/tiering.js`**

```js
function americanToImpliedProbability(price) {
  return price >= 0 ? 100 / (price + 100) : -price / (-price + 100);
}

export function findMatchingGame(pick, oddsGames) {
  if (!pick.game_time_utc) return null;
  const pickTime = new Date(pick.game_time_utc).getTime();
  if (Number.isNaN(pickTime)) return null;
  const toleranceMs = 3 * 60 * 60 * 1000;
  const gameText = (pick.game || '').toLowerCase();

  return (
    oddsGames.find((g) => {
      const commence = new Date(g.commence_time).getTime();
      if (Number.isNaN(commence) || Math.abs(commence - pickTime) > toleranceMs) return false;
      const home = (g.home_team || '').toLowerCase();
      const away = (g.away_team || '').toLowerCase();
      return Boolean(home) && Boolean(away) && gameText.includes(home) && gameText.includes(away);
    }) || null
  );
}

function findOutcomePrice(game, marketKey, pick) {
  const text = (pick.pick_text || '').toLowerCase();
  const home = (game.home_team || '').toLowerCase();
  const away = (game.away_team || '').toLowerCase();
  let side = null;
  if (home && text.includes(home)) side = game.home_team;
  else if (away && text.includes(away)) side = game.away_team;
  if (!side) return null;

  for (const bookmaker of game.bookmakers || []) {
    const market = bookmaker.markets?.find((m) => m.key === marketKey);
    const outcome = market?.outcomes?.find((o) => o.name === side);
    if (outcome) return outcome.price;
  }
  return null;
}

export function computeConfidenceFromOdds(pick, oddsGames) {
  const game = findMatchingGame(pick, oddsGames);
  if (!game) return 'medium';

  const marketKey = pick.pick_type === 'moneyline' ? 'h2h' : pick.pick_type === 'spread' ? 'spreads' : null;
  if (!marketKey) return 'medium';

  const price = findOutcomePrice(game, marketKey, pick);
  if (price === null || price === undefined) return 'medium';

  const impliedProbability = americanToImpliedProbability(price);
  if (impliedProbability >= 0.6) return 'high';
  if (impliedProbability >= 0.45) return 'medium';
  return 'low';
}
```

Note: `over_under` and `prop` pick types fall through the `marketKey` check and always return `'medium'`, matching the spec's stated fallback (no natural favorite/underdog axis for these).

- [ ] **Step 2: Verify with a quick inline sanity check**

```
node -e "
import('./worker/tiering.js').then(({ computeConfidenceFromOdds }) => {
  const oddsGames = [{
    commence_time: '2026-09-21T18:00:00Z',
    home_team: 'Kansas City Chiefs',
    away_team: 'Baltimore Ravens',
    bookmakers: [{ markets: [{ key: 'spreads', outcomes: [
      { name: 'Kansas City Chiefs', price: -150, point: -5.5 },
      { name: 'Baltimore Ravens', price: 130, point: 5.5 },
    ] }] }],
  }];
  const pick = { pick_type: 'spread', pick_text: 'Kansas City Chiefs -5.5', game: 'Baltimore Ravens @ Kansas City Chiefs', game_time_utc: '2026-09-21T18:00:00Z' };
  console.log(computeConfidenceFromOdds(pick, oddsGames));
});
"
```
Expected: prints `high` (−150 implies ≈60% win probability, at the boundary rounding to `high`).

- [ ] **Step 3: Commit**

```
git add worker/tiering.js
git commit -m "Add market-odds-derived price tiering, replacing language-inferred confidence"
```

---

### Task 5: Integrate verification + tiering into `handlePostSlot`

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `fetchTweet`, `TweetNotFoundError` (Task 3), `computeConfidenceFromOdds` (Task 4), `markPickVerified` (Task 1).

- [ ] **Step 1: Add imports**

```js
import { fetchTweet, TweetNotFoundError } from './xVerify.js';
import { computeConfidenceFromOdds } from './tiering.js';
```
And add `markPickVerified` to the existing `db.js` import list from Task 2.

- [ ] **Step 2: Add two small helper functions**

Add near `matchesRealGame` (top of file):

```js
function verifiesAuthor(pick, tweetUsername) {
  if (!tweetUsername) return false;
  const expected = pick.author.replace(/^@/, '').toLowerCase();
  return tweetUsername.toLowerCase() === expected;
}

function verifiesContent(pick, tweetText) {
  const text = (tweetText || '').toLowerCase();
  const numberMatch = (pick.pick_text || '').match(/-?\d+(\.\d+)?/);
  if (numberMatch) return text.includes(numberMatch[0]);
  const teams = (pick.game || '').toLowerCase().split(' @ ');
  return teams.some((team) => team.trim() && text.includes(team.trim()));
}
```

- [ ] **Step 3: Rewrite `handlePostSlot`**

Replace the existing function:

```js
async function handlePostSlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  if (env.POSTING_PAUSED) return json({ error: 'Posting is paused until further notice' }, 503);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);

  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = ?`
  )
    .bind(slot)
    .first();
  if (alreadyPosted) return json({ error: 'Already posted for this slot today' }, 400);

  let picks = (await getTodaysPicksRaw(env.DB, { includeUnverified: true })).filter((p) => p.slot === slot);
  if (picks.length === 0) return json({ error: 'No picks found for this slot today' }, 400);

  const needsOdds = slot !== 'manual' || picks.some((p) => p.source_tweet_id && !p.verified);
  let oddsGames = null;
  if (needsOdds) {
    try {
      oddsGames = await getUpcomingOdds(env);
    } catch (err) {
      console.error(`[${slot}] Odds fetch failed, grounding/tiering skipped:`, err.message);
    }
  }

  if (slot !== 'manual' && oddsGames) {
    const ungrounded = picks.filter((p) => !matchesRealGame(p, oddsGames));
    if (ungrounded.length > 0) {
      await Promise.all(ungrounded.map((p) => deletePickById(env.DB, p.id)));
      const ungroundedIds = new Set(ungrounded.map((p) => p.id));
      picks = picks.filter((p) => !ungroundedIds.has(p.id));
    }
  }

  const toVerify = picks.filter((p) => p.source_tweet_id && !p.verified);
  for (const pick of toVerify) {
    let tweet;
    try {
      tweet = await fetchTweet(env, pick.source_tweet_id);
    } catch (err) {
      if (err instanceof TweetNotFoundError) {
        await deletePickById(env.DB, pick.id);
        picks = picks.filter((p) => p.id !== pick.id);
      } else {
        console.error(`[${slot}] Tweet verification skipped for pick ${pick.id}, X API failed:`, err.message);
      }
      continue;
    }

    if (!verifiesAuthor(pick, tweet.username) || !verifiesContent(pick, tweet.text)) {
      await deletePickById(env.DB, pick.id);
      picks = picks.filter((p) => p.id !== pick.id);
      continue;
    }

    const confidence = oddsGames ? computeConfidenceFromOdds(pick, oddsGames) : 'medium';
    await markPickVerified(env.DB, pick.id, confidence);
    pick.verified = 1;
    pick.confidence = confidence;
  }

  if (picks.length === 0) return json({ error: 'No picks found for this slot today' }, 400);

  if (!env.PUBLIC_SITE_URL) {
    return json({ error: 'PUBLIC_SITE_URL is not configured' }, 500);
  }

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), ?, ?)`)
    .bind(slot, tweetId)
    .run();

  return json({ tweet_id: tweetId, pick_count: picks.length });
}
```

Verification is sequential (`for...of` with `await`, not `Promise.all`) deliberately — keeps X API calls easy to reason about/debug and avoids bursting rate limits; slot batches are small (a handful of picks), so this isn't a latency concern.

- [ ] **Step 4: Verify locally (without a real X_BEARER_TOKEN — confirms the code path, not live X verification)**

With `wrangler dev` running and `.dev.vars` NOT containing `X_BEARER_TOKEN` (simulating the pre-setup state):
```
curl -s -X POST http://localhost:8787/api/admin/post-slot \
  -H "x-admin-secret: test-admin-secret" -H "Content-Type: application/json" \
  -d '{"slot":"manual"}'
```
Using the pick submitted in Task 2's Step 3 (which has no `slot` set, so it's implicitly `manual`... actually re-submit it with `"slot":"morning"` this time to exercise the non-manual path — re-run Task 2 Step 3's curl with `"slot":"morning"` added to the JSON body first). Expected with no `X_BEARER_TOKEN` configured: `fetchTweet` throws a generic (non-`TweetNotFoundError`) error since the `fetch` call itself will fail or X will reject an empty Bearer token — confirm via the `wrangler dev` console log that it prints `Tweet verification skipped for pick <id>, X API failed:` rather than crashing the request. The endpoint should still return a clean JSON response (either a successful post if `POSTING_PAUSED` is unset locally, or the existing pause/error response) — not a 500.

- [ ] **Step 5: Commit**

```
git add worker/index.js
git commit -m "Verify source-tweet picks and compute odds-based tier in post-slot"
```

---

### Task 6: Admin panel UI — source-tweet intake

**Files:**
- Modify: `src/pages/AdminPanel.jsx`

**Interfaces:**
- Consumes: `POST /api/admin/picks` (Task 2's extended contract: accepts `source_tweet_url`, `slot`).

- [ ] **Step 1: Replace `src/pages/AdminPanel.jsx`'s top constants and form state**

```js
const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];
const TRACKED_AUTHORS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];
const SLOTS = ['manual', 'morning', 'midday', 'evening'];

const emptyForm = {
  author: TRACKED_AUTHORS[0],
  pick_text: '',
  game: '',
  game_time: '',
  game_time_utc: '',
  pick_type: 'spread',
  confidence: 'medium',
  source_tweet_url: '',
  slot: 'manual',
};
```

(`confidence` stays in the form — the Global Constraint that it's server-computed applies only to source-tweet picks, not plain manual entries. The confidence `<select>` is shown conditionally in Step 2: hidden when a source tweet URL is entered, since the backend overrides it to `'medium'` regardless of what's sent in that case.)

- [ ] **Step 2: Replace the form JSX**

Replace the `<form>` block's inputs (author input through the confidence `<select>`) with:

```jsx
<select
  value={form.author}
  onChange={(e) => setForm({ ...form, author: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
>
  {TRACKED_AUTHORS.map((a) => (
    <option key={a} value={a}>
      {a}
    </option>
  ))}
</select>
<input
  placeholder="Source tweet URL (optional)"
  value={form.source_tweet_url}
  onChange={(e) => setForm({ ...form, source_tweet_url: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
/>
<input
  required
  placeholder="Pick text (e.g. Kansas City Chiefs -5.5)"
  value={form.pick_text}
  onChange={(e) => setForm({ ...form, pick_text: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
/>
<input
  required
  placeholder="Game (exact full team names, e.g. Baltimore Ravens @ Kansas City Chiefs)"
  value={form.game}
  onChange={(e) => setForm({ ...form, game: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
/>
<input
  required
  placeholder="Game time (e.g. Sept 21 1:00 PM)"
  value={form.game_time}
  onChange={(e) => setForm({ ...form, game_time: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
/>
<input
  placeholder="Game time UTC (ISO 8601, e.g. 2026-09-21T18:00:00Z) — required for slots/source tweets"
  value={form.game_time_utc}
  onChange={(e) => setForm({ ...form, game_time_utc: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
/>
<select
  value={form.pick_type}
  onChange={(e) => setForm({ ...form, pick_type: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
>
  {PICK_TYPES.map((t) => (
    <option key={t} value={t}>
      {t}
    </option>
  ))}
</select>
{!form.source_tweet_url && (
  <select
    value={form.confidence}
    onChange={(e) => setForm({ ...form, confidence: e.target.value })}
    className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
  >
    {CONFIDENCE_LEVELS.map((c) => (
      <option key={c} value={c}>
        {c}
      </option>
    ))}
  </select>
)}
<select
  value={form.slot}
  onChange={(e) => setForm({ ...form, slot: e.target.value })}
  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
>
  {SLOTS.map((s) => (
    <option key={s} value={s}>
      {s}
    </option>
  ))}
</select>
```

- [ ] **Step 3: Update `handleSubmit` to omit empty optional fields**

`form.confidence` is sent as-is — the backend (Task 2) already overrides it to `'medium'` when `source_tweet_id` is present, regardless of what's submitted, so the frontend doesn't need to duplicate that logic:

```js
const handleSubmit = async (e) => {
  e.preventDefault();
  setSubmitting(true);
  setError(null);
  try {
    const payload = { ...form };
    if (!payload.source_tweet_url) delete payload.source_tweet_url;
    if (!payload.game_time_utc) delete payload.game_time_utc;
    await addPick(payload);
    setForm(emptyForm);
    await loadPicks();
  } catch (err) {
    setError(err.message);
  } finally {
    setSubmitting(false);
  }
};
```

- [ ] **Step 4: Show verification status in the "Current Picks" list**

Replace the list item's inner content:

```jsx
<div>
  <p className="text-sm font-semibold text-white">
    {pick.author} — {pick.pick_text}
    {pick.source_tweet_id && (
      <span className={`ml-2 text-xs ${pick.verified ? 'text-green-400' : 'text-yellow-400'}`}>
        {pick.verified ? '✓ Verified' : '⏳ Pending verification'}
      </span>
    )}
  </p>
  <p className="text-xs text-neutral-500">
    {pick.game} · {pick.game_time} · {pick.pick_type} · {pick.confidence} · {pick.slot || 'manual'}
    {pick.source_tweet_url && (
      <>
        {' · '}
        <a href={pick.source_tweet_url} target="_blank" rel="noreferrer" className="text-sharp-500 hover:underline">
          source tweet
        </a>
      </>
    )}
  </p>
</div>
```

- [ ] **Step 5: Build and verify**

```
npm run build
```
Expected: clean build, no errors. Then with `npm run dev` and `wrangler dev` both running, open the admin panel in a browser, submit a pick with a `source_tweet_url` filled in, and confirm the "Current Picks" list shows "⏳ Pending verification" for it immediately after submission.

- [ ] **Step 6: Commit**

```
git add src/pages/AdminPanel.jsx
git commit -m "Add source-tweet intake, author/slot dropdowns, and verification status to admin panel"
```

---

### Task 7: Swappable affiliate link

**Files:**
- Modify: `wrangler.toml`

**Interfaces:** none (config-only; the code side was already wired in Task 2 Step 2 via `env.AFFILIATE_LINK`).

- [ ] **Step 1: Add the var**

In `wrangler.toml`'s `[vars]` block, add:

```toml
AFFILIATE_LINK = "https://ak.draftkings.com"
```

(Same value as today's hardcoded default, so behavior is unchanged until this is edited to a real FanDuel — or whichever program is approved — tracked link.)

- [ ] **Step 2: Verify**

```
grep -n AFFILIATE_LINK wrangler.toml
```
Expected: one match, the line just added.

- [ ] **Step 3: Commit**

```
git add wrangler.toml
git commit -m "Make the default affiliate link swappable via config instead of hardcoded"
```

---

### Task 8: Production deployment and cleanup

**Files:** none (operational task — migrations, cleanup, deploy).

- [ ] **Step 1: Build**

```
npm run build
```
Expected: clean build.

- [ ] **Step 2: Apply the schema migration to production D1**

```
npx wrangler d1 execute sharpflow-db --remote --command "ALTER TABLE picks ADD COLUMN source_tweet_url TEXT;"
npx wrangler d1 execute sharpflow-db --remote --command "ALTER TABLE picks ADD COLUMN source_tweet_id TEXT;"
npx wrangler d1 execute sharpflow-db --remote --command "ALTER TABLE picks ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;"
npx wrangler d1 execute sharpflow-db --remote --command "CREATE TABLE IF NOT EXISTS ingested_tweets (tweet_id TEXT PRIMARY KEY, author TEXT NOT NULL, ingested_at TEXT NOT NULL DEFAULT (datetime('now')));"
```
Expected: each prints `🚣 Executed 1 command`, no errors.

- [ ] **Step 3: Clean up the fabricated seed rows still live in production**

First confirm what's there:
```
npx wrangler d1 execute sharpflow-db --remote --command "SELECT id, author, pick_text FROM picks WHERE slot IS NULL AND source_tweet_id IS NULL;"
```
Expected: the 4 known fabricated rows (ids 1, 3, 4, 5 — `@CodyBrownBets`/`Kansas City -5.5`, `@jasonrmcintyre`/`Bills ML`, `@DocsSports`/`Josh Allen 280+ passing`, `@nflpickspage`/`Under 41`). If the output matches this description, delete them:
```
npx wrangler d1 execute sharpflow-db --remote --command "DELETE FROM picks WHERE slot IS NULL AND source_tweet_id IS NULL;"
```
If the output does NOT match (different rows present — e.g. real admin-entered manual picks with no slot got swept into this query too), stop and re-examine before deleting — this WHERE clause is only safe if every `slot IS NULL` row today is genuinely one of the old fabricated ones (true as of this plan's writing, per the direct query already run this session).

- [ ] **Step 4: Set the `X_BEARER_TOKEN` secret — only once you actually have one**

This step requires a real X API Bearer Token from the pay-per-use developer account (per the spec's Known Risks #4). If you don't have one yet, skip to Step 5 and come back once you do:
```
npx wrangler versions secret put X_BEARER_TOKEN --name picksharp
```
(Paste the real token when prompted.) Note from this session's experience: this command re-bundles and deploys current worktree source as part of activating the secret — run Step 5 (`wrangler deploy`) right after regardless, so there's no window where a half-deployed version is live.

- [ ] **Step 5: Deploy**

```
npx wrangler deploy
```
Expected: clean deploy, no errors.

- [ ] **Step 6: Smoke test the manual path (unaffected behavior)**

```
curl -s https://wepicksharp.com/api/picks/today
```
Expected: `{"picks":[]}` (fabricated rows gone, nothing new submitted yet on production). Then, via the live admin panel (logged in as the admin), submit one manual pick with no `source_tweet_url` — confirm it appears in `/api/picks/today` immediately, exactly as the pre-existing manual-entry behavior always worked.

- [ ] **Step 7: Smoke test the source-tweet path — locally, not against production**

`POSTING_PAUSED` is checked as the very first line of `handlePostSlot`, before verification ever runs — so calling `post-slot` against production (where `POSTING_PAUSED="true"`) never exercises the new verification/tiering code path at all, regardless of whether `X_BEARER_TOKEN` is set. To actually test verification, do this against local `wrangler dev` instead, with a real `X_BEARER_TOKEN` in `.dev.vars` and `POSTING_PAUSED` unset locally:

Submit a real pick via the local admin panel (or the same `curl` shape as Task 2 Step 3): pick one of the 5 tracked authors, paste an actual real tweet of theirs containing a genuine pick, fill in the game/time/pick_text fields accurately, and set a `slot`. Confirm it shows "⏳ Pending verification" and does NOT appear in `curl -s http://localhost:8787/api/picks/today`. Then:
```
curl -s -X POST http://localhost:8787/api/admin/post-slot \
  -H "x-admin-secret: test-admin-secret" -H "Content-Type: application/json" \
  -d '{"slot":"<the slot you used>"}'
```
Expected: a successful post response (or a clean error if the tweet fails verification/grounding). Check `curl -s http://localhost:8787/api/picks/today` afterward — if verification passed, the pick should now appear with `verified: true` and a real, odds-derived `confidence`.

- [ ] **Step 8: Commit** (only if Steps 1-7 produced any further local file changes — otherwise this task is operational-only and nothing to commit)

---

## Execution Notes

- Tasks 1-2 must run in order (2 depends on 1's `isTweetIngested`/`insertPick`). Tasks 3 and 4 are independent of each other and of 1-2, and can run in either order (or in parallel if using subagent-driven-development). Task 5 depends on 1, 3, and 4. Task 6 depends on 2's endpoint contract. Task 7 is fully independent, safe to run any time. Task 8 must run last.
- Every task defers live X API verification (no `X_BEARER_TOKEN` yet) — this matches how `ODDS_API_KEY` blocked equivalent steps in the original AI-generation plan this session. Code fully, verify what's verifiable without the key, note what's deferred.
