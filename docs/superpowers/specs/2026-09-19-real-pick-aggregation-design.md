# Real Pick Aggregation — Design Spec

> **⚠ AMENDED (2026-09-20): discovery moved from cloud routine to manual admin entry.** The cloud-routine sandbox that all 3 scheduled routines run in cannot reach *any* external domain — not third-party APIs, not `wepicksharp.com` itself — due to an organization-level network policy with no discoverable self-service control (confirmed via a live re-check after the user changed an "allow all domains" environment setting; still blocked identically). Rather than block Sunday's launch on that being resolved, **automated discovery is deferred** and this phase uses **manual admin-panel entry** instead: a human pastes a real tweet's URL in, the Worker (which has no egress restriction — it already calls Stripe/Supabase/Odds API/X successfully in production) does the re-fetch, verification, and tiering. Everything below except the "Discovery (routine)" section is unchanged from the original design; see the new "Intake (manual, admin panel)" section for what replaced it. Automated discovery can be added later as a pure addition once the sandbox issue is resolved — nothing about the manual path needs to change when that happens.

## Relationship to prior specs

This spec **replaces** `docs/superpowers/specs/2026-09-19-ai-pick-generation-design.md` in full — not an extension of it, a different mechanism entirely. That spec (and its architecture-pivot addendum) covered generating fictional pick content and attributing it to 5 fixed personas. This spec covers the opposite: **never generating pick content**, only aggregating and attributing picks that one of those 5 accounts genuinely, verifiably posted.

Full rationale for the pivot: `.superpowers/sdd/2026-09-19-ai-pick-generation/progress.md`, section "Feature: game staleness + post-slot grounding verification (2026-09-19)", final paragraph.

## Purpose

The site's 5 fixed personas (`@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`) are real, active, identifiable X accounts belonging to real people/businesses (e.g. `@jasonrmcintyre` is Jason McIntyre, a FOX Sports personality; `@SharpFootball` is Warren Sharp). The previous pipeline auto-generated fictional pick content and attributed it to these real handles — a false-endorsement/impersonation risk, already live in production via seed data.

This design replaces that entirely: real picks from these 5 accounts get entered (currently: manually, by an admin who spotted them — see the amendment note above) with a link back to the source tweet, never invented. A Worker-side verification step independently re-fetches the specific tweet and confirms both authorship and content before the pick is ever shown on the site or tweeted about — mirroring the existing odds-grounding-check pattern already shipped in `handlePostSlot`.

**Explicitly out of scope / deliberately decided against:**
- **No new persona discovery.** Still exactly these 5 tracked accounts; adding more is a future decision, not part of this work.
- **No sentiment/tone-based confidence.** Real accounts don't self-label conviction the way the old fabricated pipeline did, and reading tone into a real person's tweet to price a product is its own risk. Confidence/price tier is derived from real market odds instead (see below), not language.
- **No fully automated re-tweeting of arbitrary account content.** Only genuine picks (a game + a bet type) an admin has actually chosen to enter are candidates.
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

### Intake (manual, admin panel)

No routine involved. In the existing admin panel's pick-creation form (already gated by Supabase login / `ADMIN_EMAILS`):

1. The admin picks one of the 5 tracked accounts from a dropdown (not free text — keeps `author` constrained to the known set, same as today's `CHECK`-adjacent convention) and pastes the real tweet's URL.
2. The admin manually fills in `pick_type`, `game` (exact full team names — same strict format the grounding check already expects, no abbreviations), `game_time_utc`, and `pick_text` by reading the actual tweet themselves — this is the same information a human already had to type for any manual pick today, just now sourced from a real tweet instead of invented.
3. `source_tweet_id` is parsed client-side from the pasted URL (the trailing numeric segment of `x.com/<handle>/status/<id>`).
4. **No `confidence` is entered by the admin** — submitted as a placeholder (`"medium"`), invisible until verification overwrites it. Keeping tiering odds-derived rather than admin-assigned preserves the original reasoning (an objective signal, not a subjective one) regardless of who's doing the sourcing.
5. `POST /api/admin/picks` (existing endpoint, extended) accepts the new `source_tweet_url`/`source_tweet_id` fields alongside the existing ones, with `slot` set to whichever of `morning`/`midday`/`evening` is currently active (or `manual`, unaffected, if the admin isn't tagging it to a slot).
6. When ready, the admin triggers `POST /api/admin/post-slot` for that slot as today — unchanged call shape, still blocked by `POSTING_PAUSED` until explicitly lifted.

Automated discovery (a routine doing steps 1-3 on a schedule via X API reads) is the natural next addition once the cloud-routine sandbox can reach the internet — it would slot in ahead of step 5 without changing anything downstream.

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

`ingested_tweets(tweet_id PK, author, ingested_at)` is still written whenever `POST /api/admin/picks` receives a `source_tweet_id` — now serving as a duplicate-submission guard (reject/flag if the admin accidentally pastes the same tweet URL twice) rather than a `since_id` cursor for a routine. No `last-seen-tweets` endpoint is needed for this phase; it's deferred along with automated discovery.

### Credentials

- New secret: `X_BEARER_TOKEN` (app-only auth) — used **only by the Worker**, for the `post-slot` verification re-fetch. Nothing routine-side needs it in this phase, since there's no routine involved.
- No routine prompt changes in this phase — the 3 existing routines stay exactly as they are (still disabled, still carrying their old generation-style prompts) since they're not part of this flow at all right now.

### Cost

At manual-curation volume (a human submitting a handful of picks around game days, not a scheduled bulk read), the only X API usage is the Worker's `post-slot` verification re-fetch — roughly 1 read per submitted pick. Even a busy NFL Sunday (dozens of picks) stays well under a dollar at $0.005/read. The $10/month budget discussed earlier was sized for automated discovery's higher read volume; it's not needed for this phase and can be revisited if/when discovery is added back.

## Known risks (documented, not eliminated by this design)

1. **Strict substring content verification, not semantic understanding** — could reject a genuine pick phrased unusually (false negative, safe direction) or, if the admin mistypes `pick_text`, could in principle produce a technically-matching but misleading excerpt (same class of risk the existing odds-grounding check already accepts for team-name matching).
2. **Market-odds tier thresholds are a first approximation** and will likely need tuning once real distribution of picks/odds is observed.
3. **Manual intake doesn't scale** — relies on a human noticing and entering each real pick; acceptable for a first launch, revisit once volume or reliability demands automation.
4. **Still blocked pending user-side setup**: X API pay-per-use billing + Bearer Token generation (needed for the Worker's verification re-fetch regardless of manual vs. automated intake). The cloud-routine sandbox egress issue no longer blocks this phase at all — only the future automated-discovery phase.
5. **`POSTING_PAUSED` stays enabled** until the user explicitly lifts it — this design does not implicitly resume live posting once implemented.

## Relationship to existing systems

Unaffected, unchanged: `handleDailyPostCheck` (manual quiet-period bot, `slot='manual'` picks have no `source_tweet_id` and skip the verified-gate entirely), Stripe checkout, game-staleness handling, the admin panel's Supabase auth, `composeTweet`/`postTweet`. This design only changes (a) how non-manual picks get into the `picks` table, (b) adds a visibility gate ahead of the existing grounding check, and (c) changes what `confidence` is derived from.
