# Pay-per-pick paywall — design spec

Status: approved by user 2026-09-16, ready for implementation planning.

## Context

PickSharp's long-term vision is a fully automated growth loop: a bot posts
to an X account teasing a pick, drives traffic to the picks page, visitors
pay to see the pick, repeat. This spec covers **only the payment/paywall
half** of that loop (the X bot is a separate, later spec). It replaces the
MVP's current "$14.99/mo unlocks 7+ days of history" model, which has no
real payment processing behind it, with real Stripe-backed per-pick
purchases.

## Goals

- A visitor can pay to unlock a single locked pick's text via Stripe
  Checkout, with no PickSharp account required (guest checkout).
- A visitor can pay once to unlock every currently-locked pick for the day
  at a discount ("unlock all" bundle).
- One pick per day (the lowest-confidence one) stays free as a taste.
- Price is derived from a pick's `confidence` field, not stored per-pick.
- Previously-shipped subscription/`is_premium` gating is removed rather
  than left running alongside the new model.

## Non-goals (explicitly out of scope for this spec)

- The X bot / posting automation (separate spec, separate build).
- Login-gated purchases, purchase history, or cross-device access to
  unlocked picks. Unlocks are tied to an anonymous browser token.
- Stripe webhooks. Unlock confirmation happens synchronously when the
  browser returns from Stripe Checkout (see "Known limitation" below).
- Refunds, disputes, or admin tooling for either of those.
- Recurring/subscription billing of any kind.

## Data model changes (`worker/schema.sql`)

Add one table:

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

