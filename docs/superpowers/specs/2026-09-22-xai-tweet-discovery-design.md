# xAI Tweet Discovery — Design Spec

## Relationship to prior specs

This spec **extends** `docs/superpowers/specs/2026-09-19-real-pick-aggregation-design.md` — it does not change intake, verification, or tiering, all of which stay exactly as that spec defines. It automates only the "spotting" half of that flow: today an admin has to personally notice that one of the 5 tracked accounts (`@CodyBrownBets`, `@SharpFootball`, `@jasonrmcintyre`, `@DocsSports`, `@nflpickspage`) posted a pick, then paste its URL in. This design adds a step *before* that: a scheduled Worker call surfaces candidate tweets for the admin to review, so they're reacting to a short list instead of independently monitoring 5 timelines.

The real-pick-aggregation spec's own forward-pointer ("Automated discovery... is the natural next addition once the cloud-routine sandbox can reach the internet") assumed discovery would run as a Claude Code cloud routine. This design takes a different path entirely: the discovery call runs **from the Worker itself** via a direct HTTPS call to xAI's API — the same pattern `worker/oddsApi.js` and `worker/x.js` already use to reach external services in production. The cloud-sandbox egress block that killed the original attempt never applied to the Worker, so this design doesn't wait on that issue being resolved.

## Purpose

Give the admin a low-effort candidate list of real, recent posts from the 5 tracked accounts, generated via xAI's Grok `x_search` tool — spending a fixed, **non-refundable** $20 of existing xAI credit on a scoped pilot rather than leaving it unused. Nothing about the trust model changes: a real person's real words are being surfaced for an admin to notice faster, never generated or paraphrased on their behalf.

**Explicitly out of scope / deliberately decided against:**
- **No auto-publishing of discovered picks.** A discovered candidate is a suggestion, not a pick. It still passes through the existing admin-entry + Worker-side re-fetch verification from the real-pick-aggregation spec before it can ever be shown or tweeted. Skipping human confirmation here is a materially bigger risk than the fictional-persona generation pipeline's "no review gate" (that pipeline validates against real odds data it controls; this one would be asserting what a real, non-affiliated person said).
- **No long-term production dependency.** $20 is one-time and won't be replenished. The design must degrade to exactly today's manual-only flow the moment the budget (or the key) runs out — never a hard dependency that breaks something when it's gone.
- **No expansion beyond the existing 5 handles**, and no general-purpose search capability — this is scoped to one job.
- **No changes to `POSTING_PAUSED`, pricing, or tiering.** Everything downstream of "an admin decided this is a real pick" is unchanged.

## What the spike found (this shapes every choice below)

Two live test calls against `@CodyBrownBets` via `POST https://api.x.ai/v1/responses` with the `x_search` tool, `allowed_x_handles: [handle]`:

