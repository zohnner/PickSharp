# Pay-Per-Pick Paywall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PickSharp's unused subscription/`is_premium` gating with a real Stripe-backed pay-per-pick paywall: one free pick a day, everything else unlockable individually or as a discounted bundle, no login required.

**Architecture:** The Worker gains a `worker/stripe.js` helper (raw `fetch` calls to Stripe's REST API — no SDK, since Workers don't need Node's Stripe client) and a `worker/pricing.js` module (confidence → price mapping, pure functions, no I/O). `worker/db.js` gains query functions for today's picks, the day's free pick, and recording/reading unlocks. `worker/index.js` wires three new endpoints on top of these and strips dead subscription code. On the frontend, a new `src/lib/buyerToken.js` generates a per-browser anonymous id; `PickCard.jsx` renders locked picks as a paywall instead of content; `Picks.jsx` adds a bundle-unlock CTA and handles the Stripe return redirect.

**Tech Stack:** Cloudflare Worker (vanilla JS, no framework), D1 (SQLite), Stripe REST API via `fetch`, React 18 + Vite frontend. No test runner exists in this repo (`package.json` has no `test` script) — verification throughout is manual: `wrangler dev` + `curl` for the Worker, and the browser (with Stripe test-mode card `4242 4242 4242 4242`) for full end-to-end checks. This matches how the rest of the MVP was built and verified, and is what the spec's own Testing Plan section specifies.

**Spec:** `docs/superpowers/specs/2026-09-16-pay-per-pick-design.md`

## Global Constraints

- Price mapping is exactly `{ low: 199, medium: 299, high: 499 }` (cents), defined once in `worker/pricing.js`.
- Bundle discount is exactly 20%, applied per line item (`Math.round(price * 0.8)`), not via a Stripe Coupon object.
- No Stripe webhook, no signing secret — `GET /api/checkout/confirm` is the only unlock-recording path (spec's explicit non-goal).
- No login/account tie-in to unlocks — identity is a `buyer_token` UUID in `localStorage`, full stop.
- `users.is_premium` column stays in the schema (dropping it via `ALTER TABLE` on the live production D1 is an unnecessary risk for a column nothing will read or write anymore) — only the *code* that reads/writes it is removed.
- `worker/schema.sql` is applied by hand via `npm run db:migrate:local` / `db:migrate:remote` (no migrations framework) — any new DDL added to it must be safe to re-run (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) since it's the same file already applied once to both local and production D1.
- `STRIPE_SECRET_KEY` is a genuine secret: goes in `.dev.vars` locally (gitignored, already established pattern) and the Cloudflare dashboard's Variables and Secrets in production — never in `wrangler.toml`.

---

### Task 1: `pick_unlocks` table

**Files:**
- Modify: `worker/schema.sql`

**Interfaces:**
- Produces: `pick_unlocks(id, buyer_token, pick_id, stripe_session_id, unlocked_at)` table with `UNIQUE(stripe_session_id, pick_id)`, used by Task 3's `db.js` functions.

- [ ] **Step 1: Add the table and index**

Append to `worker/schema.sql`, after the existing `events` table block and before the `CREATE INDEX IF NOT EXISTS idx_picks_created_at` line:

```sql
CREATE TABLE IF NOT EXISTS pick_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_token TEXT NOT NULL,
  pick_id INTEGER NOT NULL,
  stripe_session_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pick_id) REFERENCES picks(id),
  UNIQUE (stripe_session_id, pick_id)
);
```

And add its index alongside the existing one:

```sql
CREATE INDEX IF NOT EXISTS idx_pick_unlocks_buyer ON pick_unlocks(buyer_token);
```

- [ ] **Step 2: Apply to local D1**

Run: `npm run db:migrate:local`
Expected: output lists 9 successful commands (the 7 from before + the 2 new statements), no errors. `CREATE TABLE IF NOT EXISTS` means this is safe even though `users`/`picks`/etc. already exist locally.

- [ ] **Step 3: Verify the table exists locally**

Run: `npx wrangler d1 execute sharpflow-db --local --command "SELECT sql FROM sqlite_master WHERE name='pick_unlocks';"`
Expected: JSON output showing the `CREATE TABLE` statement with `UNIQUE (stripe_session_id, pick_id)` in it.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add pick_unlocks table for pay-per-pick paywall"
```

---

### Task 2: Pricing module

**Files:**
- Create: `worker/pricing.js`

**Interfaces:**
- Produces: `PRICE_CENTS` (object), `priceForConfidence(confidence)` (returns integer cents, throws on unknown confidence), `bundlePrice(cents)` (returns integer cents after 20% discount, rounded).
- Consumed by: Task 4's `db.js` locking query and Task 5's checkout endpoints.

- [ ] **Step 1: Write the module**

```js
export const PRICE_CENTS = { low: 199, medium: 299, high: 499 };

export function priceForConfidence(confidence) {
  const cents = PRICE_CENTS[confidence];
  if (cents === undefined) {
    throw new Error(`Unknown confidence level: ${confidence}`);
  }
  return cents;
}

export function bundlePrice(cents) {
  return Math.round(cents * 0.8);
}
```

- [ ] **Step 2: Verify with a throwaway script**

Run:
```
node --input-type=module -e "import {priceForConfidence, bundlePrice} from './worker/pricing.js'; console.log(priceForConfidence('high'), bundlePrice(499));"
```
Expected output: `499 399` (499 * 0.8 = 399.2, rounds to 399).

- [ ] **Step 3: Commit**

```bash
git add worker/pricing.js
git commit -m "Add confidence-to-price mapping for pay-per-pick"
```

---

### Task 3: Stripe REST helper

**Files:**
- Create: `worker/stripe.js`

**Interfaces:**
- Produces: `createCheckoutSession(env, { lineItems, metadata, successUrl, cancelUrl })` → resolves to the Stripe Checkout Session object (has `.url`, `.id`); `retrieveCheckoutSession(env, sessionId)` → resolves to the Session object (has `.payment_status`, `.metadata`). Both throw `Error` with Stripe's message on non-2xx.
- Consumes: `env.STRIPE_SECRET_KEY`.
- Consumed by: Task 5's checkout endpoints and Task 6's confirm endpoint.

- [ ] **Step 1: Write the form-encoding helper and both API calls**

```js
const STRIPE_API = 'https://api.stripe.com/v1';

function formEncode(obj, prefix = '') {
  const params = [];
  for (const [key, value] of Object.entries(obj)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === 'object') {
          params.push(formEncode(item, `${paramKey}[${i}]`));
        } else {
          params.push(`${encodeURIComponent(`${paramKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (value && typeof value === 'object') {
      params.push(formEncode(value, paramKey));
    } else {
      params.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return params.join('&');
}

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Stripe request failed: ${res.status}`);
  }
  return data;
}

export async function createCheckoutSession(env, { lineItems, metadata, successUrl, cancelUrl }) {
  return stripeRequest(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems,
    metadata,
  });
}

export async function retrieveCheckoutSession(env, sessionId) {
  return stripeRequest(env, 'GET', `/checkout/sessions/${sessionId}`);
}
```

- [ ] **Step 2: Verify the module loads and exports what's expected**

Run:
```
node --input-type=module -e "
const mod = await import('./worker/stripe.js');
console.log(typeof mod.createCheckoutSession, typeof mod.retrieveCheckoutSession);
"
```
Expected: `function function` (confirms the module loads and exports both names — full behavior is verified end-to-end in Task 5 once a real Stripe key is available).

- [ ] **Step 3: Commit**

```bash
git add worker/stripe.js
git commit -m "Add Stripe REST API helper for checkout sessions"
```

---

### Task 4: Locking logic in `worker/db.js`

**Files:**
- Modify: `worker/db.js`
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `priceForConfidence` from `worker/pricing.js` (Task 2).
- Produces: `getTodaysPicksRaw(db)` → array of picks created today (ASC by `created_at`, includes `pick_text`/`affiliate_link` always — redaction happens in `index.js`, not here); `freePickId(picks)` → the id of today's free pick or `null` if `picks` is empty; `getUnlockedPickIds(db, buyerToken)` → `Set<number>`; `insertUnlocks(db, { buyerToken, pickIds, stripeSessionId })` → void.
- Existing `getPicks`, `insertPick`, `deletePickById`, `upsertUser`, `getUserById` are untouched — the admin panel (`handleAdminListPicks`) keeps using `getPicks(env.DB, {})` exactly as before.

- [ ] **Step 1: Add the new functions to `worker/db.js`**

Add to the bottom of `worker/db.js`:

```js
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export async function getTodaysPicksRaw(db) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
              p.affiliate_link, p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
       FROM picks p
       LEFT JOIN picker_stats s ON s.author = p.author
       WHERE date(p.created_at) = date('now')
       ORDER BY p.created_at ASC`
    )
    .all();
  return results;
}

export function freePickId(picks) {
  if (picks.length === 0) return null;
  const freest = picks.reduce((current, pick) => {
    if (!current) return pick;
    const rank = CONFIDENCE_RANK[pick.confidence] ?? 1;
    const currentRank = CONFIDENCE_RANK[current.confidence] ?? 1;
    if (rank < currentRank) return pick;
    if (rank === currentRank && pick.created_at < current.created_at) return pick;
    return current;
  }, null);
  return freest.id;
}

export async function getUnlockedPickIds(db, buyerToken) {
  if (!buyerToken) return new Set();
  const { results } = await db
    .prepare('SELECT DISTINCT pick_id FROM pick_unlocks WHERE buyer_token = ?')
    .bind(buyerToken)
    .all();
  return new Set(results.map((r) => r.pick_id));
}

export async function insertUnlocks(db, { buyerToken, pickIds, stripeSessionId }) {
  const stmts = pickIds.map((pickId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO pick_unlocks (buyer_token, pick_id, stripe_session_id)
         VALUES (?, ?, ?)`
      )
      .bind(buyerToken, pickId, stripeSessionId)
  );
  await db.batch(stmts);
}
```

- [ ] **Step 2: Wire `handleGetPicksToday` in `worker/index.js` to use these**

Replace the current `handleGetPicksToday` function (`worker/index.js:70-81`) with:

```js
async function handleGetPicksToday(request, env) {
  const url = new URL(request.url);
  const buyerToken = url.searchParams.get('buyer_token') || '';

  const picks = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(picks);
  const unlockedIds = await getUnlockedPickIds(env.DB, buyerToken);

  const shaped = picks
    .map((pick) => {
      const locked = pick.id !== freeId && !unlockedIds.has(pick.id);
      if (!locked) {
        return { ...pick, locked: false };
      }
      const { pick_text, affiliate_link, ...rest } = pick;
      return { ...rest, locked: true, price_cents: priceForConfidence(pick.confidence) };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return json({ picks: shaped });
}
```

And update the import line at the top of `worker/index.js` (currently `import { getPicks, insertPick, deletePickById, upsertUser, getUserById } from './db.js';`) to:

```js
import {
  getPicks,
  insertPick,
  deletePickById,
  upsertUser,
  getUserById,
  getTodaysPicksRaw,
  freePickId,
  getUnlockedPickIds,
  insertUnlocks,
} from './db.js';
import { priceForConfidence, bundlePrice } from './pricing.js';
```

(`insertUnlocks` and `bundlePrice` aren't used until Tasks 5-6, but importing them now avoids touching this import line three more times.)

- [ ] **Step 3: Restart wrangler dev and verify the shape**

Run: `npx wrangler dev --local --port 8787` (background it or use a second terminal)

Run: `curl -s http://127.0.0.1:8787/api/picks/today | head -c 800`

Expected: exactly one pick has `"locked": false` and includes `pick_text`; every other pick has `"locked": true`, has `price_cents` matching its confidence tier from `PRICE_CENTS`, and has **no** `pick_text` or `affiliate_link` key at all in the JSON.

- [ ] **Step 4: Verify locked picks never leak pick_text over the wire**

Run: `curl -s http://127.0.0.1:8787/api/picks/today | grep -o '"pick_text":"[^"]*"'`
Expected: exactly one match (the free pick's text) — confirms locked picks' text isn't merely hidden client-side but genuinely absent from the response.

- [ ] **Step 5: Commit**

```bash
git add worker/db.js worker/index.js
git commit -m "Gate picks per-item instead of by subscription/date window"
```

---

### Task 5: Checkout endpoints (single pick + bundle)

**Files:**
- Modify: `worker/index.js`
- Modify: `.dev.vars` (add `STRIPE_SECRET_KEY` — not committed, already gitignored)

**Interfaces:**
- Consumes: `createCheckoutSession` from `worker/stripe.js` (Task 3), `priceForConfidence`/`bundlePrice` from `worker/pricing.js` (Task 2), `getTodaysPicksRaw`/`freePickId` from `worker/db.js` (Task 4).
- Produces: `POST /api/checkout/pick` and `POST /api/checkout/bundle`, both returning `{ url }` on success.

- [ ] **Step 1: Add the Stripe import**

At the top of `worker/index.js`, add:

```js
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
```

- [ ] **Step 2: Add the two handler functions**

Add above the `export default {` block in `worker/index.js`:

```js
async function handleCheckoutPick(request, env) {
  const { pick_id, buyer_token } = await request.json();
  if (!pick_id || !buyer_token) {
    return json({ error: 'pick_id and buyer_token are required' }, 400);
  }

  const picks = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(picks);
  const pick = picks.find((p) => p.id === pick_id);

  if (!pick || pick.id === freeId) {
    return json({ error: 'Pick not found or not purchasable' }, 400);
  }

  const origin = new URL(request.url).origin;
  const priceCents = priceForConfidence(pick.confidence);

  let session;
  try {
    session = await createCheckoutSession(env, {
      lineItems: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: priceCents,
            product_data: { name: `${pick.author} pick: ${pick.game}` },
          },
          quantity: 1,
        },
      ],
      metadata: { buyer_token, pick_ids: String(pick.id) },
      successUrl: `${origin}/picks?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/picks`,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  return json({ url: session.url });
}

async function handleCheckoutBundle(request, env) {
  const { pick_ids, buyer_token } = await request.json();
  if (!Array.isArray(pick_ids) || pick_ids.length === 0 || !buyer_token) {
    return json({ error: 'pick_ids (non-empty array) and buyer_token are required' }, 400);
  }

  const picks = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(picks);
  const purchasable = picks.filter((p) => pick_ids.includes(p.id) && p.id !== freeId);

  if (purchasable.length === 0) {
    return json({ error: 'No purchasable picks in pick_ids' }, 400);
  }

  const origin = new URL(request.url).origin;
  const lineItems = purchasable.map((pick) => ({
    price_data: {
      currency: 'usd',
      unit_amount: bundlePrice(priceForConfidence(pick.confidence)),
      product_data: { name: `${pick.author} pick: ${pick.game}` },
    },
    quantity: 1,
  }));

  let session;
  try {
    session = await createCheckoutSession(env, {
      lineItems,
      metadata: { buyer_token, pick_ids: purchasable.map((p) => p.id).join(',') },
      successUrl: `${origin}/picks?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/picks`,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  return json({ url: session.url });
}
```

- [ ] **Step 3: Wire the routes**

In the `fetch` handler's route list in `worker/index.js`, add these two blocks after the `/api/picks/today` block:

```js
      if (pathname === '/api/checkout/pick' && request.method === 'POST') {
        return await handleCheckoutPick(request, env);
      }
      if (pathname === '/api/checkout/bundle' && request.method === 'POST') {
        return await handleCheckoutBundle(request, env);
      }
```

- [ ] **Step 4: Add your Stripe test secret key to `.dev.vars`**

Add a line to `.dev.vars` (already gitignored):
```
STRIPE_SECRET_KEY=sk_test_...
```
(Get this from your Stripe dashboard: Developers → API keys → "Secret key", make sure you're in **test mode**.)

- [ ] **Step 5: Restart wrangler dev and verify single-pick checkout**

Restart `npx wrangler dev --local --port 8787`.

Run:
```
curl -s http://127.0.0.1:8787/api/picks/today | grep -o '"id":[0-9]*,"author":"[^"]*"[^}]*"locked":true' | head -1
```
Note a locked pick's id from that output, then:

```
curl -s -X POST http://127.0.0.1:8787/api/checkout/pick \
  -H "Content-Type: application/json" \
  -d '{"pick_id": <id from above>, "buyer_token": "test-buyer-1"}'
```
Expected: `{"url":"https://checkout.stripe.com/..."}`. If you instead get a Stripe error message, the most common cause is the secret key being a live key instead of test, or malformed.

- [ ] **Step 6: Verify bundle checkout**

Run:
```
curl -s http://127.0.0.1:8787/api/picks/today | grep -o '"id":[0-9]*,"author":"[^"]*"[^}]*"locked":true' | grep -o '"id":[0-9]*' | grep -o '[0-9]*'
```
This lists all locked pick ids (should be 4 of the 5 seeded picks). Then:
```
curl -s -X POST http://127.0.0.1:8787/api/checkout/bundle \
  -H "Content-Type: application/json" \
  -d '{"pick_ids": [<id1>, <id2>, <id3>, <id4>], "buyer_token": "test-buyer-1"}'
```
Expected: `{"url":"https://checkout.stripe.com/..."}`.

- [ ] **Step 7: Commit**

```bash
git add worker/index.js .dev.vars
git status
```

Check the `git status` output: `.dev.vars` must NOT appear as staged (it's gitignored) — if it does, something is wrong with `.gitignore` and you must stop and fix that before committing, since it holds a real Stripe secret key.

```bash
git commit -m "Add single-pick and bundle Stripe Checkout endpoints"
```

---

### Task 6: Confirm endpoint

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `retrieveCheckoutSession` from `worker/stripe.js`, `insertUnlocks` from `worker/db.js`.
- Produces: `GET /api/checkout/confirm?session_id=...&buyer_token=...` → `{ unlocked_pick_ids: [...] }`.

- [ ] **Step 1: Add the handler**

```js
async function handleCheckoutConfirm(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const buyerToken = url.searchParams.get('buyer_token');

  if (!sessionId || !buyerToken) {
    return json({ error: 'session_id and buyer_token are required' }, 400);
  }

  let session;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  if (session.payment_status !== 'paid') {
    return json({ error: 'Payment not confirmed' }, 402);
  }
  if (session.metadata?.buyer_token !== buyerToken) {
    return json({ error: 'buyer_token does not match this session' }, 400);
  }

  const pickIds = session.metadata.pick_ids.split(',').map(Number);
  await insertUnlocks(env.DB, { buyerToken, pickIds, stripeSessionId: sessionId });

  return json({ unlocked_pick_ids: pickIds });
}
```

- [ ] **Step 2: Wire the route**

Add after the `/api/checkout/bundle` block:

```js
      if (pathname === '/api/checkout/confirm' && request.method === 'GET') {
        return await handleCheckoutConfirm(request, env);
      }
```

- [ ] **Step 3: Full round-trip verification in a browser**

Restart `npx wrangler dev --local --port 8787`. Since the frontend isn't wired up yet (Tasks 8-10), drive this manually:

1. Run the single-pick checkout curl from Task 5 Step 5, copy the returned `url`.
2. Open that URL in a browser, pay with test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
3. Stripe redirects to `http://127.0.0.1:8787/picks?session_id=cs_test_...` — copy the `session_id` from the address bar (this 404s in the browser right now since the frontend doesn't handle it yet — that's expected, you just need the id from the URL).
4. Run: `curl -s "http://127.0.0.1:8787/api/checkout/confirm?session_id=<that id>&buyer_token=test-buyer-1"`
   Expected: `{"unlocked_pick_ids":[<the pick id you bought>]}`.
5. Run: `curl -s "http://127.0.0.1:8787/api/picks/today?buyer_token=test-buyer-1" | grep -o '"id":<that id>[^}]*'`
   Expected: that pick now shows `"locked":false` and includes `pick_text`.
6. Run the same confirm curl from step 4 again.
   Expected: same `{"unlocked_pick_ids":[...]}` response, and `npx wrangler d1 execute sharpflow-db --local --command "SELECT COUNT(*) FROM pick_unlocks;"` shows the count didn't increase (idempotency).

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "Add checkout confirmation endpoint that records unlocks"
```

---

### Task 7: Remove `is_premium` from the Worker

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- No new interfaces — this removes dead code paths per the spec's "Removed in this change" section.

- [ ] **Step 1: Simplify `handleGetMe`**

Replace the `handleGetMe` function in `worker/index.js`:

```js
async function handleGetMe(request, env) {
  const supabaseUser = await getSupabaseUser(request, env);
  if (!supabaseUser) return json({ error: 'Unauthorized' }, 401);

  await upsertUser(env.DB, { id: supabaseUser.id, email: supabaseUser.email });
  const user = await getUserById(env.DB, supabaseUser.id);
  return json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
}
```

(Same function, just explicitly shaping the response to drop `is_premium` rather than spreading the raw row — keeps `getUserById`'s SELECT unchanged since nothing else needs it touched.)

- [ ] **Step 2: Restart wrangler dev and verify**

Run: `curl -s http://127.0.0.1:8787/api/user/me -H "Authorization: Bearer invalid"` (no valid session in this environment — this just confirms the endpoint still 401s cleanly, not the happy path)
Expected: `{"error":"Unauthorized"}`.

Confirm by reading the file that `is_premium` no longer appears in `handleGetMe`'s response shape (it's fine that `getUserById`'s SQL still selects the column — Task 7 only removes it from the API response per the Global Constraints note about not migrating the column away).

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "Drop is_premium from the /api/user/me response"
```

---

### Task 8: Frontend buyer token + API client

**Files:**
- Create: `src/lib/buyerToken.js`
- Modify: `src/lib/api.js`

**Interfaces:**
- Produces: `getBuyerToken()` (from `buyerToken.js`) → string, persisted in `localStorage`.
- Produces (in `api.js`): `getTodaysPicks(buyerToken)` (changed signature), `checkoutPick(pickId, buyerToken)`, `checkoutBundle(pickIds, buyerToken)`, `confirmCheckout(sessionId, buyerToken)`.
- Consumed by: Task 9 (`PickCard.jsx`) and Task 10 (`Picks.jsx`).

- [ ] **Step 1: Write `buyerToken.js`**

```js
const STORAGE_KEY = 'sharp_buyer_token';

export function getBuyerToken() {
  let token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, token);
  }
  return token;
}
```

- [ ] **Step 2: Update `src/lib/api.js`**

Replace the `getTodaysPicks` export (currently `src/lib/api.js:21-24`):

```js
export async function getTodaysPicks(buyerToken) {
  const headers = await authHeaders();
  const query = buyerToken ? `?buyer_token=${encodeURIComponent(buyerToken)}` : '';
  return request(`/picks/today${query}`, { headers });
}
```

Add these three new exports after `listAllPicks`:

```js
export async function checkoutPick(pickId, buyerToken) {
  return request('/checkout/pick', {
    method: 'POST',
    body: JSON.stringify({ pick_id: pickId, buyer_token: buyerToken }),
  });
}

export async function checkoutBundle(pickIds, buyerToken) {
  return request('/checkout/bundle', {
    method: 'POST',
    body: JSON.stringify({ pick_ids: pickIds, buyer_token: buyerToken }),
  });
}

export async function confirmCheckout(sessionId, buyerToken) {
  return request(
    `/checkout/confirm?session_id=${encodeURIComponent(sessionId)}&buyer_token=${encodeURIComponent(buyerToken)}`
  );
}
```

- [ ] **Step 3: Verify the build still compiles**

Run: `npm run build`
Expected: succeeds with no errors (this is a syntax/import check — the new functions aren't called from any component until Tasks 9-10, so this just confirms `api.js` and `buyerToken.js` are valid JS with no typos).

- [ ] **Step 4: Commit**

```bash
git add src/lib/buyerToken.js src/lib/api.js
git commit -m "Add buyer token and checkout API client functions"
```

---

### Task 9: `PickCard.jsx` lock/unlock UI

**Files:**
- Modify: `src/components/PickCard.jsx`

**Interfaces:**
- Consumes: `checkoutPick` from `src/lib/api.js` (Task 8).
- Produces: `PickCard` now takes an additional `buyerToken` prop (in addition to the existing `pick` prop).

- [ ] **Step 1: Rewrite the component**

Replace the full contents of `src/components/PickCard.jsx`:

```jsx
import { checkoutPick } from '../lib/api.js';

const TYPE_LABELS = {
  spread: 'Spread',
  moneyline: 'Moneyline',
  prop: 'Prop',
  over_under: 'Over/Under',
};

const CONFIDENCE_STYLES = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-slate-100 text-slate-600',
};

const DK_LINK = 'https://ak.draftkings.com';

export default function PickCard({ pick, buyerToken }) {
  const winRate = pick.win_rate ?? 55;

  const handleUnlock = async () => {
    try {
      const { url } = await checkoutPick(pick.id, buyerToken);
      window.location.href = url;
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sharp-100 text-sm font-semibold text-sharp-700">
            {pick.author.replace('@', '').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-slate-900">{pick.author}</p>
            <p className="text-xs text-slate-500">{winRate}% win rate</p>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${CONFIDENCE_STYLES[pick.confidence] || CONFIDENCE_STYLES.medium}`}
        >
          {pick.confidence} confidence
        </span>
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sharp-50 px-2 py-0.5 text-xs font-semibold uppercase text-sharp-700">
            {TYPE_LABELS[pick.pick_type] || pick.pick_type}
          </span>
        </div>

        {pick.locked ? (
          <p className="mt-2 text-lg font-bold text-slate-400 blur-sm select-none">Locked pick</p>
        ) : (
          <p className="mt-2 text-lg font-bold text-slate-900">{pick.pick_text}</p>
        )}
        <p className="mt-1 text-sm text-slate-500">
          {pick.game} · {pick.game_time}
        </p>
      </div>

      {pick.locked ? (
        <button
          onClick={handleUnlock}
          className="mt-4 inline-flex items-center justify-center rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sharp-700"
        >
          Unlock for ${(pick.price_cents / 100).toFixed(2)}
        </button>
      ) : (
        <a
          href={pick.affiliate_link || DK_LINK}
          target="_blank"
          rel="noopener noreferrer sponsored"
          className="mt-4 inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Bet on DraftKings
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: succeeds. Full visual/interaction verification happens in Task 10 once `Picks.jsx` passes `buyerToken` in.

- [ ] **Step 3: Commit**

```bash
git add src/components/PickCard.jsx
git commit -m "Render locked picks as a paywall with an unlock button"
```

---

### Task 10: `Picks.jsx` — bundle CTA, Stripe return handling, cleanup

**Files:**
- Modify: `src/pages/Picks.jsx`
- Modify: `src/App.jsx`
- Delete: `src/components/SubscriptionModal.jsx`

**Interfaces:**
- Consumes: `getBuyerToken` (Task 8), `getTodaysPicks`/`checkoutBundle`/`confirmCheckout` (Task 8), `PickCard` with its new `buyerToken` prop (Task 9).

- [ ] **Step 1: Delete the subscription modal**

```bash
git rm src/components/SubscriptionModal.jsx
```

- [ ] **Step 2: Rewrite `Picks.jsx`**

Replace the full contents of `src/pages/Picks.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PickCard from '../components/PickCard.jsx';
import { getBuyerToken } from '../lib/buyerToken.js';
import { getTodaysPicks, checkoutBundle, confirmCheckout } from '../lib/api.js';

export default function Picks() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const buyerToken = getBuyerToken();

  const loadPicks = () => {
    setLoading(true);
    getTodaysPicks(buyerToken)
      .then((data) => setPicks(data.picks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    if (sessionId) {
      confirmCheckout(sessionId, buyerToken)
        .catch((err) => setError(err.message))
        .finally(() => {
          setSearchParams({}, { replace: true });
          loadPicks();
        });
    } else {
      loadPicks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockedPicks = picks.filter((p) => p.locked);
  const bundleTotalCents = lockedPicks.reduce((sum, p) => sum + Math.round(p.price_cents * 0.8), 0);

  const handleUnlockAll = async () => {
    try {
      const { url } = await checkoutBundle(lockedPicks.map((p) => p.id), buyerToken);
      window.location.href = url;
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Today's Picks</h1>
      <p className="mt-1 text-sm text-slate-500">Curated from the sharpest NFL accounts on X.</p>
      <p className="mt-1 text-xs text-slate-400">
        Unlocks are tied to this browser — they won't follow you to another device.
      </p>

      {lockedPicks.length >= 2 && (
        <div className="mt-6 rounded-md border border-sharp-200 bg-sharp-50 p-4 text-sm text-sharp-900">
          <button onClick={handleUnlockAll} className="font-semibold text-sharp-700 underline">
            Unlock all {lockedPicks.length} picks for ${(bundleTotalCents / 100).toFixed(2)}
          </button>
        </div>
      )}

      {loading && <p className="mt-8 text-sm text-slate-500">Loading picks...</p>}
      {error && <p className="mt-8 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-4">
        {picks.map((pick) => (
          <PickCard key={pick.id} pick={pick} buyerToken={buyerToken} />
        ))}
        {!loading && !error && picks.length === 0 && (
          <p className="text-sm text-slate-500">No picks yet — check back soon.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update `App.jsx`'s usage**

`src/App.jsx` currently renders `<Route path="/picks" element={<Picks session={session} />} />` — `Picks` no longer takes a `session` prop (it never used it for anything the paywall needs). Change that line to:

```jsx
<Route path="/picks" element={<Picks />} />
```

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`
Expected: succeeds with no errors, no warnings about unused `SubscriptionModal` import anywhere (confirms the deletion didn't leave a dangling import).

- [ ] **Step 5: Full local browser verification**

Run `npx wrangler dev --local --port 8787` and `npm run dev` (Vite proxies `/api` to the Worker per `vite.config.js`). In a browser at `http://localhost:5173/picks`:

1. Confirm one pick shows real text with a DraftKings link, and the rest show "Locked pick" (blurred) with an "Unlock for $X.XX" button matching their confidence tier's price.
2. Confirm the "Unlock all N picks for $Y.YY" banner appears and its total equals the sum of each locked pick's price at 20% off.
3. Click "Unlock for $X.XX" on one locked pick, pay with Stripe test card `4242 4242 4242 4242`, confirm it redirects back to `/picks` and that specific pick now shows real text.
4. Reload the page (same browser) — confirm the unlocked pick stays unlocked (buyer token persisted).
5. Click "Unlock all" on the remaining locked picks, pay, confirm everything unlocks.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Picks.jsx src/App.jsx
git commit -m "Wire bundle unlock CTA and Stripe return handling into Picks page"
```

---

### Task 11: Clean up `Dashboard.jsx` and `Landing.jsx`

**Files:**
- Modify: `src/pages/Dashboard.jsx`
- Modify: `src/pages/Landing.jsx`

**Interfaces:** None — pure UI cleanup, no new interfaces.

- [ ] **Step 1: Simplify `Dashboard.jsx`**

Replace the full contents of `src/pages/Dashboard.jsx`:

```jsx
import { Navigate } from 'react-router-dom';

export default function Dashboard({ session }) {
  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-500">Email</p>
        <p className="text-base font-medium text-slate-900">{session.user.email}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the pricing section of `Landing.jsx`**

Replace the `<section>` block containing "Simple pricing" (currently `src/pages/Landing.jsx:45-68`):

```jsx
      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-slate-900">Simple pricing</h2>
        <div className="mx-auto mt-8 max-w-md rounded-lg border-2 border-sharp-600 bg-white p-6 text-center">
          <p className="text-3xl font-bold text-slate-900">$1.99 – $4.99</p>
          <p className="mt-1 text-sm text-slate-500">per pick, priced by confidence</p>
          <ul className="mt-4 space-y-2 text-sm text-slate-600">
            <li>One free pick every day</li>
            <li>Pay only for the picks you want</li>
            <li>Unlock all of today's picks together at a discount</li>
          </ul>
        </div>
      </section>
```

- [ ] **Step 3: Verify the build compiles and check both pages visually**

Run: `npm run build`
Expected: succeeds.

Run `npm run dev`, visit `http://localhost:5173/` and confirm the pricing section shows the new per-pick copy with no mention of "$14.99/mo" or "Premium" anywhere. Visit `/dashboard` while logged in (from earlier signup testing) and confirm it shows only the email, no subscription status block.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Dashboard.jsx src/pages/Landing.jsx
git commit -m "Remove subscription copy from Landing and Dashboard pages"
```

---

### Task 12: Deploy and verify live

**Files:** None (deployment step).

- [ ] **Step 1: Add the Stripe secret to the Cloudflare dashboard**

In the Cloudflare dashboard, on the `picksharp` Worker: **Settings → Variables and Secrets → Add secret**, name `STRIPE_SECRET_KEY`, value = your Stripe **test-mode** secret key (same one used locally in `.dev.vars`). This is separate from the "Build variables" section used for `VITE_*` values — this one is a runtime secret.

- [ ] **Step 2: Push to trigger a deploy**

```bash
git push origin main
```

- [ ] **Step 3: Poll for the new deploy**

Run:
```bash
for i in 1 2 3 4 5 6; do
  sleep 20
  curl -s https://picksharp.zohnwheeler.workers.dev/ | grep -o 'assets/index-[^"]*\.js'
done
```
Expected: the hash changes partway through, confirming the new build landed (compare against whatever hash `npm run build` produced most recently before this push).

- [ ] **Step 4: Re-run the D1 migration against production, carefully**

The new `pick_unlocks` table exists locally but not yet in the production D1 database — `wrangler deploy` does not run `schema.sql`, and `schema.sql`'s last statement is a plain `INSERT INTO picks (...)` (not `OR IGNORE`), which would insert 5 duplicate seed rows if run against the already-seeded production database.

Run this instead, which executes only the new DDL (table + index), not the full file:
```bash
npx wrangler d1 execute sharpflow-db --remote --command "
CREATE TABLE IF NOT EXISTS pick_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_token TEXT NOT NULL,
  pick_id INTEGER NOT NULL,
  stripe_session_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pick_id) REFERENCES picks(id),
  UNIQUE (stripe_session_id, pick_id)
);
CREATE INDEX IF NOT EXISTS idx_pick_unlocks_buyer ON pick_unlocks(buyer_token);
"
```
Expected: successful execution, 2 commands run.

Verify: `npx wrangler d1 execute sharpflow-db --remote --command "SELECT COUNT(*) FROM picks;"` still shows 5 (confirms no duplicate seeding happened).

- [ ] **Step 5: Full live verification**

Repeat Task 10 Step 5's browser walkthrough against `https://picksharp.zohnwheeler.workers.dev/picks` instead of localhost — confirm the whole locked → pay with Stripe test card → unlock → persists-on-reload flow works in production.

- [ ] **Step 6: No commit needed**

This task is deployment and data verification, not a code change.
