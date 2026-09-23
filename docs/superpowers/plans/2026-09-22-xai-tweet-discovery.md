# xAI Tweet Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a low-frequency, budget-capped Worker cron that uses xAI's Grok `x_search` tool to surface candidate tweets from the 5 tracked accounts into a review queue, so the admin reacts to a short list instead of monitoring 5 timelines manually — without ever auto-publishing anything or exceeding a fixed $20 xAI credit ceiling.

**Architecture:** A new `worker/xaiDiscovery.js` module (raw `fetch`, no SDK — same pattern as `worker/oddsApi.js`/`worker/x.js`) calls xAI's Responses API per tracked handle. A new `runDiscovery(env)` orchestrator in `worker/index.js` gates every run behind a spend ceiling (tracked in a new `xai_spend_log` D1 table) and a manual pause switch, then writes results to a new `discovered_tweet_candidates` table — never into `picks` directly. Two new admin endpoints expose the queue; the existing admin panel gets a small UI section to review/dismiss/use candidates through the pick-creation form that already exists.

**Tech Stack:** Cloudflare Worker (vanilla JS), D1 (SQLite), xAI's Responses API (`x_search` tool) via raw `fetch`, no test runner in this repo (manual verification via `node` scripts, `wrangler dev`, and curl, matching every prior task in this codebase).

**Spec:** `docs/superpowers/specs/2026-09-22-xai-tweet-discovery-design.md`

## Global Constraints

- Discovery runs **only from the Worker** (scheduled cron or an admin-triggered endpoint) — never a Claude Code cloud routine, which is what blocked the original automated-discovery attempt.
- Discovered candidates are **never auto-inserted into `picks`**. They land in `discovered_tweet_candidates`; turning one into a real pick still goes through the existing `POST /api/admin/picks` + `verify-slot` flow, unchanged.
- `XAI_DISCOVERY_PAUSED` must be an **exact-string** `"true"`/`"false"` match, not a truthy check — mirrors the existing `POSTING_PAUSED` pattern in this codebase, chosen deliberately after that exact bug already bit this project once.
- Every discovery run checks cumulative spend (from `xai_spend_log`) against `env.XAI_DISCOVERY_BUDGET_CEILING_USD` **before** calling xAI. If at/over ceiling, skip the run entirely — log and return, never throw.
- Model: `grok-4.20-0309-non-reasoning` (verify this is still xAI's current non-reasoning tier before implementing — the model list already rotated once during this feature's design; check `https://docs.x.ai/developers/models`).
- Exactly **one** `x_search` call per handle per run, with an explicit prompt: no profile/user lookups, JSON-only output, result limit **12**.
- No test runner in this repo — verify manually via `node` scripts, `wrangler dev --local`, and `curl`, matching every existing plan in this codebase.
- Reuse the existing `TRACKED_AUTHORS` constant and `parseTweetId`/`isTweetIngested` helpers already in `worker/index.js`/`worker/db.js` — do not duplicate a second author list or URL-parsing regex.

---

### Task 1: Schema for spend tracking and candidate storage

**Files:**
- Modify: `worker/schema.sql`

**Interfaces:**
- Produces: `xai_spend_log` table (id, handle, cost_usd_ticks, estimated_usd, called_at). `discovered_tweet_candidates` table (id, handle, tweet_id, post_text, post_url UNIQUE, posted_at, discovered_at, dismissed).
- Consumed by: Task 2's `db.js` functions.

Both tables are brand new (no existing table is altered), so `CREATE TABLE IF NOT EXISTS` is safe and re-runnable on both fresh and existing installs — no separate one-time migration step is needed this time (unlike the historical `picks.slot` migration).

- [ ] **Step 1: Add the new tables to `worker/schema.sql`**

Add after the `buyer_sources` table (before the trailing seed-data comment):

```sql
CREATE TABLE IF NOT EXISTS xai_spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  cost_usd_ticks INTEGER NOT NULL,
  estimated_usd REAL NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovered_tweet_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  post_text TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  posted_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Apply locally**

Run: `npm run db:migrate:local`

- [ ] **Step 3: Verify**

Run: `npx wrangler d1 execute sharpflow-db --local --command "SELECT sql FROM sqlite_master WHERE name IN ('xai_spend_log', 'discovered_tweet_candidates');"`
Expected: both `CREATE TABLE` statements printed back, matching Step 1.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add xai_spend_log and discovered_tweet_candidates tables"
```

---

### Task 2: `db.js` support for spend tracking and candidates

