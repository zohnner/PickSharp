# AI Pick Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a game-day schedule (Thu/Sat/Sun, 3 slots/day), automatically pull NFL/NCAAF odds, generate a batch of picks via a direct Anthropic API call, insert them into the `picks` table, and immediately post about the slot's free pick — replacing manual admin entry as the primary content source while leaving the manual path intact as a fallback.

**Architecture:** Two new Worker modules follow the existing raw-`fetch`-no-SDK pattern (`worker/stripe.js`, `worker/x.js`): `worker/oddsApi.js` (pulls current lines from The Odds API) and `worker/pickGenerator.js` (calls Anthropic's Messages API for structured JSON pick output). A new `handleGenerateAndPost(env, slot)` in `worker/index.js` ties them together and reuses the existing `composeTweet`/`postTweet` from the X bot. `picks` gains a `slot` column; `daily_posts` gains a composite `(date, slot)` primary key (a real schema migration, not a simple `ADD COLUMN`, since SQLite/D1 can't alter a primary key in place). The existing quiet-period bot (`handleDailyPostCheck`) keeps working for manually-entered picks, now scoped to a `'manual'` slot so it never collides with the three AI slots.

**Tech Stack:** Cloudflare Worker (vanilla JS), D1 (SQLite), The Odds API and Anthropic's Messages API via raw `fetch`, no test runner in this repo (manual verification via `node` scripts, `wrangler dev`, and curl, matching every prior task in this codebase).

**Spec:** `docs/superpowers/specs/2026-09-19-ai-pick-generation-design.md`

## Global Constraints

- Three AI generation slots, exactly: `morning` (~8am ET / 12:00 UTC), `midday` (~1pm ET / 17:00 UTC), `evening` (~6pm ET / 22:00 UTC), firing only on Thursday, Saturday, Sunday.
- Generated picks are always attributed to one of the 5 existing fixed personas in `picker_stats` (`@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`) — never a new name.
- `pick_type` must be one of `spread`, `moneyline`, `prop`, `over_under`; `confidence` must be one of `high`, `medium`, `low` — the same enums `worker/schema.sql` already enforces via `CHECK` constraints.
- No human review gate — validated output publishes and becomes sellable immediately. If validation fails, the run logs and skips; it never inserts partial/malformed data.
- Manually-entered picks (via the existing admin panel) get `slot = 'manual'` and keep working through the existing quiet-period bot, unaffected by the AI slots.
- Claude does not generate tweet copy — the existing `composeTweet`/`postTweet` (`worker/tweetCopy.js`/`worker/x.js`) are reused unchanged for the actual posting.
- `game_time` staleness (a pick can remain listed after its game starts) is a known, accepted, unfixed gap — do not attempt to solve it as part of this plan.
- Verify The Odds API's actual current endpoint/response shape and Anthropic's current model pricing against their live docs before relying on this plan's example code verbatim in Tasks 3-4 — both are external services whose exact details may have shifted since this plan was written.

---

### Task 1: Schema migration for slots

**Files:**
- Modify: `worker/schema.sql`

**Interfaces:**
- Produces: `picks.slot TEXT` column (fresh installs: part of the `CREATE TABLE`; existing installs: added via `ALTER TABLE` in Step 2 below). `daily_posts` gains a composite `PRIMARY KEY (date, slot)` (fresh installs: part of the `CREATE TABLE`; existing installs: table recreation in Step 2).
- Consumed by: Task 2's `db.js` changes, Task 5's `handleGenerateAndPost`/`handleDailyPostCheck`.

- [ ] **Step 1: Update `worker/schema.sql` for fresh installs**

Replace the `picks` table definition (lines 8-18) with:

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Replace the `daily_posts` table definition (lines 51-55) with:

```sql
CREATE TABLE IF NOT EXISTS daily_posts (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
```

These `CREATE TABLE IF NOT EXISTS` statements only affect brand-new environments — they no-op against the already-populated local and production databases, which Step 2 migrates separately.

- [ ] **Step 2: Write and run a one-time local migration**

This is NOT part of `worker/schema.sql` (which must stay safely re-runnable) — run it once, directly:

```
npx wrangler d1 execute sharpflow-db --local --command "
ALTER TABLE picks ADD COLUMN slot TEXT;

CREATE TABLE daily_posts_new (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
INSERT INTO daily_posts_new (date, slot, posted_at, tweet_id)
  SELECT date, 'manual', posted_at, tweet_id FROM daily_posts;
DROP TABLE daily_posts;
ALTER TABLE daily_posts_new RENAME TO daily_posts;
"
```

