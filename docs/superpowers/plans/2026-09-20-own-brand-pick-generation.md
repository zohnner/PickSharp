# PickSharp-Branded Pick Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate pick generation via Cloudflare Workers AI, attributed to "PickSharp" itself (never a real person), replacing manual real-tweet intake as the primary content-volume mechanism while leaving that pipeline intact as a secondary option.

**Architecture:** A new `worker/pickGenerator.js` module calls a Workers AI binding with real odds data and returns validated candidate picks. A shared `generateForSlot(env, slot)` function (in `worker/index.js`) fetches odds, generates, grounds each pick against that same odds data in-memory (no deferred verification needed, unlike the tweet pipeline), tiers via the existing odds-based confidence logic, and inserts. This runs both from new Cloudflare Cron Triggers (the same 3-slot schedule as the original, pre-pivot design) and from a new manual-trigger admin endpoint for testing.

**Tech Stack:** Cloudflare Workers AI (`env.AI` binding, model `@cf/mistralai/mistral-small-3.1-24b-instruct`), reuses existing `oddsApi.js`/`tiering.js`/`db.js` unchanged.

**Spec:** `docs/superpowers/specs/2026-09-20-own-brand-pick-generation-design.md`

## Global Constraints

- Generated picks are always `author: "PickSharp"` — never a real person's name, never a fictional persona styled as a real individual.
- No `confidence` is requested from the model — price tier always comes from `computeConfidenceFromOdds` (existing, unchanged), same reasoning already established for the real-tweet pipeline.
- A generated pick that doesn't match a real game in the same odds data just fetched is discarded before insert — never written to the database, no deferred cleanup needed.
- No schema changes — `author`/`slot`/`game_time_utc` already support this shape; `source_tweet_url`/`source_tweet_id` are simply omitted (`NULL`), identical to a manual pick.
- The real-tweet aggregation pipeline (`xVerify.js`, `verify-slot`, `post-slot`'s tweet-verification block, the admin panel's source-tweet form) is not modified by this plan.
- `POSTING_PAUSED` is not touched — this plan only adds content, never posts.
- No test framework in this project — verification uses `wrangler dev --remote` (required for Workers AI; plain `wrangler dev` has no local AI emulation) + `curl`, plus `node --check`/`node -e` for standalone module checks, matching this project's established convention.

---

## File Structure

- `worker/pickGenerator.js` — new: prompt construction, Workers AI call, JSON extraction/validation. One responsibility, mirrors the shape of `oddsApi.js`/`xVerify.js`.
- `worker/index.js` — modified: new `generateForSlot(env, slot)` (idempotency + odds fetch + generation + grounding + tiering + insert), new `handleGenerateSlot` (manual-trigger endpoint), new route, `scheduled()` dispatch extended for the 3 new crons.
- `wrangler.toml` — modified: new `[ai]` binding, 3 new cron trigger entries.

---

### Task 1: Pick generation module

**Files:**
- Create: `worker/pickGenerator.js`

**Interfaces:**
- Produces: `generatePicks(env, oddsGames): Promise<Array<{pick_type, game, game_time, game_time_utc, pick_text}>>` — consumed by Task 3.

- [ ] **Step 1: Write `worker/pickGenerator.js`**

```js
const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

function extractJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in model response');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function isValidPick(pick) {
  return Boolean(
    pick &&
      typeof pick.pick_type === 'string' &&
      PICK_TYPES.includes(pick.pick_type) &&
      typeof pick.game === 'string' &&
      pick.game.trim().length > 0 &&
      typeof pick.game_time === 'string' &&
      pick.game_time.trim().length > 0 &&
      typeof pick.game_time_utc === 'string' &&
      !Number.isNaN(new Date(pick.game_time_utc).getTime()) &&
      typeof pick.pick_text === 'string' &&
      pick.pick_text.trim().length > 0
  );
}

function summarizeGame(g) {
  const bookmaker = g.bookmakers?.[0];
  const markets = (bookmaker?.markets || [])
    .map(
      (m) =>
        `${m.key}: ${(m.outcomes || [])
          .map((o) => `${o.name} ${o.price}${o.point !== undefined ? ` (${o.point})` : ''}`)
          .join(', ')}`
    )
    .join(' | ');
  return `${g.away_team} @ ${g.home_team}, kickoff ${g.commence_time}: ${markets}`;
}

function buildPrompt(oddsGames) {
  const gamesSummary = oddsGames.slice(0, 15).map(summarizeGame).join('\n');

  return `You are generating sports betting picks for PickSharp, a sports-picks website. These are PickSharp's own picks -- do not attribute them to any real person.

Real upcoming games and odds:
${gamesSummary}