**Files:**
- Modify: `worker/db.js`

**Interfaces:**
- Produces: `logXaiSpend(db, { handle, costUsdTicks, estimatedUsd })`, `getXaiSpendTotalUsd(db)` → `number`, `insertDiscoveredCandidates(db, candidates)` where `candidates` is `Array<{ handle, tweet_id, post_text, post_url, posted_at }>`, `getDiscoveredCandidates(db)` → array (newest first, excludes dismissed and already-ingested), `dismissCandidate(db, id)`.
- Consumes: nothing new (uses `db.batch`/`db.prepare` the same way every other function in this file does).
- Consumed by: Task 3/4's discovery orchestration, Task 5's admin endpoints.

- [ ] **Step 1: Add the functions**

Add at the end of `worker/db.js`:

```js
export async function logXaiSpend(db, { handle, costUsdTicks, estimatedUsd }) {
  await db
    .prepare('INSERT INTO xai_spend_log (handle, cost_usd_ticks, estimated_usd) VALUES (?, ?, ?)')
    .bind(handle, costUsdTicks, estimatedUsd)
    .run();
}

export async function getXaiSpendTotalUsd(db) {
  const row = await db.prepare('SELECT COALESCE(SUM(estimated_usd), 0) AS total FROM xai_spend_log').first();
  return row.total;
}

export async function insertDiscoveredCandidates(db, candidates) {
  if (candidates.length === 0) return;
  const stmts = candidates.map((c) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO discovered_tweet_candidates (handle, tweet_id, post_text, post_url, posted_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(c.handle, c.tweet_id, c.post_text, c.post_url, c.posted_at || null)
  );
  await db.batch(stmts);
}

export async function getDiscoveredCandidates(db) {
  const { results } = await db
    .prepare(
      `SELECT id, handle, tweet_id, post_text, post_url, posted_at, discovered_at
       FROM discovered_tweet_candidates
       WHERE dismissed = 0 AND tweet_id NOT IN (SELECT tweet_id FROM ingested_tweets)
       ORDER BY discovered_at DESC`
    )
    .all();
  return results;
}

export async function dismissCandidate(db, id) {
  await db.prepare('UPDATE discovered_tweet_candidates SET dismissed = 1 WHERE id = ?').bind(id).run();
}
```

- [ ] **Step 2: Smoke-test the module loads**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/db.js');
console.log(typeof mod.logXaiSpend, typeof mod.getXaiSpendTotalUsd, typeof mod.insertDiscoveredCandidates, typeof mod.getDiscoveredCandidates, typeof mod.dismissCandidate);
"
```
Expected: `function function function function function`.

- [ ] **Step 3: Verify against local D1**

Start `npx wrangler dev --local --port 8790` (check the port is free first; this repo has no other test runner, so this is the standard verification path).

There's no HTTP route wired up yet (that's Task 5), so verify directly with D1 commands instead:
```
npx wrangler d1 execute sharpflow-db --local --command "INSERT INTO xai_spend_log (handle, cost_usd_ticks, estimated_usd) VALUES ('CodyBrownBets', 308487500, 0.029);"
npx wrangler d1 execute sharpflow-db --local --command "SELECT COALESCE(SUM(estimated_usd), 0) AS total FROM xai_spend_log;"
```
Expected: the second command returns `0.029` (or close to it), confirming the schema/query shape from Step 1 works before any Worker code depends on it. Clean up with `DELETE FROM xai_spend_log;` afterward so this test row doesn't linger.

- [ ] **Step 4: Commit**

```bash
git add worker/db.js
git commit -m "Add db.js support for xAI spend tracking and discovered candidates"
```

---

### Task 3: xAI Live Search client

**Files:**
- Create: `worker/xaiDiscovery.js`

**Interfaces:**
- Produces: `discoverCandidatesForHandle(env, handle)` → `Promise<{ posts: Array<{ text: string, url: string, posted_at: string }>, costUsdTicks: number, estimatedUsd: number }>`. `handle` has no leading `@`. Throws `Error` on a non-2xx response or unparseable model output.
- Consumes: `env.XAI_API_KEY`.
- Consumed by: Task 4's `runDiscovery`.

The tick-to-dollar conversion (`TICK_TO_USD`) is **calibrated, not official** — xAI doesn't document it. It was derived from one confirmed real charge during this feature's design spike: $0.45 for 4,777,800,000 ticks. Re-derive this constant if a future real bill doesn't match the running total in `xai_spend_log` within a reasonable margin.

- [ ] **Step 1: Write the client**

```js
const XAI_API_BASE = 'https://api.x.ai/v1';
// Calibrated 2026-09-22 from a confirmed $0.45 charge for 4,777,800,000 ticks.
// xAI does not document this conversion officially — re-derive if actual
// billing drifts from what xai_spend_log's running total predicts.
const TICK_TO_USD = 0.45 / 4_777_800_000;