(Existing `daily_posts` rows get tagged `'manual'` — consistent with Task 5's convention that the quiet-period bot's posts use that slot name going forward.)

- [ ] **Step 3: Verify the migration**

Run: `npx wrangler d1 execute sharpflow-db --local --command "SELECT sql FROM sqlite_master WHERE name IN ('picks', 'daily_posts');"`
Expected: `picks`' schema includes a `slot` column; `daily_posts`' schema shows `PRIMARY KEY (date, slot)`.

Run: `npx wrangler d1 execute sharpflow-db --local --command "SELECT * FROM daily_posts;"`
Expected: any pre-existing rows now show `slot = 'manual'`, with no data loss (same row count as before the migration).

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add slot column to picks and composite (date, slot) key to daily_posts"
```

(The migration command itself isn't a file change — nothing to add for Step 2, it's a one-time database operation you just ran against local D1.)

---

### Task 2: `db.js` support for slots

**Files:**
- Modify: `worker/db.js`

**Interfaces:**
- Modifies: `getTodaysPicksRaw(db)` — now also selects `p.slot` in its result rows (signature unchanged).
- Modifies: `insertPick(db, pick)` — now accepts an optional `slot` field on the `pick` object, defaulting to `'manual'` if omitted (signature unchanged, just a new optional field read off the existing `pick` param).
- Produces: `insertGeneratedPicks(db, picks, slot)` — batch-inserts an array of pick objects (each `{author, pick_text, pick_type, confidence, game, game_time}`) all tagged with the given `slot`, in one atomic `db.batch()` call. Returns nothing (fire-and-forget batch insert; if any statement fails, `db.batch()` rejects and the caller should treat the whole batch as not inserted).
- Consumed by: Task 5's `handleGenerateAndPost` (uses `insertGeneratedPicks`), `handleAdminCreatePick` in `worker/index.js` (uses `insertPick`, unchanged call site since `slot` is optional).

- [ ] **Step 1: Update `getTodaysPicksRaw` to select `slot`**

Replace the function (lines 51-63) with:

```js
export async function getTodaysPicksRaw(db) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
              p.affiliate_link, p.slot, p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
       FROM picks p
       LEFT JOIN picker_stats s ON s.author = p.author
       WHERE date(p.created_at, '-4 hours') = date('now', '-4 hours')
       ORDER BY p.created_at ASC`
    )
    .all();
  return results;
}
```

(Only the `SELECT` list changes — `p.slot` is added; the `WHERE`/`ORDER BY` are untouched.)

- [ ] **Step 2: Update `insertPick` to default `slot` to `'manual'`**

Replace the function (lines 19-29) with:

```js
export async function insertPick(db, pick) {
  const { author, pick_text, pick_type, confidence, game, game_time, affiliate_link, slot } = pick;
  const result = await db
    .prepare(
      `INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, affiliate_link, slot)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'https://ak.draftkings.com'), ?)`
    )
    .bind(author, pick_text, pick_type, confidence, game, game_time, affiliate_link || null, slot || 'manual')
    .run();
  return result.meta.last_row_id;
}
```

- [ ] **Step 3: Add `insertGeneratedPicks`**

Add after `insertPick`:

```js
export async function insertGeneratedPicks(db, picks, slot) {
  const stmts = picks.map((pick) =>
    db
      .prepare(
        `INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, slot)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(pick.author, pick.pick_text, pick.pick_type, pick.confidence, pick.game, pick.game_time, slot)
  );
  await db.batch(stmts);
}
```

- [ ] **Step 4: Verify with local D1**

Run: `npm run db:migrate:local` (safe to re-run — no-ops against existing tables, per Task 1).

Run:
```
node --input-type=module -e "
// Smoke-test that the module still loads and exports the new function without a syntax error.
const mod = await import('./worker/db.js');
console.log(typeof mod.insertGeneratedPicks, typeof mod.insertPick, typeof mod.getTodaysPicksRaw);
"
```
Expected: `function function function`.

Then verify against a real local D1 call — start `npx wrangler dev --local --port 8790` (check the port is free first) and use the existing `/api/admin/picks` endpoint to confirm `insertPick` still works with the `x-admin-secret` header and no `slot` field (should default to `'manual'`):
```
curl -s -X POST http://127.0.0.1:8790/api/admin/picks -H "x-admin-secret: <your local ADMIN_SECRET>" -H "Content-Type: application/json" -d '{"author": "@CodyBrownBets", "pick_text": "Test manual pick", "pick_type": "spread", "confidence": "medium", "game": "Test @ Game", "game_time": "Test 1:00 PM"}'
```
Then: `npx wrangler d1 execute sharpflow-db --local --command "SELECT id, author, slot FROM picks ORDER BY id DESC LIMIT 1;"`
Expected: the new row shows `slot = 'manual'`.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js
git commit -m "Add slot support to db.js: getTodaysPicksRaw, insertPick default, insertGeneratedPicks"
```