Generate 3 to 5 picks grounded in this real data. Respond with ONLY a JSON array, no other text, where each element has exactly these fields:
- pick_type: one of "spread", "moneyline", "prop", "over_under"
- game: the exact "<away_team> @ <home_team>" string from the data above, verbatim, unabbreviated
- game_time: a human-readable kickoff time, e.g. "Sept 21 1:00 PM ET"
- game_time_utc: the exact commence_time value from the data above for that game, verbatim
- pick_text: a short pick description grounded in the real odds shown above, e.g. "Kansas City Chiefs -5.5"

Do not invent a game, team, or line that isn't in the data above.`;
}

export async function generatePicks(env, oddsGames) {
  const prompt = buildPrompt(oddsGames);
  const response = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 1024,
  });

  const text = response.response || '';
  let candidates;
  try {
    candidates = extractJson(text);
  } catch (err) {
    throw new Error(`Could not parse model response as JSON: ${err.message}`);
  }
  if (!Array.isArray(candidates)) {
    throw new Error('Model response was not a JSON array');
  }
  return candidates.filter(isValidPick);
}
```

- [ ] **Step 2: Verify syntax**

```
node --check worker/pickGenerator.js
```
Expected: no output, exit code 0. (Live verification against the real Workers AI binding is deferred to Task 4 — there's no local emulation for Workers AI; `node --check` only confirms the file parses.)

- [ ] **Step 3: Commit**

```
git add worker/pickGenerator.js
git commit -m "Add PickSharp-branded pick generation via Workers AI"
```

---

### Task 2: Workers AI binding and cron schedule

**Files:**
- Modify: `wrangler.toml`

**Interfaces:** none (config-only).

- [ ] **Step 1: Add the AI binding**

Add anywhere at the top level of `wrangler.toml` (e.g. right after the `[[d1_databases]]` block):

```toml
[ai]
binding = "AI"
```

- [ ] **Step 2: Add the 3 generation cron triggers**

Replace the existing `[triggers]` block:

```toml
[triggers]
crons = ["*/5 * * * *", "0 13 * * 4,6,0", "0 17 * * 4,6,0", "0 22 * * 4,6,0"]
```

(`0 13/17/22 * * 4,6,0` = 9am/1pm/6pm ET, Thursday/Saturday/Sunday — same schedule as the original, pre-pivot AI-generation design. The existing `*/5 * * * *` quiet-period check is unchanged, just joined by the 3 new entries in the same array.)

- [ ] **Step 3: Verify**

```
grep -n "\[ai\]\|binding = \"AI\"\|0 13 \* \* 4,6,0" wrangler.toml
```
Expected: 3 matches (the `[ai]` header, the binding line, and the crons line containing the new schedule).

- [ ] **Step 4: Commit**

```
git add wrangler.toml
git commit -m "Add Workers AI binding and pick-generation cron schedule"
```

---

### Task 3: Wire generation into the Worker (manual endpoint + scheduled dispatch)

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `generatePicks(env, oddsGames)` (Task 1).
- Produces: `generateForSlot(env, slot)` — usable by both the new endpoint and the scheduled handler.

- [ ] **Step 1: Add the import**

Add to the top of `worker/index.js`, alongside the other module imports:

```js
import { generatePicks } from './pickGenerator.js';
```

- [ ] **Step 2: Add `generateForSlot` and `handleGenerateSlot`**

Add these two functions anywhere after `handlePostSlot`/`handleVerifySlot` (e.g. right before `handleTrackSource`):

```js
async function generateForSlot(env, slot) {
  const alreadyGenerated = await env.DB.prepare(
    `SELECT 1 FROM picks WHERE author = 'PickSharp' AND slot = ? AND date(created_at, '-4 hours') = date('now', '-4 hours')`
  )
    .bind(slot)
    .first();
  if (alreadyGenerated) {
    console.log(`[${slot}] PickSharp picks already generated today, skipping.`);
    return { skipped: true, reason: 'already generated' };
  }

  let oddsGames;
  try {
    oddsGames = await getUpcomingOdds(env);
  } catch (err) {
    console.error(`[${slot}] Odds fetch failed, cannot generate:`, err.message);
    return { skipped: true, reason: 'odds fetch failed' };
  }
  if (oddsGames.length === 0) {
    console.log(`[${slot}] No upcoming games, skipping generation.`);
    return { skipped: true, reason: 'no games' };
  }

  let candidates;
  try {
    candidates = await generatePicks(env, oddsGames);
  } catch (err) {
    console.error(`[${slot}] Pick generation failed:`, err.message);
    return { skipped: true, reason: 'generation failed' };
  }

  const grounded = candidates.filter((p) => matchesRealGame(p, oddsGames));
  if (grounded.length === 0) {
    console.error(`[${slot}] All generated picks failed grounding, nothing inserted.`);
    return { inserted: 0 };
  }

  const ids = [];
  for (const pick of grounded) {
    const confidence = computeConfidenceFromOdds(pick, oddsGames);
    const id = await insertPick(env.DB, {
      author: 'PickSharp',
      pick_text: pick.pick_text,
      pick_type: pick.pick_type,
      confidence,
      game: pick.game,
      game_time: pick.game_time,
      game_time_utc: pick.game_time_utc,
      slot,
    });
    ids.push(id);
  }

  console.log(`[${slot}] Generated and inserted ${ids.length} PickSharp picks.`);
  return { inserted: ids.length, ids };
}