const RESULT_LIMIT = 12;
const SEARCH_WINDOW_DAYS = 2;

function buildPrompt(handle) {
  return `Call the x_search tool exactly once, searching only "from:${handle}" with a result limit of ${RESULT_LIMIT}. Do not look up user profiles. Do not perform any additional searches.

After you get results, respond with ONLY compact JSON, no markdown, no prose, no code fences, in exactly this shape:
{"posts":[{"text":"<verbatim post text>","url":"<post url>","posted_at":"<timestamp>"}]}

Include only posts that look like a sports betting pick (a team/game plus a spread, moneyline, total, or player prop). Max ${RESULT_LIMIT} posts. If none found, return {"posts":[]}.`;
}

export async function discoverCandidatesForHandle(env, handle) {
  const today = new Date();
  const windowStart = new Date(today.getTime() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const res = await fetch(`${XAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4.20-0309-non-reasoning',
      input: [{ role: 'user', content: buildPrompt(handle) }],
      tools: [
        {
          type: 'x_search',
          allowed_x_handles: [handle],
          from_date: fmt(windowStart),
          to_date: fmt(today),
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`xAI API request failed for ${handle}: ${res.status} ${text}`);
  }

  const data = JSON.parse(text);
  const message = data.output?.find((o) => o.type === 'message');
  const rawText = message?.content?.[0]?.text;
  if (!rawText) {
    throw new Error(`xAI API response for ${handle} had no message content`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`xAI API response for ${handle} was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.posts)) {
    throw new Error(`xAI API response for ${handle} had no "posts" array`);
  }

  const costUsdTicks = data.usage?.cost_in_usd_ticks ?? 0;
  return {
    posts: parsed.posts,
    costUsdTicks,
    estimatedUsd: costUsdTicks * TICK_TO_USD,
  };
}
```

- [ ] **Step 2: Verify the module loads**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/xaiDiscovery.js');
console.log(typeof mod.discoverCandidatesForHandle);
"
```
Expected: `function`.

- [ ] **Step 3: Verify against the real API**

