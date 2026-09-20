# Real Pick Aggregation — Design Spec

## Relationship to prior specs

This spec **replaces** `docs/superpowers/specs/2026-09-19-ai-pick-generation-design.md` in full — not an extension of it, a different mechanism entirely. That spec (and its architecture-pivot addendum) covered generating fictional pick content and attributing it to 5 fixed personas. This spec covers the opposite: **never generating pick content**, only aggregating and attributing picks that one of those 5 accounts genuinely, verifiably posted.

Full rationale for the pivot: `.superpowers/sdd/2026-09-19-ai-pick-generation/progress.md`, section "Feature: game staleness + post-slot grounding verification (2026-09-19)", final paragraph.

## Purpose

The site's 5 fixed personas (`@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`) are real, active, identifiable X accounts belonging to real people/businesses (e.g. `@jasonrmcintyre` is Jason McIntyre, a FOX Sports personality; `@SharpFootball` is Warren Sharp). The previous pipeline auto-generated fictional pick content and attributed it to these real handles — a false-endorsement/impersonation risk, already live in production via seed data.

This design replaces that entirely: a scheduled routine monitors these 5 accounts' actual recent posts, identifies which look like genuine betting picks, extracts structured data from their real text, and submits it with a link back to the source tweet. A Worker-side verification step independently re-fetches the specific tweet and confirms both authorship and content before the pick is ever shown on the site or tweeted about — mirroring the existing odds-grounding-check pattern already shipped in `handlePostSlot`.

**Explicitly out of scope / deliberately decided against:**
- **No new persona discovery.** Still exactly these 5 tracked accounts; adding more is a future decision, not part of this work.
- **No sentiment/tone-based confidence.** Real accounts don't self-label conviction the way the old fabricated pipeline did, and reading tone into a real person's tweet to price a product is its own risk. Confidence/price tier is derived from real market odds instead (see below), not language.
- **No fully automated re-tweeting of arbitrary account content.** Only tweets that read as genuine picks (a game + a bet type) are candidates; general commentary, replies, and retweets are skipped by the routine's own judgment.
- **`POSTING_PAUSED` is not lifted by this work.** The global kill switch (`worker/index.js` `handleDailyPostCheck`/`handlePostSlot`) stays enabled regardless of this pipeline's readiness. Resuming live posting is a separate, explicit decision.

## Architecture

### Schema changes

