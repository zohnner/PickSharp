# AI Pick Generation — Design Spec

## Purpose

Replace manual admin-panel pick entry with an autonomous pipeline: on a game-day schedule (Thursday/Saturday/Sunday, 3 slots/day — `morning`/`midday`/`evening`), a Cloudflare Worker pulls current NFL/NCAAF odds from an external API, asks Claude (via a direct Anthropic API call) to generate a batch of picks from that data, and inserts them into the existing `picks` table. The existing X growth bot (quiet-period cron + template tweet) then picks up the new content and posts automatically, unchanged in its own logic beyond becoming slot-aware.

**Explicitly out of scope / deliberately decided against, raised and settled during design:**
- **No human review gate.** Generated picks publish and become sellable fully autonomously — a deliberate choice, accepted with the understanding that this means unreviewed AI output goes directly to paying customers.
- **No genuine predictive edge claimed or expected.** An LLM reasoning over odds data is not equivalent to expert handicapping — there is no evidence this produces picks with real edge over the market. This is a known, accepted characteristic of the approach, not a bug to fix.
- **Branding stays as-is.** The site continues presenting picks as "curated from the sharpest NFL accounts on X" — AI-generated content is attributed to the existing 5 fixed personas in `picker_stats`, not disclosed as AI-generated. A deliberate choice; carries reputational/disclosure risk if ever scrutinized, accepted by the product owner.
- **Claude does not generate tweet copy.** The existing template-based tweet system (built separately, already live) keeps working unchanged — Claude's only job is generating pick content, not marketing copy.
- **`game_time` staleness is not solved here.** `game_time` is free text, not a real timestamp, so there's no way to programmatically stop selling a pick once its game has started. This already exists as a latent gap in the shipped paywall and becomes more visible with 3 batches/day; deferred as a separate future fix.
- **New persona creation is out of scope.** Generated picks are always attributed to one of the 5 existing fixed personas, never a new name.

## Architecture

### Schedule

Three Cloudflare Cron Trigger firings per active day (Thursday, Saturday, Sunday only — no firing on Mon/Tue/Wed/Fri, since there's no NFL/NCAAF slate to generate content for): `morning`, `midday`, `evening` slots, exact clock times to be finalized at implementation time (approximate targets: ~8am/~1pm/~6pm ET). Each firing is independent and self-contained — it doesn't depend on any other firing that day having succeeded.

### Data flow per firing

1. Worker calls **The Odds API** for current NFL/NCAAF odds (free tier — at 9 firings/week this stays well within free-tier request limits).
2. Worker calls **Anthropic's Messages API** directly via `fetch` (no SDK, matching the existing `worker/stripe.js`/`worker/x.js` pattern) with a prompt containing: the current slate's odds data, the 5 existing personas from `picker_stats`, and a request for structured JSON output — an array of `{author, pick_text, pick_type, confidence, game, game_time}` objects, `author` constrained to the 5 existing personas, `pick_type`/`confidence` constrained to the same enums already enforced by `worker/schema.sql`'s `CHECK` constraints.
3. Worker validates the response (valid JSON, matches expected shape, `author`/`pick_type`/`confidence` are from the allowed sets). If validation fails for any reason, the run logs the failure and skips — no partial/malformed data ever reaches the `picks` table. This mirrors the tweet-bot's existing fail-safe pattern (log and skip rather than crash or corrupt).
4. Valid picks are inserted into `picks`, each tagged with a new `slot` column (`morning`/`midday`/`evening`) alongside the existing `created_at`-based date.

### Schema changes

```sql
ALTER TABLE picks ADD COLUMN slot TEXT; -- 'morning' | 'midday' | 'evening', NULL for pre-existing/manually-entered picks
```
(SQLite's `ALTER TABLE ... ADD COLUMN` is safe to run against the already-populated production table; existing rows get `NULL`, which the free-pick/query logic below must treat as "not part of any AI-generated slot" — i.e., manual admin entries keep working exactly as before, just without slot semantics.)

```sql
ALTER TABLE daily_posts ADD COLUMN slot TEXT NOT NULL DEFAULT 'legacy';
```
Changes the idempotency key conceptually from "one post per date" to "one post per (date, slot)" — requires also changing `daily_posts`'s primary key from `date` alone to a composite `(date, slot)`, which in SQLite means recreating the table (D1 supports `ALTER TABLE` for adding columns but not changing primary keys in place). This is real migration work, not a one-liner — flagging it now so it's not a surprise at implementation time.

### Free-pick logic becomes slot-aware

`freePickId()` (currently: lowest confidence among all of today's picks) becomes: lowest confidence among today's picks **within a given slot**. The bot's quiet-period check and tweet-composition logic both need to operate per-`(date, slot)` instead of per-`date`.

### Display

The paywall's `/api/picks/today` continues showing all of today's picks (cumulative across whatever slots have fired so far that day), with **each slot's own free pick unlocked** — by evening on a Sunday, a visitor could see 3 unlocked "free" picks (one per slot) plus however many locked/paid picks accumulated across the day. This compounds naturally into more bundle-unlock value as the day progresses.

### Personas

The prompt includes the current 5 personas and their names verbatim (`@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`) and instructs Claude to assign each generated pick to one of them, rotating reasonably across a batch rather than always picking the same one.

### Cost

- **The Odds API**: ~39 calls/month at 9 firings/week — within free-tier limits (verify exact current free-tier caps at implementation time, since pricing/limits can change).
- **Anthropic API**: modest per-call cost (a day's odds data in, a short structured JSON batch out) — low dollars per season at this cadence, an order of magnitude below the existing X API cost. Verify current per-token pricing before finalizing a specific model choice and budget at implementation time.
- Model choice (Sonnet vs. a cheaper tier) is an implementation-time decision, not settled here — trade quality of generated analysis against per-call cost once real prompts/outputs can be measured.

## Known risks (documented, not solved by this design)

1. **No proven predictive edge** — the core product risk of this whole feature. Explicitly accepted by the product owner.
2. **Fully autonomous, no human review** — AI output goes directly to paying customers with no gate. Explicitly accepted.
3. **`game_time` staleness** — a pick can remain listed/sellable after its game has already started, worsened by 3x daily volume. Deferred.
4. **Branding/disclosure risk** — AI-generated content presented under personas implying human curation. Explicitly accepted.
5. **`daily_posts` primary-key migration** — moving from `date` to `(date, slot)` requires a real schema migration (table recreation in SQLite/D1), not a trivial `ALTER TABLE`. Flagged for implementation-time planning, not solved here.

## Relationship to existing systems

This design extends, rather than replaces, the already-shipped X growth bot (`docs/superpowers/specs/2026-09-19-x-growth-bot-design.md`): that system's OAuth posting, attribution tracking, and template-based tweet composition all keep working unchanged. This spec only changes (a) how picks get into the `picks` table (autonomous generation instead of manual admin entry) and (b) makes the free-pick/idempotency logic slot-aware instead of day-aware.
