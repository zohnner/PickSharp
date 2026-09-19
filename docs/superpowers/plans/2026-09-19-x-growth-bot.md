# X Growth Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically post the day's free pick to the `@WePickSharp` X account, with a tracked link back to `/picks`, once each day's picks have stopped changing.

**Architecture:** A new Cloudflare Cron Trigger polls every 5 minutes; once today's newest pick is 15+ minutes old and today hasn't been posted yet, it composes a tweet from a fixed template (`worker/tweetCopy.js`) and posts it via a hand-rolled OAuth 1.0a client (`worker/x.js`, no SDK, matching the existing `worker/stripe.js` pattern). A new `daily_posts` table makes this idempotent per day. A new `buyer_sources` table plus a `/api/track-source` endpoint records which visitors arrived via the bot's link, joinable against `pick_unlocks` for revenue-by-source.

**Tech Stack:** Cloudflare Worker (vanilla JS), D1 (SQLite), X API v2 via raw `fetch` with OAuth 1.0a, React 18 + Vite frontend. No test runner exists in this repo — verification is manual: `node --input-type=module` scripts for pure functions, `wrangler dev` + `curl` for the Worker (including wrangler's `/__scheduled` test endpoint for the cron handler), and X's API itself has no sandbox, so local testing posts real tweets to the `@WePickSharp` account — **set that account to Protected (X Settings → Privacy and safety) before Task 3's verification, and switch it back to public before Task 7's deploy.**

**Spec:** `docs/superpowers/specs/2026-09-19-x-growth-bot-design.md`

## Global Constraints

- Quiet period is exactly 15 minutes (compared against the newest today-dated pick's `created_at`).
- Tweet template is exactly: `🔒 Today's FREE pick from {author}: {pick_text} ({game})\nUnlock the rest of today's sharpest NFL picks 👉 {siteUrl}/picks?ref=x_bot #NFL` — truncate `pick_text` with a trailing `…` if the composed tweet would exceed 280 characters.
- Auth is OAuth 1.0a specifically (static Access Token/Secret, no refresh flow) — not OAuth 2.0. Credentials are `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, already present in `.dev.vars` for local dev.
- The tweet's link must come from a `PUBLIC_SITE_URL` config var (`wrangler.toml`'s `[vars]`), never derived from `request.url` — a Cron Trigger invocation has no incoming request to derive an origin from.
- `daily_posts.date` is the idempotency key: a row's presence means that day is done, full stop, regardless of picks added afterward.
- X's API has no test/sandbox mode — every call is a real, live post. Do not skip the Protected-account step in Task 3.
- No sourcing bot, no AI-generated copy, no results-tracking/recap tweets, no media attachments, no reply/mention automation — all explicitly out of scope per the spec.

---

### Task 1: Schema additions

**Files:**
- Modify: `worker/schema.sql`

**Interfaces:**
- Produces: `daily_posts(date, posted_at, tweet_id)` table (PK on `date`), used by Task 4's idempotency check. `buyer_sources(buyer_token, source, first_seen)` table (PK on `buyer_token`), used by Task 5's tracking endpoint.

- [ ] **Step 1: Add both tables**

Append to `worker/schema.sql`, after the `idx_picks_created_at` index line (line 49) and before the `-- Seed data` comment:

```sql
CREATE TABLE IF NOT EXISTS daily_posts (
  date TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buyer_sources (
  buyer_token TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Apply to local D1**

Run: `npm run db:migrate:local`
Expected: output shows the new `CREATE TABLE` statements executing successfully alongside the existing ones (all `IF NOT EXISTS`, so re-running is safe).

- [ ] **Step 3: Verify both tables exist**

Run: `npx wrangler d1 execute sharpflow-db --local --command "SELECT name FROM sqlite_master WHERE name IN ('daily_posts', 'buyer_sources');"`
Expected: JSON output listing both table names.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add daily_posts and buyer_sources tables for X growth bot"
```

---

### Task 2: Tweet copy template

**Files:**
- Create: `worker/tweetCopy.js`

**Interfaces:**
- Produces: `composeTweet(pick, siteUrl)` — takes a pick row (with `author`, `pick_text`, `game` fields, same shape as rows from `getTodaysPicksRaw`) and a base site URL string, returns the tweet text as a string, truncating `pick_text` if needed to stay under 280 characters.
- Consumed by: Task 4's scheduled handler.

- [ ] **Step 1: Write the module**

```js
const MAX_TWEET_LENGTH = 280;

export function composeTweet(pick, siteUrl) {
  const link = `${siteUrl}/picks?ref=x_bot`;
  const prefix = `🔒 Today's FREE pick from ${pick.author}: `;
  const gameSuffix = ` (${pick.game})`;
  const suffix = `\nUnlock the rest of today's sharpest NFL picks 👉 ${link} #NFL`;

  const fixedLength = prefix.length + gameSuffix.length + suffix.length;
  const maxPickTextLength = MAX_TWEET_LENGTH - fixedLength;

  let pickText = pick.pick_text;
  if (pickText.length > maxPickTextLength) {
    pickText = pickText.slice(0, Math.max(0, maxPickTextLength - 1)) + '…';
  }

  return `${prefix}${pickText}${gameSuffix}${suffix}`;
}
```

- [ ] **Step 2: Verify with a throwaway script**

Run:
```
node --input-type=module -e "
import { composeTweet } from './worker/tweetCopy.js';
const pick = { author: 'AlphaBets', pick_text: 'Take the over', game: 'Team A vs Team B' };
const tweet = composeTweet(pick, 'https://wepicksharp.com');
console.log(tweet);
console.log('Length:', tweet.length);
"
```
Expected output:
```
🔒 Today's FREE pick from AlphaBets: Take the over (Team A vs Team B)
Unlock the rest of today's sharpest NFL picks 👉 https://wepicksharp.com/picks?ref=x_bot #NFL
Length: 142
```
(Exact length may differ slightly; the key checks are that the text reads correctly and Length is well under 280.)

- [ ] **Step 3: Verify truncation with a long pick_text**

Run:
```
node --input-type=module -e "
import { composeTweet } from './worker/tweetCopy.js';
const pick = { author: 'AlphaBets', pick_text: 'A'.repeat(300), game: 'Team A vs Team B' };
const tweet = composeTweet(pick, 'https://wepicksharp.com');
console.log('Length:', tweet.length);
console.log('Contains ellipsis:', tweet.includes('…'));
"
```
Expected: `Length:` is `280` or less, and `Contains ellipsis: true`.

- [ ] **Step 4: Commit**

```bash
git add worker/tweetCopy.js
git commit -m "Add tweet copy template with 280-char truncation"
```

---

### Task 3: X API integration (OAuth 1.0a)

**Files:**
- Create: `worker/x.js`

**Interfaces:**
- Produces: `postTweet(env, text)` — signs and sends a `POST /2/tweets` request to X's API using OAuth 1.0a, returns the created tweet's id (string). Throws `Error` with X's error message on non-2xx.
- Consumes: `env.X_API_KEY`, `env.X_API_KEY_SECRET`, `env.X_ACCESS_TOKEN`, `env.X_ACCESS_TOKEN_SECRET`.
- Consumed by: Task 4's scheduled handler.

**Before starting this task: set the `@WePickSharp` X account to Protected** (X Settings → Privacy and safety → Audience and tagging → "Protect your posts"). Step 3 below posts a real tweet — this keeps it from being publicly visible. Switch it back to public before Task 7.

- [ ] **Step 1: Write the OAuth 1.0a signing and posting logic**

```js
const X_API_BASE = 'https://api.x.com/2';

function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function buildAuthHeader(env, method, url) {
  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
    .join('&');

  const signatureBase = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join(
    '&'
  );

  const signingKey = `${percentEncode(env.X_API_KEY_SECRET)}&${percentEncode(env.X_ACCESS_TOKEN_SECRET)}`;
  const signature = await hmacSha1(signingKey, signatureBase);

  const authParams = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(authParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(authParams[key])}"`)
      .join(', ')
  );
}

export async function postTweet(env, text) {
  const url = `${X_API_BASE}/tweets`;
  const authHeader = await buildAuthHeader(env, 'POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || data.title || `X API request failed: ${res.status}`);
  }
  return data.data.id;
}
```

- [ ] **Step 2: Verify the module loads and exports what's expected**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/x.js');
console.log(typeof mod.postTweet);
"
```
Expected: `function`.

- [ ] **Step 3: Post a real test tweet to verify the OAuth signing actually works**

**Confirm the account is Protected first (see note above this task).** Then run:
```
node --input-type=module -e "
import { postTweet } from './worker/x.js';
import { readFileSync } from 'fs';
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx), l.slice(idx + 1)];
    })
);
const id = await postTweet(vars, 'Test tweet from PickSharp bot setup — please ignore.');
console.log('Posted tweet id:', id);
"
```
Expected: prints a numeric tweet id with no error. Check the `@WePickSharp` account (while still Protected) to confirm the tweet actually appears.

**If this fails with a 401/signature error:** the most common cause is the OAuth 1.0a signature base string incorrectly including the JSON body — it must not; only the `oauth_*` parameters belong in the signature for a JSON-body request. Double-check the `buildAuthHeader` function isn't including `text` from the request body anywhere in `oauthParams` or `paramString`.

- [ ] **Step 4: Commit**

```bash
git add worker/x.js
git commit -m "Add OAuth 1.0a X API client for posting tweets"
```

---

### Task 4: Cron-triggered posting

**Files:**
- Modify: `worker/index.js`
- Modify: `wrangler.toml`
- Modify: `.dev.vars` (add `PUBLIC_SITE_URL` for local testing — not committed, already gitignored)

**Interfaces:**
- Consumes: `composeTweet` from `worker/tweetCopy.js` (Task 2), `postTweet` from `worker/x.js` (Task 3), `getTodaysPicksRaw`/`freePickId` from `worker/db.js` (already imported).
- Produces: a `scheduled` export on the Worker's default export, invoked by the Cron Trigger; internally calls a new `handleDailyPostCheck(env)` function.

- [ ] **Step 1: Add the scheduled handler function**

Add to `worker/index.js`, after `handleCheckoutConfirm` (after line 263) and before `export default {`:

```js
const QUIET_PERIOD_MINUTES = 15;

async function handleDailyPostCheck(env) {
  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now')`
  ).first();
  if (alreadyPosted) return;

  const picks = await getTodaysPicksRaw(env.DB);
  if (picks.length === 0) return;

  const newestRow = await env.DB.prepare(
    `SELECT MAX(created_at) AS newest FROM picks WHERE date(created_at) = date('now')`
  ).first();
  const minutesRow = await env.DB.prepare(
    `SELECT (julianday('now') - julianday(?)) * 24 * 60 AS minutes_since`
  )
    .bind(newestRow.newest)
    .first();
  if (minutesRow.minutes_since < QUIET_PERIOD_MINUTES) return;

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    console.error('Failed to post daily tweet:', err.message);
    return;
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, tweet_id) VALUES (date('now'), ?)`)
    .bind(tweetId)
    .run();
}
```

- [ ] **Step 2: Wire the imports and the `scheduled` export**

Update the import block at the top of `worker/index.js` (currently lines 1-14) to add the two new imports:

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
} from './db.js';
import { priceForConfidence, bundlePrice } from './pricing.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { composeTweet } from './tweetCopy.js';
import { postTweet } from './x.js';
```

Replace the `export default {` block (currently lines 265-316) to add a `scheduled` handler alongside the existing `fetch` handler:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/api/auth/signup' && request.method === 'POST') {
        return await handleSignup(request, env);
      }
      if (pathname === '/api/auth/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (pathname === '/api/user/me' && request.method === 'GET') {
        return await handleGetMe(request, env);
      }
      if (pathname === '/api/picks/today' && request.method === 'GET') {
        return await handleGetPicksToday(request, env);
      }
      if (pathname === '/api/checkout/pick' && request.method === 'POST') {
        return await handleCheckoutPick(request, env);
      }
      if (pathname === '/api/checkout/bundle' && request.method === 'POST') {
        return await handleCheckoutBundle(request, env);
      }
      if (pathname === '/api/checkout/confirm' && request.method === 'GET') {
        return await handleCheckoutConfirm(request, env);
      }
      if (pathname === '/api/admin/picks' && request.method === 'GET') {
        return await handleAdminListPicks(request, env);
      }
      if (pathname === '/api/admin/picks' && request.method === 'POST') {
        return await handleAdminCreatePick(request, env);
      }
      const deleteMatch = pathname.match(/^\/api\/admin\/picks\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleAdminDeletePick(request, env, Number(deleteMatch[1]));
      }

      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleDailyPostCheck(env));
  },
};
```

(This step only adds the `scheduled` export — the `fetch` handler's body is unchanged from what's already there, reproduced here so the whole block can be replaced cleanly.)

- [ ] **Step 3: Add the cron trigger and PUBLIC_SITE_URL to wrangler.toml**

Add to `wrangler.toml`, after the `[vars]` block's existing two lines (`SUPABASE_URL` and `SUPABASE_ANON_KEY`):

```toml
PUBLIC_SITE_URL = "https://wepicksharp.com"

[triggers]
crons = ["*/5 * * * *"]
```

- [ ] **Step 4: Add PUBLIC_SITE_URL to .dev.vars for local testing**

Append to `.dev.vars`:
```
PUBLIC_SITE_URL=http://127.0.0.1:8787
```

- [ ] **Step 5: Restart wrangler dev and verify the scheduled handler end-to-end**

**Confirm the `@WePickSharp` account is still Protected before this step — it posts a real tweet.**

Restart `npx wrangler dev --local --port 8787`.

Seed a pick with a `created_at` old enough to already be past the quiet period, so this test doesn't require waiting 15 real minutes:
```
npx wrangler d1 execute sharpflow-db --local --command "INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, created_at) VALUES ('TestAuthor', 'Test pick text', 'spread', 'low', 'Team X vs Team Y', 'Today 1:00 PM', datetime('now', '-20 minutes'));"
```

Trigger the scheduled handler using wrangler's local test endpoint:
```
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```
Expected: no error in the terminal running `wrangler dev`; check the `@WePickSharp` account for a new tweet matching the template with "Test pick text".

Verify idempotency — run the same curl command again:
```
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```
Expected: no second tweet posted (check the account). Confirm via:
```
npx wrangler d1 execute sharpflow-db --local --command "SELECT * FROM daily_posts;"
```
Expected: exactly one row for today's date.

- [ ] **Step 6: Commit**

```bash
git add worker/index.js wrangler.toml
git commit -m "Add cron-triggered daily tweet posting"
```

(`.dev.vars` is gitignored and won't be staged — confirm with `git status` that it doesn't appear before committing.)

---

### Task 5: Attribution endpoint

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Produces: `POST /api/track-source` — takes `{ buyer_token, source }`, returns `{ ok: true }`. First-touch only (uses `INSERT OR IGNORE`).

- [ ] **Step 1: Add the handler**

Add to `worker/index.js`, after `handleDailyPostCheck` (added in Task 4) and before `export default {`:

```js
async function handleTrackSource(request, env) {
  const { buyer_token, source } = await request.json();
  if (!buyer_token || !source) {
    return json({ error: 'buyer_token and source are required' }, 400);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO buyer_sources (buyer_token, source) VALUES (?, ?)')
    .bind(buyer_token, source)
    .run();
  return json({ ok: true });
}
```

- [ ] **Step 2: Wire the route**

In the `fetch` handler's route list in `worker/index.js`, add this block after the `/api/checkout/confirm` block:

```js
      if (pathname === '/api/track-source' && request.method === 'POST') {
        return await handleTrackSource(request, env);
      }
```

- [ ] **Step 3: Restart wrangler dev and verify**

Run: `npx wrangler dev --local --port 8787`

Run:
```
curl -s -X POST http://127.0.0.1:8787/api/track-source \
  -H "Content-Type: application/json" \
  -d '{"buyer_token": "test-attribution-buyer", "source": "x_bot"}'
```
Expected: `{"ok":true}`.

Verify it was recorded and is first-touch (a second call with a different source doesn't overwrite):
```
npx wrangler d1 execute sharpflow-db --local --command "SELECT * FROM buyer_sources WHERE buyer_token = 'test-attribution-buyer';"
```
Expected: one row with `source` = `x_bot`.

```
curl -s -X POST http://127.0.0.1:8787/api/track-source \
  -H "Content-Type: application/json" \
  -d '{"buyer_token": "test-attribution-buyer", "source": "organic"}'
```
```
npx wrangler d1 execute sharpflow-db --local --command "SELECT * FROM buyer_sources WHERE buyer_token = 'test-attribution-buyer';"
```
Expected: still exactly one row, `source` still `x_bot` (unchanged — confirms `INSERT OR IGNORE` preserved first-touch attribution).

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "Add /api/track-source endpoint for referral attribution"
```

---

### Task 6: Frontend referral tracking

**Files:**
- Modify: `src/lib/api.js`
- Modify: `src/pages/Picks.jsx`

**Interfaces:**
- Consumes: none new.
- Produces: `trackSource(buyerToken, source)` in `src/lib/api.js`, called from `Picks.jsx` when a `?ref=` param is present.

- [ ] **Step 1: Add the API client function**

Add to `src/lib/api.js`, after `confirmCheckout` (after line 71):

```js

export async function trackSource(buyerToken, source) {
  return request('/track-source', {
    method: 'POST',
    body: JSON.stringify({ buyer_token: buyerToken, source }),
  });
}
```

- [ ] **Step 2: Call it from Picks.jsx when a ref param is present**

Update the import line in `src/pages/Picks.jsx` (currently line 5):

```jsx
import { getTodaysPicks, checkoutBundle, confirmCheckout, trackSource } from '../lib/api.js';
```

Update the `useEffect` block (currently lines 40-48) to also fire the tracking call, without blocking picks loading on it:

```jsx
  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    const ref = searchParams.get('ref');
    if (ref) {
      trackSource(buyerToken, ref).catch(() => {
        // Non-critical: attribution tracking failing shouldn't block the page.
      });
    }
    if (sessionId) {
      runConfirm(sessionId);
    } else {
      loadPicks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 4: Verify in a browser**

Run `npx wrangler dev --local --port 8787` and `npm run dev`. Visit `http://127.0.0.1:8787/picks?ref=x_bot` (use the Worker's own origin, not the split Vite dev server, per this project's established local-testing convention for anything involving redirects/params).

Check the Network tab for a `POST /api/track-source` call with `{"buyer_token": "...", "source": "x_bot"}`, then verify:
```
npx wrangler d1 execute sharpflow-db --local --command "SELECT * FROM buyer_sources ORDER BY first_seen DESC LIMIT 1;"
```
Expected: a row with `source = 'x_bot'` and a `buyer_token` matching the one in `localStorage` for that origin (check via DevTools → Application → Local Storage → `sharp_buyer_token`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.js src/pages/Picks.jsx
git commit -m "Track referral source when a pick link includes a ref param"
```

---

### Task 7: Deploy

**Files:** None (deployment step).

**Before this task: switch the `@WePickSharp` account back to public** (undo the Protected setting from Task 3), since production tweets should be visible.

- [ ] **Step 1: Add the X credentials as production secrets**

Run each of these (they'll prompt for the value — paste from `.env`):
```bash
npx wrangler secret put X_API_KEY --name picksharp
npx wrangler secret put X_API_KEY_SECRET --name picksharp
npx wrangler secret put X_ACCESS_TOKEN --name picksharp
npx wrangler secret put X_ACCESS_TOKEN_SECRET --name picksharp
```

- [ ] **Step 2: Verify the secrets are registered**

Run: `npx wrangler secret list --name picksharp`
Expected: JSON listing includes `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (alongside the existing `STRIPE_SECRET_KEY`).

- [ ] **Step 3: Apply the new tables to production D1**

Run:
```bash
npx wrangler d1 execute sharpflow-db --remote --command "
CREATE TABLE IF NOT EXISTS daily_posts (
  date TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS buyer_sources (
  buyer_token TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
"
```
Expected: successful execution, 2 commands run.

- [ ] **Step 4: Push to trigger a deploy**

```bash
git push origin main
```

- [ ] **Step 5: Poll for the new deploy**

```bash
for i in 1 2 3 4 5 6; do
  sleep 20
  curl -s https://wepicksharp.com/ | grep -o 'assets/index-[^"]*\.js'
done
```
Expected: the JS asset hash changes partway through, confirming the new build landed.

- [ ] **Step 6: Verify the cron trigger is registered**

Run: `npx wrangler deployments list --name picksharp | head -5`
(Cron trigger status is also visible in the Cloudflare dashboard under the Worker's "Triggers" tab — confirm `*/5 * * * *` appears there.)

- [ ] **Step 7: Live verification**

Once today's real picks are entered via the admin panel and 15+ minutes pass without further edits, confirm a real tweet appears on `@WePickSharp` (now public) linking to `https://wepicksharp.com/picks?ref=x_bot`. Click the link yourself and confirm `/api/track-source` recorded it:
```bash
npx wrangler d1 execute sharpflow-db --remote --command "SELECT * FROM buyer_sources ORDER BY first_seen DESC LIMIT 5;"
```

- [ ] **Step 8: No commit needed**

This task is deployment and data verification, not a code change.