async function handleGenerateSlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);
  const result = await generateForSlot(env, slot);
  return json(result);
}
```

- [ ] **Step 3: Add the route**

In the `fetch` handler's route list, add this alongside the existing `/api/admin/verify-slot` route:

```js
      if (pathname === '/api/admin/generate-slot' && request.method === 'POST') {
        return await handleGenerateSlot(request, env);
      }
```

- [ ] **Step 4: Extend the scheduled dispatch**

Replace the existing `scheduled` export:

```js
  async scheduled(event, env, ctx) {
    const GENERATION_CRONS = {
      '0 13 * * 4,6,0': 'morning',
      '0 17 * * 4,6,0': 'midday',
      '0 22 * * 4,6,0': 'evening',
    };
    const slot = GENERATION_CRONS[event.cron];
    if (slot) {
      ctx.waitUntil(generateForSlot(env, slot));
    } else {
      ctx.waitUntil(handleDailyPostCheck(env));
    }
  },
```

- [ ] **Step 5: Verify locally**

```
node --check worker/index.js
```
Expected: no output, exit code 0.

Then, since Workers AI has no local emulation, start dev with the remote flag:
```
npx wrangler dev --remote
```
In another terminal:
```
curl -s -X POST http://localhost:8787/api/admin/generate-slot \
  -H "x-admin-secret: test-admin-secret" -H "Content-Type: application/json" \
  -d '{"slot":"morning"}'
```
Expected: a JSON response with either `{"inserted": N, "ids": [...]}` (N between 0 and 5) or `{"skipped": true, "reason": "..."}` if there are no real upcoming NFL/NCAAF games in the odds data right now — both are valid outcomes, not failures. If `inserted` is non-zero, confirm the picks actually appear:
```
curl -s http://localhost:8787/api/picks/today
```
Expected: the response includes picks with `"author":"PickSharp"`.

- [ ] **Step 6: Commit**

```
git add worker/index.js
git commit -m "Wire PickSharp pick generation into scheduled crons and a manual-trigger endpoint"
```

---

### Task 4: Deploy and verify live

**Files:** none (operational task).

- [ ] **Step 1: Build**

```
npm run build
```
Expected: clean build.

- [ ] **Step 2: Deploy**

```
npx wrangler deploy
```
Expected: clean deploy. Confirm the output's bindings table includes `env.AI` and the triggers section lists all 4 cron schedules (the existing `*/5 * * * *` plus the 3 new ones).

- [ ] **Step 3: Live smoke test via the manual endpoint**

```
curl -s -X POST https://wepicksharp.com/api/admin/generate-slot \
  -H "x-admin-secret: <real ADMIN_SECRET>" -H "Content-Type: application/json" \
  -d '{"slot":"morning"}'
```
Expected: same shape as Task 3 Step 5's local check — `{"inserted": N, ...}` or a clean `{"skipped": true, "reason": "..."}`. Then:
```
curl -s https://wepicksharp.com/api/picks/today
```
If `inserted` was non-zero, confirm the generated picks appear with `"author":"PickSharp"`, sensible `pick_text`/`game` values, and a `confidence` that isn't just always `"medium"` across every pick (spot-check that tiering is actually varying, not degenerately flat — if every single pick lands on `medium`, note this for follow-up tuning rather than treating it as a hard failure, consistent with the known limitation already documented for the real-tweet pipeline's spread tiering).

- [ ] **Step 4: Confirm idempotency**

Re-run the same `generate-slot` call from Step 3 immediately.
Expected: `{"skipped": true, "reason": "already generated"}` — confirms the same slot won't double-generate on a retry.

- [ ] **Step 5: Commit** (only if any local file changed during this task — otherwise operational-only, nothing to commit)

---

## Execution Notes

- Tasks 1 and 2 are fully independent of each other — either order, or parallel dispatch.
- Task 3 depends on Task 1 (imports `generatePicks`) for code-writing, and depends on Task 2 (the `AI` binding existing) only for its Step 5 live verification — the code itself can be written before Task 2 completes.
- Task 4 must run last, after Tasks 1-3 are all committed.
- `POSTING_PAUSED` is untouched throughout — generated picks become visible on the site (same as a manual pick always has), but nothing tweets about them until you explicitly lift that switch, exactly as already true for the real-tweet pipeline.
