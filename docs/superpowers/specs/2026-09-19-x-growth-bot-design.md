# X Growth Bot — Design Spec

## Purpose

PickSharp currently has no distribution channel — picks get added via the admin panel and sit behind the paywall with no way for new visitors to discover them. This adds an automated posting bot on X (the existing `@WePickSharp` account, 26 followers, being repurposed for this) that announces each day's free pick with a link back to `/picks`, to drive top-of-funnel traffic into the paywall.

**Explicitly out of scope for this spec** (raised and deliberately deferred during design):
- **Sourcing picks from other X accounts.** A separate, independent subsystem (needs read access, content-parsing judgment, likely human review before insertion). Picks continue to be entered manually via the existing admin panel.
- **Results-tracking / pick grading.** No win/loss outcome tracking exists in this app (`picker_stats.win_rate` is a static seeded value). "Yesterday we went 4-1" style recap tweets are not possible without building that separately.
- **AI-generated tweet copy.** Content is template-based, not LLM-generated — deliberate choice for predictability and zero added API cost/failure surface.
- **Media attachments** (e.g. the logo) on tweets. The new `logo.png` is for the X account's profile picture only, set manually by the account owner — no code needed.
- **Reply/mention engagement automation.** The design leaves room to add this later (the X API tier chosen supports read access), but nothing here reads mentions or auto-replies.

## Architecture

### Trigger: cron-polled quiet period

A new Cloudflare Cron Trigger (free tier, no plan upgrade needed) runs every 5 minutes. On each tick, it:

1. Finds today's picks (reusing `getTodaysPicksRaw` from `worker/db.js`).
2. If there are no picks yet, or today has already been posted (see `daily_posts` below), does nothing.
3. Otherwise, checks whether the newest pick's `created_at` is at least 15 minutes old. If someone is still actively adding picks (something inserted more recently than that), it waits and checks again next tick.
4. If the quiet period has elapsed, computes the free pick via the existing `freePickId()` logic (using the full current set of today's picks — this must run *after* all of today's picks exist, which the quiet-period check ensures), composes the tweet, posts it, and records the post.

This requires no change to the admin panel's existing pick-entry workflow — the admin adds picks exactly as today; the bot notices once things go quiet.