CREATE INDEX IF NOT EXISTS idx_pick_unlocks_buyer ON pick_unlocks(buyer_token);
```

The uniqueness is on the **pair** `(stripe_session_id, pick_id)`, not on
`stripe_session_id` alone — a bundle purchase inserts one row per pick
under the same session id, so a column-level UNIQUE on the session id
alone would only allow the first pick in a bundle to ever be recorded.
The pair constraint is what makes confirm-on-return idempotent: a second
confirm call for the same session re-attempts the same
`(session_id, pick_id)` pairs and each one is silently ignored via
`INSERT OR IGNORE`.

No `price` column is added to `picks`. Price is computed in Worker code
from `confidence`:

```js
const PRICE_CENTS = { low: 199, medium: 299, high: 499 };
```

If pricing needs to change later, it changes in one place and only
affects picks purchased after the change — historical `pick_unlocks` rows
aren't affected either way since they don't store price.

## Removed in this change

- `users.is_premium` column and every code path that reads/writes it:
  - `worker/index.js`: the premium check in `handleGetPicksToday`
    (the `sinceDays: 7` branching) and the `is_premium` field in
    `handleGetMe`'s response.
  - `src/pages/Dashboard.jsx`: the "Subscription status" / "Upgrade to
    Premium" block.
  - `src/components/SubscriptionModal.jsx`: deleted entirely.
  - `src/pages/Picks.jsx`: the free-tier upgrade banner that opens
    `SubscriptionModal`.
- Landing page pricing section (`src/pages/Landing.jsx`): replace the
  Free/$14.99 two-column pricing table with per-pick pricing copy
  (e.g. "$1.99–$4.99 per pick, one free pick daily").

`worker/schema.sql`'s existing seed data and `users`/`events` tables are
unaffected — `users` stays (Supabase auth signup/login/dashboard identity
still exists independently of the paywall), only the `is_premium` column
and its consumers go.

## API changes (`worker/index.js`, `worker/db.js`)

### `GET /api/picks/today` (changed)

- No longer checks `is_premium` or applies the old 7-day free-tier
  window. Instead, filters to picks created today —
  `WHERE date(created_at) = date('now')` — matching the endpoint's own
  name. (The schema has no real date column; `game_time` is free text
  like "Sept 15 1:00 PM" entered by the admin, so `created_at`'s date is
  the only reliable "today" signal.) Sorted newest first.
- For each pick, the server decides `locked: true/false`:
  - `false` if it's today's designated free pick (lowest confidence
    among today's picks — ties broken by earliest `created_at`), or if
    `pick_unlocks` has a row for `(buyer_token, pick.id)`.
  - `true` otherwise.
- Response shape per pick:
  - If unlocked: same fields as today (`pick_text`, `affiliate_link`
    included).
  - If locked: `pick_text` and `affiliate_link` are **omitted from the
    JSON entirely** (not just hidden client-side) — the server must
    never send locked pick text to the client. Instead include
    `price_cents` (from the confidence mapping) so the UI can render
    "Unlock for $X".
- Takes `buyer_token` as a query param (optional — if absent, every
  non-free pick is locked).

### `POST /api/checkout/pick` (new)

- Body: `{ pick_id, buyer_token }`.
- Look up the pick, compute its price from `confidence`. 400 if the pick
  doesn't exist or is the free pick of the day (nothing to buy).
- Create a Stripe Checkout Session (`mode: "payment"`, one line item,
  `metadata: { buyer_token, pick_ids: String(pick_id) }`,
  `success_url` = `<origin>/picks?session_id={CHECKOUT_SESSION_ID}`,
  `cancel_url` = `<origin>/picks`).
- Response: `{ url }` — the frontend does `window.location = url`.

### `POST /api/checkout/bundle` (new)

- Body: `{ pick_ids: [...], buyer_token }` — the client sends exactly the
  set of pick IDs it currently sees as locked.
- Server re-derives each price from confidence (never trusts a client-sent
  price), applies a flat 20% discount to each pick's price individually
  (rounded to the nearest cent), and creates a single Stripe Checkout
  Session with one line item per pick at its discounted price. Discount
  is applied to each line item's `unit_amount` directly rather than via
  a Stripe `coupon`/`discounts` param, so there's no separate Coupon
  object to create/manage in the Stripe dashboard — the discount is
  self-contained in Worker code and the receipt still itemizes each pick
  (just at its already-discounted price).
- `metadata: { buyer_token, pick_ids: pick_ids.join(',') }`.
- Same success/cancel URL shape as above.
- 400 if `pick_ids` is empty or any id doesn't exist / is the free pick.

### `GET /api/checkout/confirm` (new)

- Query params: `session_id`, `buyer_token`.
- Retrieves the Checkout Session from Stripe's API
  (`GET /v1/checkout/sessions/:id`, using `STRIPE_SECRET_KEY`).
- 402 if `payment_status !== 'paid'`.
- 400 if the session's `metadata.buyer_token` doesn't match the
  `buyer_token` query param (prevents one browser from redeeming a
  session it didn't create, e.g. a shared/leaked success URL).
- On success: for each id in `metadata.pick_ids.split(',')`, insert a row
  into `pick_unlocks` via `INSERT OR IGNORE`, relying on the
  `(stripe_session_id, pick_id)` UNIQUE constraint so calling this
  endpoint twice for the same session re-inserts nothing the second time.
- Response: `{ unlocked_pick_ids: [...] }`.

### Removed

- `handleGetMe`'s `is_premium` field (see "Removed" section above) — the
  endpoint still returns `{ user: { id, email, created_at } }`.

## Frontend changes

### `src/lib/buyerToken.js` (new)

- `getBuyerToken()`: reads `localStorage.getItem('sharp_buyer_token')`;
  if absent, generates one via `crypto.randomUUID()`, stores it, returns
  it. Called once per page load wherever picks are fetched or purchased.

### `src/components/PickCard.jsx` (changed)

- If `pick.locked`, render a masked state instead of `pick_text`: a
  lock icon/blurred placeholder, the confidence badge (still shown —
  it's part of the tease), and an "Unlock for $X.XX" button instead of
  the DraftKings link. Clicking it calls the single-pick checkout
  endpoint and redirects.
- If unlocked, renders exactly as today (pick text + DK link).

### `src/pages/Picks.jsx` (changed)

- Reads/generates the buyer token, passes it as a query param to
  `getTodaysPicks()`.
- If there are 2+ locked picks, shows an "Unlock all N picks for $Y.YY"
  bundle button above the feed (total after 20% discount, computed
  client-side from the locked picks' confidence for display — server
  recomputes authoritatively at checkout time).
- On mount, checks `?session_id=` in the URL; if present, calls the
  confirm endpoint, then strips the query param and refetches picks.
- Removes the old `!session && upgrade banner` block and the
  `SubscriptionModal` import/usage.
- Adds a small persistent note near the feed: "Unlocks are tied to this
  browser — they won't follow you to another device."

### `src/pages/Dashboard.jsx` (changed)

- Removes the subscription-status block and "Upgrade to Premium" button
  (nothing left to show there beyond email, until this page gets a
  reason to exist again — e.g. a future "my unlocked picks" list, which
  is out of scope here).

### `src/pages/Landing.jsx` (changed)

- Pricing section rewritten: one card ("Pay per pick — $1.99 to $4.99
  depending on confidence, one free pick every day") instead of the
  Free/Premium two-column table.

### `src/components/SubscriptionModal.jsx`

- Deleted.

## Worker config changes (`wrangler.toml`, secrets)

- New secret: `STRIPE_SECRET_KEY` (test mode key to start), set via the
  Cloudflare dashboard's Variables and Secrets (same place `ADMIN_SECRET`
  already lives) — not committed, not put in `[vars]` since it's a
  genuine secret.
- No new `[vars]` entries and no webhook secret (see Non-goals).

## Error handling

- Stripe Checkout Session creation failure (network/API error): the
  checkout endpoints return 502 with `{ error }`; frontend shows an
  inline error instead of redirecting.
- `confirm` called with an invalid/expired/unpaid session: 402, frontend
  shows "payment not confirmed" and leaves picks locked — user can retry
  the confirm call (e.g. via a "having trouble? tap here" retry action)
  since it's idempotent and safe to repeat.
- `confirm` called with a `buyer_token` that doesn't match the session's:
  400, treated the same as an invalid session client-side.
- Bundle checkout where the set of locked picks changed between page
  load and click (e.g. another purchase happened in another tab): the
  server re-validates each pick id still exists and isn't the free pick;
  any that no longer qualify are dropped from the line items rather than
  failing the whole request.

## Known limitation (accepted for this spec)

No webhook means a purchase where the browser never returns to
`success_url` (tab closed mid-redirect, network drop) is paid for in
Stripe but never recorded in `pick_unlocks`. This is a real but rare gap;
fixing it means adding a Stripe webhook endpoint + signing secret, which
is deliberately deferred to keep this build's Stripe setup to a single
secret key. Revisit if lost purchases become a real support burden.

Guest-only unlocks also mean clearing browser storage or switching
devices loses access to previously purchased picks — called out on the
page itself per the frontend changes above.

## Testing plan

Same approach used for the rest of the MVP: verify against Stripe **test
mode** end-to-end in a browser (test card `4242 4242 4242 4242`) rather
than unit-testing Stripe's API shape —
1. Load `/picks`, confirm exactly one pick is free/visible and the rest
   show price + "Unlock" buttons with no `pick_text` present in the raw
   API response (checked via network tab / curl, not just the UI).
2. Unlock a single pick, confirm it reveals after the Stripe redirect
   and stays revealed on reload (buyer token persists in localStorage).
3. Unlock the bundle, confirm all remaining locked picks reveal and the
   charged amount matches the 20%-off sum.
4. Re-visit `/picks?session_id=<already-confirmed-id>` manually, confirm
   it doesn't double-insert into `pick_unlocks` (idempotency).
5. Confirm the Landing page and Dashboard no longer reference the old
   subscription model anywhere.