---

### Task 3: The Odds API client

**Files:**
- Create: `worker/oddsApi.js`

**Interfaces:**
- Produces: `getUpcomingOdds(env)` — fetches current NFL and NCAAF odds, returns a combined array of game objects. Throws `Error` on a non-2xx response from either sport's request.
- Consumes: `env.ODDS_API_KEY`.
- Consumed by: Task 5's `handleGenerateAndPost`.

**Verify against The Odds API's live docs before implementing** (`https://the-odds-api.com/liveapi/guides/v4/` or their current documentation site) — the exact endpoint path, query params, and response shape below are this plan's best understanding at time of writing and may have shifted.

- [ ] **Step 1: Write the client**

```js
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf'];

async function fetchSportOdds(env, sportKey) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API request failed for ${sportKey}: ${res.status} ${body}`);
  }
  return res.json();
}

export async function getUpcomingOdds(env) {
  const results = await Promise.all(SPORTS.map((sportKey) => fetchSportOdds(env, sportKey)));
  return results.flat();
}
```

- [ ] **Step 2: Verify the module loads**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/oddsApi.js');
console.log(typeof mod.getUpcomingOdds);
"
```
Expected: `function`.

- [ ] **Step 3: Verify against the real API once you have a key**

Once `ODDS_API_KEY` is available (Task 6 sets this up in `.dev.vars`), run:
```
node --input-type=module -e "
import { readFileSync } from 'fs';
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx), l.slice(idx + 1)];
  })
);
const { getUpcomingOdds } = await import('./worker/oddsApi.js');
const odds = await getUpcomingOdds(vars);
console.log('Games returned:', odds.length);
console.log(JSON.stringify(odds[0], null, 2));
"
```
Expected: a non-error result with at least one game object; inspect the printed shape and adjust the prompt in Task 4 if the actual field names differ from what's assumed there.

If this errors, check: is `ODDS_API_KEY` valid and does the account have remaining free-tier quota? Is the endpoint path still correct per current docs? This is real, live external-API integration — expect to iterate here more than in previous tasks that hit stable, already-verified APIs.

- [ ] **Step 4: Commit**

```bash
git add worker/oddsApi.js
git commit -m "Add The Odds API client for NFL/NCAAF lines"
```

---

### Task 4: Pick generation via Anthropic's Messages API

**Files:**
- Create: `worker/pickGenerator.js`

**Interfaces:**
- Produces: `generatePicks(env, oddsData)` — calls Anthropic's Messages API with the given odds data, returns a validated array of pick objects (`{author, pick_text, pick_type, confidence, game, game_time}`). Throws `Error` if the API call fails, the response isn't valid JSON, or any returned pick fails validation (wrong `author`/`pick_type`/`confidence`, or a missing required field).
- Consumes: `env.ANTHROPIC_API_KEY`.
- Consumed by: Task 5's `handleGenerateAndPost`.

**Verify Anthropic's current API version/pricing before implementing** — `anthropic-version: 2023-06-01` and the `claude-sonnet-5` model id are this plan's best understanding at time of writing.

- [ ] **Step 1: Write the module**

```js
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const PERSONAS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];
const VALID_PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const VALID_CONFIDENCES = ['high', 'medium', 'low'];

function buildPrompt(oddsData) {
  return `You are generating sports betting pick content for a set of fictional "sharp bettor" personas on a sports picks website. You will be given today's odds data for NFL/NCAAF games.