```sql
ALTER TABLE picks ADD COLUMN source_tweet_url TEXT;
ALTER TABLE picks ADD COLUMN source_tweet_id TEXT;
ALTER TABLE picks ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ingested_tweets (
  tweet_id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`schema.sql`'s fabricated seed block (`INSERT INTO picks (...) VALUES ('@CodyBrownBets', 'Kansas City -5.5', ...)`, 4 rows) is deleted — fresh installs no longer seed fake content under real handles. `picker_stats`' seed (author names + a default 55.0 win rate) is unrelated and stays; it's a generic display stat, not a specific fabricated claim.

**Production cleanup**: the 4 fabricated rows currently live in production (confirmed via direct query: ids 1, 3, 4, 5, all `slot IS NULL`, all lacking any source attribution) get deleted as a one-time migration step, not left in place.

### Visibility gate

Any pick with a `source_tweet_id` starts `verified = 0` and is **excluded** from `/api/picks/today` until the verification step (below) confirms it and sets `verified = 1`. This is stricter than the existing odds-grounding check, which only gates the *tweet*, not display — necessary here because showing fabricated-looking content under a real person's name, even briefly, is the exact harm this pipeline exists to prevent. Manual admin entries (no `source_tweet_id`) are unaffected — they display immediately as they do today, unchanged.

`getTodaysPicksRaw` (`worker/db.js`) gets a `WHERE verified = 1 OR source_tweet_id IS NULL` clause added to its query.

### Discovery (routine)

Same 3-slot schedule as today (`morning`/`midday`/`evening`, cron `0 13/17/22 * * 4,6,0`, Thu/Sat/Sun). Each firing:

1. **Get last-seen state**: `GET /api/admin/last-seen-tweets` (new, admin-secret protected) returns `{ "@SharpFootball": "19812...", "@CodyBrownBets": null, ... }` — the most-recently-ingested `tweet_id` per tracked author, or `null` if never seen.
2. **Read each account's recent tweets**: `GET /2/users/:id/tweets` (X API v2, app-only Bearer Token auth) per account, using each account's numeric user ID (resolved once, hardcoded into the routine prompt — handles don't change) with `since_id` from step 1 (omitted on an account's first-ever run) and `max_results=10`.
3. **Identify genuine picks**: using its own reasoning, the routine judges which returned tweets read as an actual betting pick (mentions a game/team plus a spread, total, moneyline side, or player prop) versus commentary, replies, or retweets. Non-picks are skipped, not ingested.
4. **Extract structured data** per identified tweet: `pick_type`, `game` (exact full team names — see Verification below for why this must match the odds API's naming verbatim, no abbreviations), `game_time_utc` (exact ISO 8601 kickoff time), `pick_text` (the specific selection), `source_tweet_url`, `source_tweet_id`. The routine may consult The Odds API (already-existing credential) to resolve an informal team reference in a tweet to the exact matching name/kickoff time. **No `confidence` is extracted** — that's computed Worker-side from real market data (see Tiering below), not invented by the routine.
5. **Submit**: `POST /api/admin/picks` per extracted pick, with `author` = the real handle, `slot` = current slot, `source_tweet_url`/`source_tweet_id` included, and a placeholder `confidence: "medium"` (never shown — the pick is invisible until verification overwrites it).
6. **Trigger the slot**: `POST /api/admin/post-slot` as today, unchanged call shape.

### Verification + tiering (`handlePostSlot`, extended)

For each of the current slot's picks with `source_tweet_id` and `verified = 0`:

1. **Re-fetch the real tweet**: `GET /2/tweets/:id` (Bearer Token, `expansions=author_id`, `user.fields=username`) — independent of whatever the routine claimed.
   - A **404 or "tweet not found"** on an otherwise-working API call means this specific pick's claimed source doesn't check out — delete the pick (matches the existing odds-grounding pattern of discarding ungrounded picks).
   - A **general API failure** (can't reach X's API at all) is treated like the existing odds-fetch failure handling: log and skip the verification check for this run rather than block an otherwise-valid slot — a transient outage shouldn't indefinitely block posting.
2. **Verify authorship**: the re-fetched tweet's username must case-insensitively match `pick.author` (stripped of `@`).
3. **Verify content**: the re-fetched tweet's raw text, lowercased, must contain the pick's key selection detail (the spread number, total, or side named in `pick_text`) as a substring — the same exact-match strictness as the existing team-name grounding check, not fuzzy semantic comparison.
4. Picks failing either check are deleted, same as an ungrounded pick today.
5. Picks passing both: compute the real price tier (below) and `UPDATE picks SET verified = 1, confidence = ? WHERE id = ?`.

Only after this pass does the existing free-pick selection and tweet-posting logic run, now operating over picks that are both grounded (real game) and verified (real tweet, real author).

### Confidence/price tiering via market odds

`confidence` still drives price (`worker/pricing.js`: low $1.99 / medium $2.99 / high $4.99) and which pick is free each day (`freePickId`, lowest tier). Rather than inferring conviction from tweet language, it's computed from the same real odds data already being fetched for grounding:

- For `moneyline`/`spread` picks: locate the matched game's `h2h`/`spreads` market entry for the named side, convert the American odds price to implied win probability (`american >= 0 ? 100/(american+100) : -american/(-american+100)`), and bucket it (starting point: ≥60% → `high`, 45-60% → `medium`, <45% → `low` — exact cutoffs are a plan/implementation-time tuning detail, not fixed here).
- For `over_under`/`prop` picks, or any pick whose side can't be confidently matched to a specific odds-market line: default to `medium` — no natural favorite/underdog axis exists for these in the odds data, and a safe fallback beats guessing.

### Dedup

`ingested_tweets(tweet_id PK, author, ingested_at)` is written whenever `POST /api/admin/picks` receives a `source_tweet_id`, **regardless of the pick's later verification outcome** — once a tweet has been evaluated (passed or failed), it's never reprocessed. `GET /api/admin/last-seen-tweets` derives each account's `since_id` from its most-recent `ingested_tweets` row by `ingested_at`.

### Credentials

- New secret: `X_BEARER_TOKEN` (app-only auth, from the pay-per-use X developer account being set up) — used both by the Worker (verification re-fetch) and embedded in the routine's prompt (discovery reads), the same pattern as `ADMIN_SECRET`/`ODDS_API_KEY` today.
- Routine tool access unchanged: `Bash` only, no repo write access.
- The 3 existing routine prompts get rewritten to this discovery/extraction/submit flow, replacing their current pick-generation instructions.

### Cost

At the existing 3-slot/Thu-Sat-Sun cadence, ~10 tweets/account/check × 5 accounts × ~39 checks/month ≈ 1,950 reads/month ≈ **$9.75/month** at X's $0.005/read pay-per-use rate, within the user's approved $10/month budget. `since_id`-scoped incremental fetching means actual usage will typically run well under this once the backfill period passes, since most checks will find only a few genuinely new tweets rather than re-reading the same 10. The Worker's own verification re-fetch (`GET /2/tweets/:id`) adds roughly 1 read per pick per `post-slot` call — negligible at this volume.

## Known risks (documented, not eliminated by this design)

1. **Strict substring content verification, not semantic understanding** — could reject a genuine pick phrased unusually (false negative, safe direction) or, if the routine's extraction is sloppy, could in principle produce a technically-matching but misleading excerpt (same class of risk the existing odds-grounding check already accepts for team-name matching).
2. **Market-odds tier thresholds are a first approximation** and will likely need tuning once real distribution of picks/odds is observed.
3. **Discovery volume** (10 tweets/account/check) could occasionally miss a pick older than the 10 most recent if a check is delayed or an account posts unusually prolifically in a short window — `since_id` pagination mitigates most of this; volume can be raised later within budget if needed.
4. **Still blocked pending user-side setup**: X API pay-per-use billing + Bearer Token generation, and confirming the environment egress fix (in progress as of this writing) actually resolves cloud-routine network access.
5. **`POSTING_PAUSED` stays enabled** until the user explicitly lifts it — this design does not implicitly resume live posting once implemented.

## Relationship to existing systems

Unaffected, unchanged: `handleDailyPostCheck` (manual quiet-period bot, `slot='manual'` picks have no `source_tweet_id` and skip the verified-gate entirely), Stripe checkout, game-staleness handling, the admin panel's Supabase auth, `composeTweet`/`postTweet`. This design only changes (a) how non-manual picks get into the `picks` table, (b) adds a visibility gate ahead of the existing grounding check, and (c) changes what `confidence` is derived from.