Requires `XAI_API_KEY` in `.dev.vars` (Task 6 sets this up — if not done yet, temporarily read it from `.env` for this one manual check instead). Run:
```
node --input-type=module -e "
import { readFileSync } from 'fs';
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx), l.slice(idx + 1)];
  })
);
const { discoverCandidatesForHandle } = await import('./worker/xaiDiscovery.js');
const result = await discoverCandidatesForHandle(vars, 'CodyBrownBets');
console.log(JSON.stringify(result, null, 2));
"
```
Expected: a `posts` array (possibly empty depending on what's been posted recently) and `estimatedUsd` in the neighborhood of a few cents. **This spends real xAI credit** — this is expected and intentional (this is exactly the budget the design accounted for), not a bug to route around. If `estimatedUsd` is dramatically higher than prior spike testing (~$0.03-0.05), stop and re-check the prompt/model name against Task 3 Step 1 before proceeding — that would mean the cost-optimization findings from the design spike didn't carry over correctly.

- [ ] **Step 4: Commit**

```bash
git add worker/xaiDiscovery.js
git commit -m "Add xAI x_search client for tweet discovery"
```

---

### Task 4: Discovery orchestration in the Worker

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `discoverCandidatesForHandle` (Task 3), `logXaiSpend`/`getXaiSpendTotalUsd`/`insertDiscoveredCandidates` (Task 2), existing `TRACKED_AUTHORS`, `parseTweetId`, `isTweetIngested` (already imported from `db.js`).
- Produces: `runDiscovery(env)` → `Promise<{ ran: boolean, reason?: string, handles?: Array<{ handle, found, estimated_usd }> }>`. Never throws.
- Consumed by: Task 5's manual-trigger endpoint, Task 6's `scheduled()` dispatch.

- [ ] **Step 1: Add the import**

Add to the import block at the top of `worker/index.js`, after the existing `xVerify.js` import:

```js
import { discoverCandidatesForHandle } from './xaiDiscovery.js';
```

Add `logXaiSpend, getXaiSpendTotalUsd, insertDiscoveredCandidates` to the existing `import { ... } from './db.js'` statement at the top of the file (join the existing named-import list rather than adding a second import line for the same module).

- [ ] **Step 2: Add `runDiscovery`**

Add after `handleTrackSource` (before the `export default` block):

```js
// Never throws -- callable from both an admin-triggered endpoint (needs a response)
// and ctx.waitUntil in the scheduled handler (no response to send). Every failure
// path returns a summary object instead, same convention as postSlot/generateForSlot.
async function runDiscovery(env) {
  if (env.XAI_DISCOVERY_PAUSED === 'true') {
    return { ran: false, reason: 'XAI_DISCOVERY_PAUSED is set' };
  }

  const ceiling = Number(env.XAI_DISCOVERY_BUDGET_CEILING_USD ?? '18');
  const spent = await getXaiSpendTotalUsd(env.DB);
  if (spent >= ceiling) {
    return { ran: false, reason: `Budget ceiling reached: $${spent.toFixed(2)} spent of $${ceiling.toFixed(2)}` };
  }

  const handles = [];
  for (const author of TRACKED_AUTHORS) {
    const handle = author.replace(/^@/, '');
    let result;
    try {
      result = await discoverCandidatesForHandle(env, handle);
    } catch (err) {
      console.error(`[discovery] Failed for ${handle}:`, err.message);
      handles.push({ handle, found: 0, estimated_usd: 0, error: err.message });
      continue;
    }

    await logXaiSpend(env.DB, { handle, costUsdTicks: result.costUsdTicks, estimatedUsd: result.estimatedUsd });

    const candidates = [];
    for (const post of result.posts) {
      const tweetId = parseTweetId(post.url);
      if (!tweetId) continue;
      if (await isTweetIngested(env.DB, tweetId)) continue;
      candidates.push({ handle: author, tweet_id: tweetId, post_text: post.text, post_url: post.url, posted_at: post.posted_at });
    }
    await insertDiscoveredCandidates(env.DB, candidates);

    handles.push({ handle, found: candidates.length, estimated_usd: result.estimatedUsd });
  }

  return { ran: true, handles };
}
```

- [ ] **Step 3: Verify the module still loads without syntax errors**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/index.js');
console.log('loaded ok');
"
```
Expected: `loaded ok` (this file has no other named exports besides the default Worker object, so this just confirms no syntax/import errors — the `env.ASSETS`/`env.DB` bindings mean `runDiscovery` itself can't be smoke-tested outside `wrangler dev`, which Task 5 covers with a real HTTP round-trip).

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "Add runDiscovery orchestration: budget gate, spend logging, candidate insertion"
```

---

### Task 5: Admin endpoints for the candidate queue

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Produces: `handleGetDiscoveredCandidates(request, env)`, `handleDismissCandidate(request, env, id)`, `handleDiscoverNow(request, env)` — all `requireAdmin`-gated, following the exact pattern of `handleAdminListPicks`/`handleAdminDeletePick`/`handleGenerateSlot`.
- Routes: `GET /api/admin/discovered-candidates`, `POST /api/admin/discovered-candidates/:id/dismiss`, `POST /api/admin/discover`.
- Consumes: `getDiscoveredCandidates`/`dismissCandidate` (Task 2), `runDiscovery` (Task 4).

- [ ] **Step 1: Add the import**

Add `getDiscoveredCandidates, dismissCandidate` to the existing `./db.js` import list (same statement Task 4 Step 1 touched).

- [ ] **Step 2: Add the handlers**

Add after `handleAdminPipelineStatus` (before `handleTrackSource`):

```js
async function handleGetDiscoveredCandidates(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const candidates = await getDiscoveredCandidates(env.DB);
  return json({ candidates });
}

async function handleDismissCandidate(request, env, id) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  await dismissCandidate(env.DB, id);
  return json({ success: true });
}

async function handleDiscoverNow(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const result = await runDiscovery(env);
  return json(result);
}
```

- [ ] **Step 3: Wire the routes**

Add to the routing block in `fetch()`, after the `/api/admin/generate-slot` route and before the `/api/admin/picks` GET route:

```js
      if (pathname === '/api/admin/discovered-candidates' && request.method === 'GET') {
        return await handleGetDiscoveredCandidates(request, env);
      }
      const dismissMatch = pathname.match(/^\/api\/admin\/discovered-candidates\/(\d+)\/dismiss$/);
      if (dismissMatch && request.method === 'POST') {
        return await handleDismissCandidate(request, env, Number(dismissMatch[1]));
      }
      if (pathname === '/api/admin/discover' && request.method === 'POST') {
        return await handleDiscoverNow(request, env);
      }
```

- [ ] **Step 4: Verify locally**

Requires `XAI_API_KEY` and `ADMIN_SECRET` in `.dev.vars`. Start `npx wrangler dev --local --port 8790`, then:
```
curl -s -X POST http://127.0.0.1:8790/api/admin/discover -H "x-admin-secret: <your local ADMIN_SECRET>"
curl -s http://127.0.0.1:8790/api/admin/discovered-candidates -H "x-admin-secret: <your local ADMIN_SECRET>"
```
Expected: the first call returns `{"ran":true,"handles":[...]}` (real xAI spend, same caveat as Task 3 Step 3 — running this repeatedly during testing adds up, so don't loop it); the second returns any candidates that call found. Then verify dismissal:
```
curl -s -X POST http://127.0.0.1:8790/api/admin/discovered-candidates/1/dismiss -H "x-admin-secret: <your local ADMIN_SECRET>"
```
Expected: `{"success":true}`, and that candidate no longer appears in a follow-up `GET`.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js
git commit -m "Add admin endpoints for discovered tweet candidates"
```

---

### Task 6: Secrets, config, and cron trigger

**Files:**
- Modify: `.dev.vars` (not committed, gitignored)
- Modify: `wrangler.toml`

**Interfaces:** None — configuration only.

- [ ] **Step 1: Add `XAI_API_KEY` to `.dev.vars`**

Append (copy the value already sitting in `.env`'s `XAI_API_KEY` line):
```
XAI_API_KEY=<the key from .env>
```

- [ ] **Step 2: Add the new `[vars]` and cron trigger to `wrangler.toml`**

Add to the existing `[vars]` block:
```toml
XAI_DISCOVERY_PAUSED = "false"
XAI_DISCOVERY_BUDGET_CEILING_USD = "18"
```

Update `[triggers]` — this project's Workers Free plan caps cron triggers at 5 per account (see the existing comment above `crons` in this file); the current 2 strings plus this new one brings the total to 3, still under the cap:
```toml
crons = ["1,6,11,16,21,26,31,36,41,46,51,56 * * * *", "0,15 13,17,22 * * THU,SAT,SUN", "30 12 * * THU,SAT,SUN"]
```

(`30 12 * * THU,SAT,SUN` fires 30 minutes before the existing 13:00 UTC "morning" generation slot, so any discovered candidates are ready before the admin would typically be building out that slot's picks.)

- [ ] **Step 3: Wire the new cron into `scheduled()`**

Modify the `scheduled` export's dispatch logic — add a branch before the existing `else` fallback:

```js
    } else if (isGenerationDay && hour === 12 && minute === 30) {
      ctx.waitUntil(runDiscovery(env));
    } else {
```

(Insert this branch between the existing `generateAndPostPropsSlot` branch and the final `else { handleDailyPostCheck(env) }` branch.)

- [ ] **Step 4: No commit for `.dev.vars`**

Confirm with `git status` that `.dev.vars` doesn't appear as a pending change (gitignored).

- [ ] **Step 5: Commit `wrangler.toml` and `worker/index.js`**

```bash
git add wrangler.toml worker/index.js
git commit -m "Add discovery cron trigger and XAI_DISCOVERY_* config"
```

---

### Task 7: Admin panel UI

**Files:**
- Modify: `src/lib/api.js`
- Modify: `src/pages/AdminPanel.jsx`

**Interfaces:**
- Produces: `getDiscoveredCandidates()`, `dismissCandidate(id)` in `src/lib/api.js`, following the exact pattern of the existing `getFunnel`/`deletePick` functions.

- [ ] **Step 1: Add the API functions**

Add to `src/lib/api.js`, after `getPipelineStatus`:

```js
export async function getDiscoveredCandidates() {
  const headers = await authHeaders();
  return request('/admin/discovered-candidates', { headers });
}

export async function dismissCandidate(id) {
  const headers = await authHeaders();
  return request(`/admin/discovered-candidates/${id}/dismiss`, {
    method: 'POST',
    headers,
  });
}
```

- [ ] **Step 2: Wire state and loading into `AdminPanel.jsx`**

Update the import line at the top:
```js
import { addPick, deletePick, listAllPicks, verifySlot, getFunnel, getPipelineStatus, getDiscoveredCandidates, dismissCandidate } from '../lib/api.js';
```

Add a new state declaration alongside the existing `funnel`/`pipeline` state:
```js
  const [candidates, setCandidates] = useState([]);
```

In the existing `useEffect` that loads `funnel`/`pipeline` on `session`, add a matching load call:
```js
      getDiscoveredCandidates()
        .then((data) => setCandidates(data.candidates || []))
        .catch(() => {
          // Non-critical: the rest of the admin panel still works without it.
        });
```

- [ ] **Step 3: Add handlers**

Add alongside the existing `handleDelete`/`handleVerify` functions:
```js
  const handleUseCandidate = (candidate) => {
    setForm({
      ...emptyForm,
      author: candidate.handle,
      source_tweet_url: candidate.post_url,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDismissCandidate = async (id) => {
    try {
      await dismissCandidate(id);
      setCandidates((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };
```

- [ ] **Step 4: Render the section**

Add a new section after the "Verify a slot" block and before the "Today's pipeline" block:
```jsx
      {candidates.length > 0 && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="text-sm font-semibold text-white">Discovered tweet candidates</span>
          <div className="mt-3 space-y-2">
            {candidates.map((c) => (
              <div key={c.id} className="rounded-md border border-neutral-800 p-3">
                <p className="text-xs text-neutral-500">{c.handle} · {c.posted_at || 'time unknown'}</p>
                <p className="mt-1 text-sm text-neutral-200">{c.post_text}</p>
                <div className="mt-2 flex gap-3">
                  <a href={c.post_url} target="_blank" rel="noreferrer" className="text-xs text-sharp-500 hover:underline">
                    view tweet
                  </a>
                  <button onClick={() => handleUseCandidate(c)} className="text-xs font-medium text-sharp-500 hover:underline">
                    Use this
                  </button>
                  <button onClick={() => handleDismissCandidate(c.id)} className="text-xs font-medium text-red-400 hover:underline">
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 5: Verify manually in the browser**

Run `npm run dev` and `npm run worker:dev` (or `wrangler dev`) together per this project's usual local-dev setup, log in as the admin, and confirm: the "Discovered tweet candidates" section only appears when `candidates.length > 0` (won't show anything until Task 6's cron has fired at least once, or Task 5's manual `/api/admin/discover` endpoint has been hit); "Use this" pre-fills the add-pick form's author and source tweet URL fields; "Dismiss" removes a candidate from the list without a page reload.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.js src/pages/AdminPanel.jsx
git commit -m "Add discovered-candidates review UI to the admin panel"
```

---

### Task 8: Deploy

**Files:** None (deployment step).

- [ ] **Step 1: Apply the schema migration to production D1**

```bash
npx wrangler d1 execute sharpflow-db --remote --file=./worker/schema.sql
```
(Safe to run — both new tables are `CREATE TABLE IF NOT EXISTS`, no existing table is touched.)

- [ ] **Step 2: Add the production secret**

```bash
npx wrangler secret put XAI_API_KEY --name picksharp
```

- [ ] **Step 3: Verify secrets and vars**

```bash
npx wrangler secret list --name picksharp
```
Expected: includes `XAI_API_KEY` alongside the existing secrets. Confirm `XAI_DISCOVERY_PAUSED`/`XAI_DISCOVERY_BUDGET_CEILING_USD` are present in `wrangler.toml`'s `[vars]` (they deploy automatically with the Worker, no separate secret command needed since they're non-sensitive).

- [ ] **Step 4: Merge and push**

Confirm `origin/main` is up to date first (`git fetch origin && git log --oneline -1 origin/main`), then merge this feature branch to `main` and push — this project has had commits stranded on local-only `main` before.

- [ ] **Step 5: Poll for the deploy**

```bash
for i in 1 2 3 4 5 6; do
  sleep 20
  curl -s https://wepicksharp.com/ | grep -o 'assets/index-[^"]*\.js'
done
```

- [ ] **Step 6: Verify the new cron trigger registered**

Check the Cloudflare dashboard's Triggers tab for the `picksharp` Worker — confirm all three cron expressions are listed, including the new `30 12 * * THU,SAT,SUN`.

- [ ] **Step 7: Live verification on the next real game day**

Since this can't be tested end-to-end without an actual Thu/Sat/Sun window arriving, check `SELECT * FROM xai_spend_log ORDER BY called_at DESC LIMIT 5` and `SELECT * FROM discovered_tweet_candidates ORDER BY discovered_at DESC LIMIT 10` on production after the next scheduled firing, and confirm the admin panel shows the new candidates.

- [ ] **Step 8: No commit needed**

Deployment and verification only.