**New table** (`worker/schema.sql`):
```sql
CREATE TABLE IF NOT EXISTS daily_posts (
  date TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL
);
```
`date` is the picks' date (`date('now')` at post time), used as the idempotency key — a row's presence means that day is done, regardless of whether more picks get added afterward. Posting again for the same day requires manually deleting that row (no UI for this in V1; a deliberate non-feature, since re-posting the same day isn't a use case being designed for now).

### Tweet content

New pure function in `worker/tweetCopy.js`:

```js
export function composeTweet(pick, siteUrl) {
  // Template: 🔒 Today's FREE pick from {author}: {pick_text} ({game})
  //           Unlock the rest of today's sharpest NFL picks 👉 {siteUrl}/picks?ref=x_bot #NFL
  // Truncates pick_text with an ellipsis if the composed tweet would exceed
  // X's 280-character limit, leaving room for the fixed template/link/hashtag.
}
```

Example output:
> 🔒 Today's FREE pick from AlphaBets: Take the over (Team A vs Team B)
> Unlock the rest of today's sharpest NFL picks 👉 https://wepicksharp.com/picks?ref=x_bot #NFL

`siteUrl` comes from a new `PUBLIC_SITE_URL` var in `wrangler.toml`'s `[vars]` (currently `https://wepicksharp.com`, now that the custom domain is connected). This must be an explicit config value rather than derived from the incoming request's origin (the pattern used elsewhere in this codebase for Stripe's `successUrl`/`cancelUrl`), because a Cron Trigger invocation has no incoming HTTP request to derive an origin from.

### X API integration

New module `worker/x.js`, following the existing `worker/stripe.js` pattern (raw `fetch`, no SDK):

- `postTweet(env, text)` — sends `POST https://api.x.com/2/tweets` with OAuth 1.0a user-context signing, returns the created tweet's ID.

OAuth 1.0a requires computing an HMAC-SHA1 request signature per call (sort parameters, build the signature base string, sign with the app's and user's secrets). Workers don't have Node's `crypto` module; this uses the Web Crypto API (`crypto.subtle.importKey` / `sign` with `HMAC`/`SHA-1`), which is fully supported in the Workers runtime.

**Credentials** (4 values, generated once via the X Developer Portal's "Keys and tokens" tab, tied to `@WePickSharp` with Read+Write permissions — already obtained and in place):
- `X_API_KEY` (Consumer Key)
- `X_API_KEY_SECRET` (Consumer Secret)
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

These are static (OAuth 1.0a tokens don't expire), so there is no refresh-token logic to write or maintain — the Worker stays fully stateless with respect to X auth, same as it is for Stripe. They live in `.dev.vars` locally (already added) and Cloudflare's Variables and Secrets in production (not yet added — a deploy step, see below).

**Cost**: X's API moved to pay-per-use pricing as of February 2026 — $0.015 per tweet, $0.20 per tweet containing a link (every tweet this bot posts contains one). At one post/day, this is roughly **$6/month**. Credits are prepaid in the X Developer Console; the account already has a funded balance as of this writing.

### Attribution tracking

New table:
```sql
CREATE TABLE IF NOT EXISTS buyer_sources (
  buyer_token TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
```

New endpoint `POST /api/track-source` — the frontend calls this when `/picks` loads with a `?ref=` query param present, sending `{ buyer_token, source }`. The handler does `INSERT OR IGNORE INTO buyer_sources (buyer_token, source) VALUES (?, ?)` — first-touch attribution, so a buyer's original source is preserved even if they return later without the `ref` param.

To see revenue by source (a manual query for now, no dashboard):
```sql
SELECT bs.source, COUNT(*) AS unlocks
FROM pick_unlocks pu
JOIN buyer_sources bs ON bs.buyer_token = pu.buyer_token
GROUP BY bs.source;
```

### Error handling

- **Idempotency**: covered above via `daily_posts` — checked before posting, written immediately after a successful post.
- **Failures**: if `postTweet` throws (rate limit, network issue, exhausted credit balance, bad credentials), the cron tick logs the error and does nothing further; no `daily_posts` row gets written, so the next tick (5 minutes later) retries automatically. This is bounded by the day itself — once the date rolls over, a persistently-failing day simply stops mattering rather than retrying forever. There is no alerting system in this app; a sustained failure is only visible via Cloudflare's logs (`wrangler tail` or the dashboard), not a push notification.

### Testing strategy

X's API has no test/sandbox mode — every call posts a real, live tweet. For local development, the real `@WePickSharp` account should be temporarily set to **Protected** (X Settings → Privacy and safety → Audience and tagging) while testing, so test posts aren't publicly visible, then switched back to public before going live. This avoids needing a second X Developer Project (which would mean a second paid credit balance).

Manual verification (no test runner exists in this repo, consistent with the rest of the codebase): `wrangler dev --local`, insert test picks via the admin panel, temporarily shrink the 15-minute quiet period for faster iteration, and confirm a real tweet lands on the protected account with correct content, a working link, and that `daily_posts` prevents a second post on retry.

## Deployment prerequisites (not yet done)

- Add `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` as production secrets on the `picksharp` Worker (Cloudflare dashboard or `wrangler secret put`, same pattern as `STRIPE_SECRET_KEY`).
- Add `PUBLIC_SITE_URL = "https://wepicksharp.com"` to `wrangler.toml`'s `[vars]` (safe to commit, not a secret).
- Add the `[triggers]` cron config to `wrangler.toml` (`crons = ["*/5 * * * *"]`).

## Already completed as part of this design process

- `wepicksharp.com` connected as a custom domain on the `picksharp` Worker (additive alongside the existing `workers.dev` URL).
- X Developer App created (`@WePickSharp`, Read+Write, OAuth 1.0a), credentials generated and stored in `.env`/`.dev.vars`.
- X API credit balance funded.