Generate 3-5 picks total, each attributed to one of these exact personas (rotate across them where sensible, don't reuse the same one twice in this batch unless you have more than 5 picks): ${PERSONAS.join(', ')}.

Odds data:
${JSON.stringify(oddsData).slice(0, 8000)}

Respond with ONLY a JSON array (no markdown formatting, no code fences, no explanation before or after) of objects with exactly this shape:
[{"author": "one of the personas listed above, verbatim", "pick_text": "short pick description, e.g. 'Kansas City -5.5' or 'Over 47'", "pick_type": "one of: spread, moneyline, prop, over_under", "confidence": "one of: high, medium, low", "game": "e.g. 'KC @ BAL'", "game_time": "e.g. 'Sept 21 1:00 PM'"}]`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function validatePick(pick) {
  return (
    pick &&
    typeof pick === 'object' &&
    PERSONAS.includes(pick.author) &&
    typeof pick.pick_text === 'string' &&
    pick.pick_text.length > 0 &&
    VALID_PICK_TYPES.includes(pick.pick_type) &&
    VALID_CONFIDENCES.includes(pick.confidence) &&
    typeof pick.game === 'string' &&
    pick.game.length > 0 &&
    typeof pick.game_time === 'string' &&
    pick.game_time.length > 0
  );
}

export async function generatePicks(env, oddsData) {
  const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(oddsData) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;
  if (!rawText) {
    throw new Error('Anthropic API response had no text content');
  }

  let picks;
  try {
    picks = JSON.parse(extractJson(rawText));
  } catch (err) {
    throw new Error(`Anthropic API response was not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(picks) || picks.length === 0) {
    throw new Error('Anthropic API response was not a non-empty array');
  }

  const invalid = picks.filter((p) => !validatePick(p));
  if (invalid.length > 0) {
    throw new Error(`Anthropic API returned ${invalid.length} invalid pick(s): ${JSON.stringify(invalid)}`);
  }

  return picks;
}
```

- [ ] **Step 2: Verify the module loads**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/pickGenerator.js');
console.log(typeof mod.generatePicks);
"
```
Expected: `function`.

- [ ] **Step 3: Verify against the real API with sample odds data**

Once `ANTHROPIC_API_KEY` is available (Task 6), run:
```
node --input-type=module -e "
import { readFileSync } from 'fs';
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx), l.slice(idx + 1)];
  })
);
const { generatePicks } = await import('./worker/pickGenerator.js');
const sampleOdds = [{ home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens', commence_time: '2026-09-21T17:00:00Z' }];
const picks = await generatePicks(vars, sampleOdds);
console.log(JSON.stringify(picks, null, 2));
"
```
Expected: a valid array of 3-5 pick objects, each with an `author` from the 5 personas, valid `pick_type`/`confidence`.

If validation throws on real output (e.g., Claude wrapped the JSON in prose despite instructions, or used a persona not in the list), inspect the raw response and tighten the prompt — this is expected iteration, not a sign the approach is wrong. Real odds data from Task 3 (not this hardcoded sample) should also be tried here before considering this task done.

- [ ] **Step 4: Commit**

```bash
git add worker/pickGenerator.js
git commit -m "Add Anthropic API pick generation with structured-output validation"
```

---

### Task 5: Wire the generation pipeline into the Worker

**Files:**
- Modify: `worker/index.js`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: `getUpcomingOdds` (Task 3), `generatePicks` (Task 4), `insertGeneratedPicks` (Task 2), `composeTweet`/`postTweet` (already exist).
- Produces: `handleGenerateAndPost(env, slot)` — the full per-slot pipeline. Modifies `handleDailyPostCheck` to scope itself to `slot = 'manual'`. Modifies the `scheduled` export to dispatch based on `event.cron`.

- [ ] **Step 1: Add the imports**

Update the import block at the top of `worker/index.js` (lines 1-16) to add two new imports after the existing `x.js` import:

```js
import { getUpcomingOdds } from './oddsApi.js';
import { generatePicks } from './pickGenerator.js';
```

- [ ] **Step 2: Add `handleGenerateAndPost`**

Add after `handleDailyPostCheck` (after line 309, before `handleTrackSource`):

```js
async function handleGenerateAndPost(env, slot) {
  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = ?`
  )
    .bind(slot)
    .first();
  if (alreadyPosted) return;

  let oddsData;
  try {
    oddsData = await getUpcomingOdds(env);
  } catch (err) {
    console.error(`[${slot}] Failed to fetch odds:`, err.message);
    return;
  }

  let picks;
  try {
    picks = await generatePicks(env, oddsData);
  } catch (err) {
    console.error(`[${slot}] Failed to generate picks:`, err.message);
    return;
  }

  try {
    await insertGeneratedPicks(env.DB, picks, slot);
  } catch (err) {
    console.error(`[${slot}] Failed to insert generated picks:`, err.message);
    return;
  }

  if (!env.PUBLIC_SITE_URL) {
    console.error('PUBLIC_SITE_URL is not configured — cannot compose tweet link.');
    throw new Error('PUBLIC_SITE_URL is not configured');
  }

  const freeIndex = picks.reduce(
    (bestIdx, p, idx) =>
      CONFIDENCE_RANK_FOR_FREE[p.confidence] < CONFIDENCE_RANK_FOR_FREE[picks[bestIdx].confidence] ? idx : bestIdx,
    0
  );
  const freePick = picks[freeIndex];
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    console.error(`[${slot}] Failed to post tweet:`, err.message);
    throw err;
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), ?, ?)`)
    .bind(slot, tweetId)
    .run();
}

const CONFIDENCE_RANK_FOR_FREE = { low: 0, medium: 1, high: 2 };
```