| | Call 1 | Call 2 |
|---|---|---|
| Model | `grok-4.7` (default reasoning) | `grok-4.20-0309-non-reasoning` |
| Prompt | Open-ended ("find picks, report them") | Tight (one search call, limit 5, JSON-only, no profile lookups) |
| `x_search_calls` | 12 | 1 |
| `x_posts_fetched` | 76 | 5 |
| Reasoning tokens | 1,532 | 0 |
| **Confirmed cost** | **$0.45** | **~$0.029** (estimated from the same `cost_in_usd_ticks` ratio call 1 confirmed against actual billing — xAI doesn't document the tick-to-dollar conversion, so this is calibrated, not official; re-check against the xAI console before trusting it at scale) |
| Usable candidates found | 4 real player props, full text, real URLs/timestamps | 0 — the 5 most recent posts happened to be an image bet-slip and a video teaser, neither with extractable pick text |

Conclusions baked into this design:
1. **Model choice is the dominant cost lever**, not the search itself — switching off default reasoning cut cost ~15x.
2. **A tight result limit trades away recall.** The tracked accounts interleave image/video-only posts (bet-slip screenshots, teaser videos) with genuine text picks; capping results at 5 can return zero usable candidates purely by bad luck of ordering. The fetch-cost difference between 5 and ~10-15 results is small (billed per-post-fetched, not per-call), so there's no real reason to under-fetch.
3. **Billing is per-post-fetched ($5/1k) plus token cost**, not a flat per-call fee — this is why capping the model's own search behavior (one call, explicit limit, no incidental profile lookups) matters more than which specific model tier is used.
4. **The model already declines to fabricate** when a pick isn't extractable from text (it explicitly said so for image/video posts rather than guessing) — this matches the no-fabrication discipline the rest of the pipeline already enforces, so no extra prompt-guarding is needed there.

## Architecture

### New module: `worker/xaiDiscovery.js`

Follows the existing raw-`fetch`-no-SDK pattern (`worker/oddsApi.js`, `worker/x.js`).

```js
export async function discoverCandidates(env, handle) {
  // POST https://api.x.ai/v1/responses
  // model: 'grok-4.20-0309-non-reasoning' (verify against xAI's current model
  // list before implementing — model IDs have already rotated once during
  // this spike's testing and will likely rotate again)
  // tools: [{ type: 'x_search', allowed_x_handles: [handle], from_date, to_date }]
  // prompt: exactly one search call, result limit ~10-15 (not 5 — see recall
  // finding above), no profile/user lookups, JSON-only output:
  //   {"posts":[{"text": "...", "url": "...", "posted_at": "..."}]}
  // Returns the parsed posts array as-is (no pick-shape filtering here —
  // the admin is the filter, same as today's manual flow).
}
```

`from_date`/`to_date` scope to a window matching the check cadence (below) plus a small overlap buffer, so a slow admin doesn't lose a candidate that ages out between checks.

### Budget tracking + kill switch

xAI's per-call cost signal (`cost_in_usd_ticks`) isn't documented in dollars, so tracking spend by re-deriving it from that field on every call is the only self-contained option:

```sql
CREATE TABLE IF NOT EXISTS xai_spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  cost_usd_ticks INTEGER NOT NULL,
  estimated_usd REAL NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Before each discovery run, sum `estimated_usd` from this table; if the running total is within a safety floor of the known $20 ceiling (e.g., stop with $2 of headroom left, not $0 — the tick-to-dollar conversion is calibrated, not official, so the floor is a hedge against that estimate being off), skip the run entirely and log why. This never throws and never blocks the rest of the scheduled dispatch — same fail-safe posture as an odds-fetch or generation failure elsewhere in this Worker.

`XAI_DISCOVERY_PAUSED` is a separate, manual kill switch — exact-string `"true"`/`"false"` match, not a truthy check (the existing `POSTING_PAUSED` pattern, chosen deliberately after that exact footgun bit this project once already).

### Secrets

`XAI_API_KEY` currently lives only in `.env`, which nothing server-side reads (that file only reaches the frontend bundle for `VITE_`-prefixed vars). It needs to move to `.dev.vars` for local dev and `wrangler secret put XAI_API_KEY --name picksharp` for production — same handling as any other Worker secret in this project.

### Cron / trigger design

A dedicated, deliberately low-frequency cron — **once per game day** (Thu/Sat/Sun), covering all 5 handles in one run, not tied to the 3x/day generation slot cadence used for AI-generated picks (that cadence exists because generation needs fresh odds throughout the day; discovery just needs to catch a post before it goes stale, and doesn't need to re-check hourly).

Budget math at the optimized (call 2) rate, worst-casing it 3x higher for safety margin: 5 handles × 3 days/week × ~$0.10/handle ≈ $1.50/week of game-day checks → the $20 budget lasts roughly **13 weeks** even under a pessimistic cost estimate. This is intentionally conservative — the goal is a sustained pilot across most of a season, not maximum throughput.

### Output: candidate surfacing, not auto-insert

```sql
CREATE TABLE IF NOT EXISTS discovered_tweet_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  post_text TEXT NOT NULL,
  post_url TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed INTEGER NOT NULL DEFAULT 0
);
```

Discovery writes here, never into `picks`. A new admin-only endpoint (`GET /api/admin/discovered-candidates`, same `requireAdmin` gate as the existing admin routes) lists non-dismissed candidates; the admin either dismisses one or uses it to pre-fill the existing pick-creation form (`author` = handle, `source_tweet_url` = candidate URL) — they still type `pick_type`/`game`/`game_time`/`pick_text` themselves, exactly as the real-pick-aggregation spec already requires. This keeps 100% of the existing verification/tiering pipeline untouched; discovery only removes the "notice it happened" step.

### Error handling

- xAI API failure (network error, non-2xx, or budget floor reached): log, skip that handle for this run, continue to the next handle. Never throws, never touches `daily_posts`/`POSTING_PAUSED`-gated posting logic.
- Malformed/non-JSON model output: log the raw response for debugging, skip that handle's result for this run.
- Total failure of the entire discovery step (e.g., key revoked) has zero effect on AI generation or manual entry — this is a pure addition, same framing as the original (superseded) automated-discovery plan.

## Testing

No test runner in this repo (matches existing convention). Manual verification via `node` scripts — the same throwaway-script pattern used during this spike — plus `wrangler dev --local` and `curl` against a manual-trigger endpoint before relying on the cron, then inspecting `discovered_tweet_candidates` rows directly.

## Open decisions for plan/implementation time

- Exact result limit (the spike tested 5; 10-15 is proposed above but not yet live-tested) — one more tuning pass recommended before locking this in.
- Exact budget safety-floor dollar amount.
- Whether v1 ships a real admin-panel UI for the candidate list or just a raw endpoint/D1 query for the pilot period, with UI polish deferred.
