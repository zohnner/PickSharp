# PickSharp-Branded Pick Generation — Design Spec

## Relationship to prior specs

This spec **replaces the primary volume mechanism** described in `docs/superpowers/specs/2026-09-19-real-pick-aggregation-design.md` (manual admin intake of real tweets) with fully automated generation, while keeping that pipeline's code intact and available as a secondary/manual option — nothing about it is removed. It also revives the *mechanism* (not the design) of the original, fully-superseded `2026-09-19-ai-pick-generation-design.md`: an AI generates picks from real odds data on a schedule. The critical difference from that original design: picks are attributed to **"PickSharp" itself**, not to real, identifiable third parties — the impersonation risk that caused every prior pivot tonight (direct-Anthropic-API → cloud-routine → real-tweet-aggregation) does not apply here, because nothing is presented as a specific real person's statement.

## Purpose

Manual real-tweet intake doesn't scale — it requires a human to notice and transcribe real picks, which caps volume at whatever an admin has time for. This design replaces that bottleneck with scheduled, automated generation: the Worker itself (via a Cloudflare Workers AI binding, not an external API call) generates picks from real market odds on the same 3-slot cadence already built, attributed to "PickSharp" as the site's own analysis.

**Explicitly out of scope / deliberately decided against:**
- **No real-person attribution, ever, for generated content.** This is the one non-negotiable carried forward from every prior pivot tonight.
- **No genuine predictive edge claimed or expected.** Same acknowledgment as the original design: an LLM reasoning over odds data is not equivalent to expert handicapping. Accepted, not solved here.
- **No human review gate.** Generated picks publish and become sellable/postable autonomously, gated only by the grounding check (below) — consistent with the original design's accepted risk profile, now safe to accept again since there's no impersonation exposure.
- **Manual real-tweet intake is not removed.** `worker/xVerify.js`, the `verify-slot`/`post-slot` verification pipeline, and the admin panel's source-tweet form all keep working unchanged — this design adds a new, primary content source alongside them, not instead of the code.
- **Broader "traffic generation"** (SEO, other platforms, paid acquisition) is a separate future topic — this design only covers content generation and reuses the existing X-posting distribution unchanged.

## Architecture

### Generation mechanism: Cloudflare Workers AI, not an external API call

A new `[ai]` binding (`binding = "AI"`) in `wrangler.toml` gives the Worker direct access to a Workers AI model via `env.AI.run(...)` — billed through the existing Cloudflare account (no new vendor relationship, unlike the rejected Anthropic API billing), and not an outbound HTTP call (no egress dependency, unlike the cloud-routine architecture that got stuck on a sandbox network policy that was never resolved).

### Why this is simpler than the aggregation pipeline it's replacing

Real-tweet verification had to be a deferred, two-phase process (insert unverified → separately re-fetch and verify later) because the source tweet was external and async. Generation has no such constraint: the Worker fetches real odds and generates picks from that exact data in the **same request**, so grounding can happen inline before a pick is ever inserted — no `verified` flag, no visibility gate, no separate verification pass needed for this path.

### Data flow per scheduled firing

1. Cloudflare Cron Trigger fires for a slot (same 3-slot Thu/Sat/Sun cadence as the original design: `morning`/`midday`/`evening`, ~9am/1pm/6pm ET).
2. **Idempotency check**: if picks already exist for `(today, this slot)`, skip — matches the existing pattern used for posting idempotency (`daily_posts`), applied here to generation itself so a retry or overlapping trigger can't double-generate.
3. Worker calls `getUpcomingOdds(env)` (existing, unchanged) for current NFL/NCAAF odds.
4. Worker calls `env.AI.run(model, { prompt })` with that real odds data, asking for 3-5 picks as structured JSON: `{ pick_type, game, game_time, game_time_utc, pick_text }` — deliberately **no `confidence` field requested**, matching the reasoning already established for real-tweet picks (price tier should come from real market data, not the model's self-assessment).
5. **Inline grounding**: each generated pick is checked against the same `oddsGames` array already in memory (`matchesRealGame`, existing/unchanged) — any pick referencing a game not actually present in that data is discarded before insert, never reaching the database. No deferred cleanup needed since nothing was ever written.
6. Surviving picks get their price tier from `computeConfidenceFromOdds` (existing, unchanged) — same odds-derived tiering already built and reviewed for the aggregation pipeline.
7. Insert with `author: "PickSharp"`, `slot`, `game_time_utc`; no `source_tweet_url`/`source_tweet_id` (not applicable — `NULL`, same as a manual pick). Visible on `/api/picks/today` immediately — the existing visibility gate (`verified = 1 OR source_tweet_id IS NULL`) already treats a `NULL`-source pick as immediately visible, so **no schema change is required** for this feature.
8. The existing `post-slot` flow (tweet composition/posting, `POSTING_PAUSED` gate, `daily_posts` idempotency) applies completely unchanged — this design does not touch posting logic at all, and does not lift `POSTING_PAUSED`.

### JSON response robustness

Workers AI responses, like any LLM output, may wrap JSON in prose or markdown fences. Reuse the same defensive extraction approach the original (deleted) `pickGenerator.js` used: locate the first `[` through the last `]` in the response rather than assuming a clean, unwrapped JSON body, and validate the parsed shape (`pick_type` in the allowed enum, all required fields present, non-empty strings) before treating any element as insertable — malformed output is logged and skipped, not partially trusted.

### Manual trigger for testing

A new `POST /api/admin/generate-slot` (admin-secret protected) runs the same generation logic on demand — same idempotency check, same grounding, same insert path — so this can be tested and iterated on before ever waiting for a live cron firing, mirroring how `verify-slot` was added tonight specifically to make the verification pipeline testable without needing to post.

### Schema

**None required.** `author`, `slot`, `game_time_utc` already exist and already support exactly this shape (a `NULL`-sourced pick with a slot). `picker_stats` needs no change either — a pick authored `"PickSharp"` with no matching `picker_stats` row already displays a `55.0` default win rate via the existing `COALESCE(s.win_rate, 55.0)` join; a real `PickSharp` track-record row can be added later once there's real outcome data to seed it with, not before.

## Known risks (documented, not solved by this design)

1. **No proven predictive edge** — same core risk as the original design, explicitly accepted.
2. **Fully autonomous, no human review** — accepted, same reasoning as above; no impersonation exposure makes this an acceptable tradeoff again.
3. **Workers AI model quality is untested for this task** — which specific model to use, and whether its output quality justifies the price tier being charged, is a plan/implementation-time decision to validate with real output, not assumed here.
4. **Two content sources now coexist** (generated "PickSharp" picks and manually-aggregated real-tweet picks) — both flow through the same `picks` table and slot/posting machinery without conflict, but this doubles the number of ways content can enter the system; worth revisiting if it becomes confusing in practice.

## Relationship to existing systems

Unaffected, unchanged: the entire real-tweet aggregation pipeline (`xVerify.js`, `tiering.js`'s reuse here is the only shared code, `verify-slot`, the admin panel's source-tweet form), Stripe checkout, game-staleness handling, `POSTING_PAUSED`. This design only adds a new, automated content-insertion path that produces picks structurally identical to a manual `NULL`-source pick.