**Why this doesn't reuse `freePickId` from `db.js`**: `freePickId` operates on picks that already have database-assigned `id`/`created_at` fields (it returns an `id` to look up later). Here, the free pick needs to be identified from the freshly-generated batch *before* insertion (so `composeTweet` can use it immediately) — reusing the exact same confidence-ranking logic inline avoids a round-trip re-query right after insert. If this duplication bothers you at implementation time, an alternative is to insert first, then re-fetch via `getTodaysPicksRaw` filtered to this slot and reuse `freePickId` properly — either is fine, this plan picked the simpler-to-write option.

- [ ] **Step 3: Scope `handleDailyPostCheck` to the `manual` slot**

Replace the function (lines 270-309, as they exist before this task's Step 2 addition shifts line numbers — locate it by its `async function handleDailyPostCheck(env) {` signature) with:

```js
async function handleDailyPostCheck(env) {
  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = 'manual'`
  ).first();
  if (alreadyPosted) return;

  const picks = (await getTodaysPicksRaw(env.DB)).filter((p) => p.slot === 'manual' || p.slot === null);
  if (picks.length === 0) return;

  const newestRow = await env.DB.prepare(
    `SELECT MAX(created_at) AS newest FROM picks WHERE date(created_at, '-4 hours') = date('now', '-4 hours') AND (slot = 'manual' OR slot IS NULL)`
  ).first();
  const minutesRow = await env.DB.prepare(
    `SELECT (julianday('now') - julianday(?)) * 24 * 60 AS minutes_since`
  )
    .bind(newestRow.newest)
    .first();
  if (minutesRow.minutes_since < QUIET_PERIOD_MINUTES) return;

  if (!env.PUBLIC_SITE_URL) {
    console.error('PUBLIC_SITE_URL is not configured — cannot compose tweet link.');
    throw new Error('PUBLIC_SITE_URL is not configured');
  }

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    console.error('Failed to post daily tweet:', err.message);
    throw err;
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), 'manual', ?)`)
    .bind(tweetId)
    .run();
}
```

(Changes from the original: the `daily_posts` check/insert now includes `slot = 'manual'`; `getTodaysPicksRaw`'s results are filtered to `slot === 'manual' || slot === null` so AI-generated picks in other slots don't affect the manual bot's quiet-period timing or free-pick choice; the newest-pick query adds the same slot filter.)

- [ ] **Step 4: Dispatch by cron in the `scheduled` export**

Replace the `scheduled` export (the last block in the file) with:

```js
  async scheduled(event, env, ctx) {
    const CRON_SLOTS = {
      '0 12 * * 4,6,0': 'morning',
      '0 17 * * 4,6,0': 'midday',
      '0 22 * * 4,6,0': 'evening',
    };
    const slot = CRON_SLOTS[event.cron];
    if (slot) {
      ctx.waitUntil(handleGenerateAndPost(env, slot));
    } else {
      ctx.waitUntil(handleDailyPostCheck(env));
    }
  },
```

- [ ] **Step 5: Add the three new cron triggers to `wrangler.toml`**

Update the `[triggers]` block:

```toml
[triggers]
crons = ["*/5 * * * *", "0 12 * * 4,6,0", "0 17 * * 4,6,0", "0 22 * * 4,6,0"]
```

- [ ] **Step 6: Verify locally**

Restart `npx wrangler dev --local --port 8790`.

Seed fake odds aren't needed for a dry run of the dispatch logic — instead, directly exercise `handleGenerateAndPost` via wrangler's scheduled-event test endpoint (adjust the path if `/cdn-cgi/local/scheduled` isn't right for your wrangler version, per the note from the X bot build — check what your `wrangler dev` instance actually serves):
```
curl "http://127.0.0.1:8790/cdn-cgi/local/scheduled?cron=0+12+*+*+4,6,0"
```
Expected (once `ODDS_API_KEY`/`ANTHROPIC_API_KEY` are set per Task 6): new picks appear in D1 tagged `slot = 'morning'`, and — if it's currently Thu/Sat/Sun in this test — a real tweet posts. **This will spend real Odds API + Anthropic API credits and post a real tweet each time you run it** — do this sparingly, and confirm with `SELECT * FROM daily_posts WHERE slot = 'morning'` that a second identical trigger doesn't double-post.

Also verify the manual path still works: `curl "http://127.0.0.1:8790/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` should still route to `handleDailyPostCheck` exactly as before this task's changes.

- [ ] **Step 7: Commit**

```bash
git add worker/index.js wrangler.toml
git commit -m "Wire AI pick generation into slot-aware scheduled posting"
```

---

### Task 6: Secrets and configuration

**Files:**
- Modify: `.dev.vars` (not committed, gitignored)

**Interfaces:** None — configuration only.

- [ ] **Step 1: Get an Odds API key**

Sign up at The Odds API's current signup page, get a free-tier API key.

- [ ] **Step 2: Get an Anthropic API key**

Get an API key from Anthropic's Console (console.anthropic.com or its current equivalent) — this is a standard pay-per-token API key, separate from any Claude Code/subscription billing.

- [ ] **Step 3: Add both to `.dev.vars`**

Append:
```
ODDS_API_KEY=<your key>
ANTHROPIC_API_KEY=<your key>
```

- [ ] **Step 4: No commit needed**

`.dev.vars` is gitignored — confirm with `git status` that it doesn't appear as a pending change.

---

### Task 7: Deploy

**Files:** None (deployment step).

- [ ] **Step 1: Apply the schema migration to production D1**

This is the same two-part migration from Task 1, run with `--remote` instead of `--local`. **This is a real structural change to a live, populated production table — read it over once more before running.**

```bash
npx wrangler d1 execute sharpflow-db --remote --command "
ALTER TABLE picks ADD COLUMN slot TEXT;

CREATE TABLE daily_posts_new (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
INSERT INTO daily_posts_new (date, slot, posted_at, tweet_id)
  SELECT date, 'manual', posted_at, tweet_id FROM daily_posts;
DROP TABLE daily_posts;
ALTER TABLE daily_posts_new RENAME TO daily_posts;
"
```

- [ ] **Step 2: Verify the production migration**

```bash
npx wrangler d1 execute sharpflow-db --remote --command "SELECT sql FROM sqlite_master WHERE name IN ('picks', 'daily_posts');"
npx wrangler d1 execute sharpflow-db --remote --command "SELECT COUNT(*) FROM daily_posts;"
```
Expected: schemas match Task 1's Step 3 verification; row count matches what existed before the migration (no data loss).

- [ ] **Step 3: Add the two new production secrets**

```bash
npx wrangler secret put ODDS_API_KEY --name picksharp
npx wrangler secret put ANTHROPIC_API_KEY --name picksharp
```

- [ ] **Step 4: Verify secrets**

```bash
npx wrangler secret list --name picksharp
```
Expected: includes `ODDS_API_KEY` and `ANTHROPIC_API_KEY` alongside the existing ones.

- [ ] **Step 5: Merge and push**

Merge this feature branch to `main` and push, same pattern as prior deploys in this project — confirm `origin/main` is up to date first (`git fetch origin && git log --oneline -1 origin/main`) before merging, given this project has twice had a commit stranded on local-but-unpushed `main`.

- [ ] **Step 6: Poll for the deploy**

```bash
for i in 1 2 3 4 5 6; do
  sleep 20
  curl -s https://wepicksharp.com/ | grep -o 'assets/index-[^"]*\.js'
done
```

- [ ] **Step 7: Verify the new cron triggers registered**

Check the Cloudflare dashboard's Triggers tab for the `picksharp` Worker — confirm all four cron expressions (`*/5 * * * *` plus the three slot-specific ones) are listed.

- [ ] **Step 8: Live verification on the next real game day**

Since this can't be tested end-to-end without an actual Thu/Sat/Sun window arriving, the real verification happens naturally the next time one of the three cron triggers fires. Check `SELECT * FROM daily_posts ORDER BY posted_at DESC LIMIT 5` on production afterward, and check `@WePickSharp` for the post.

- [ ] **Step 9: No commit needed**

Deployment and verification only.
