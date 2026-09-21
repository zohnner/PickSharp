# Prop Bets — Design Spec

> **⚠ Amended post-review (2026-09-21):** Four changes made after the design below was written, based on findings from the implementation's per-task and final code review:
> 1. **`player_anytime_td` dropped from prop markets.** The Odds API returns yes/no outcomes for anytime-TD props (no numeric `point`), incompatible with this design's point-based line grounding — the market was being fetched and paid for but could never produce a pick. NFL/NCAAF prop markets are now passing yards, rushing yards, and receptions only.
> 2. **`market` and `line` are discrete, model-returned fields — `pick_text` is composed server-side, not written by the model.** The original design asked the model for `pick_text` as prose and extracted the numeric line via regex on that text. The final review found this left the *published* pick text's stat wording unverified against the real market (e.g. a real rushing-yards line could be labeled "Receiving Yards" in the tweet). `pick_text` is now composed server-side from the grounded `player`/`market`/`line` fields, the same "derive it, don't trust free text" pattern already used for `game_time`.
> 3. **The cron trigger is consolidated, not separate.** The Cloudflare account hit its Workers Free plan's 5-cron-trigger-per-account cap when deploying the "Schedule" section's separate 3rd cron string described below. The props firing was folded into the existing generation cron as `0,15 13,17,22 * * THU,SAT,SUN` instead (a comma-list within one cron string counts as a single registered trigger) — this also fires two extra, deliberately-harmless times a day (13:15, 17:15 UTC) that fall through to the existing quiet-period check.
> 4. **Odds API cost is higher than originally estimated.** The per-event odds endpoint bills per market, so 3 markets (post anytime-TD removal) × 3 events ≈ 9 credits per firing, not the "3 extra calls" originally estimated below — plus `postSlot`'s existing re-verification step triggers a further bulk odds fetch. Worth checking actual Odds API dashboard usage against plan quota before relying on this for a full season.
>
> The "Architecture" and "Known risks" sections below describe the original design as written before these changes; see the code (`worker/pickGenerator.js`, `worker/index.js`, `wrangler.toml`) for the actual shipped behavior.

## Relationship to prior specs

This extends the generation pipeline built in `2026-09-20-own-brand-pick-generation-design.md` and the posting pipeline built in `2026-09-19-x-growth-bot-design.md`, without modifying either. The existing morning/midday/afternoon/evening spread/moneyline/over-under generation and posting logic is untouched by this design — prop bets are a new, parallel content type layered on top, not a replacement for anything.

## Purpose

The X bot currently posts at most once per slot, on a fixed cadence, with one bet-type flavor (spread/moneyline/over-under). This design adds player prop bets as a second, distinct content type, generated and posted once per day, to add variety and a second daily touchpoint aimed at growing X reach/audience — the goal identified during brainstorming as the current priority over revenue or site polish.

**Explicitly out of scope / deliberately decided against, settled during brainstorming:**
- **Not mixed into the existing picks pool.** Props are generated and tracked as their own `slot`, so adding them can't reduce or compete with existing spread/ML/O-U coverage.
- **Not on all three generation slots.** Props generate once per day only, anchored to the evening slot's timing (when the fullest game slate for the day is known), not three times — this bounds both the extra Odds API cost and X posting volume.
- **Not site-only.** Props get their own tweet, since a dedicated tweet is what actually serves the stated reach goal; site-only would just add inventory without the growth benefit.
- **Tweet copy/reasoning improvements are a separate, follow-up design.** The prop tweet reuses the existing `composeTweet` template unchanged for this iteration — tone/hook differentiation between prop and non-prop tweets is real future work, not solved here, per "both, prop bets first."
- **No new `picks` column for player identity.** `player` is used only transiently during generation for grounding verification, then folded into the human-readable `pick_text` (e.g., "Patrick Mahomes Over 275.5 Passing Yards") — same pattern already used for team names. If a future track-record/grading system needs structured player-level data, `pick_text` would need re-parsing; deferred.
- **No sport-diversity requirement across the 3 selected games.** If the 3 soonest upcoming games all happen to be from the same sport (e.g., a cluster of same-time NCAAF kickoffs), that's accepted behavior, not a bug to fix.

## Architecture

### Schedule

One new Cloudflare Cron Trigger: `15 22 * * THU,SAT,SUN` — 15 minutes after the existing evening slot's `22:00 UTC` firing. This becomes the 3rd registered cron string on the account (alongside the existing quiet-period `1,6,...,56 * * * *` and generation `0 13,17,22 * * THU,SAT,SUN`), still well under the account-wide 5-trigger cap. `:15` does not collide with the quiet-period cron's `:01,:06,:11,:16,...` minute list, so there's no ambiguity between the two firings at dispatch time.

### Data flow per firing

1. Cloudflare Cron Trigger fires at `22:15 UTC`. The `scheduled()` handler gets one new branch: `isGenerationDay && hour === 22 && minute === 15` dispatches to `generateAndPostPropsSlot(env)`, checked *before* falling through to the existing quiet-period branch. The existing `morning`/`midday`/`evening` branch is untouched.
2. **Idempotency check**: same pattern as the existing `generateForSlot` — skip if picks already exist for `(today, slot='props')`.
3. Worker calls `getUpcomingOdds(env)` (existing, unchanged) and selects the **3 soonest not-yet-started games** across NFL/NCAAF/NBA, sorted by `commence_time` — the same sort/slice pattern already used in `buildPrompt`. No extra bulk-odds cost; this data is already being fetched.
4. For each of those 3 games, Worker calls a new `getEventProps(env, sportKey, eventId)` — one per-event Odds API call requesting player-prop markets (NFL/NCAAF: passing yards, rushing yards, receptions, anytime TD; NBA: points, rebounds, assists, threes). The 3 calls run via `Promise.allSettled`, isolated per-game the same way the existing multi-sport bulk fetch isolates per-sport failures — one game's props being unavailable doesn't block the other two.
5. Worker calls `env.AI.run(model, { prompt })` via a new `generatePropPicks(env, gamesWithProps)` (sibling to the existing `generatePicks`), passing only the real per-event prop data just fetched, asking for 3-5 picks as JSON: `{ pick_type: "prop", game, game_time_utc, player, pick_text }`.
6. **Inline grounding**: a new `matchesRealProp(pick, propsByGame)` — mirrors the existing `matchesRealGame`, but verifies the pick's `player`, market, and line all appear verbatim in the real fetched prop data for that game, not just the team matchup. Any pick that doesn't verify is discarded before insert, same "never partially trust the model" discipline as every other grounding check in this codebase.
7. `game_time` is derived from `game_time_utc` via the existing `formatGameTime` helper (added in the recent display-bug fix) — not requested from the model, consistent with how the main generation path now works.
8. Surviving picks (capped to 5, same `MAX_PICKS_PER_SLOT` constant) are inserted via the existing `insertPick`, with `slot: 'props'`, `pick_type: 'prop'`, and a price tier from the existing `computeConfidenceFromOdds`.
9. `postSlot(env, 'props')` — the **existing, unmodified** function — picks the lowest-confidence prop as free, composes the tweet via the existing `composeTweet`, and posts it. No new posting code.

### Reuse of existing generic machinery

Adding `'props'` to `GENERATION_SLOTS` and `PIPELINE_SLOTS` (both currently `['morning', 'midday', 'afternoon', 'evening']`) is sufficient to get, with no further code changes:
- `/api/admin/generate-slot {slot: "props"}` — manual generation for testing, not day-gated (only the cron dispatch is), so this can be dry-run any day this week.
- `/api/admin/post-slot` / `/api/admin/pipeline-status` — tracking and manual posting, identical to every other slot.
- `/api/picks/today` and the paywall/checkout logic (`isStale`, `locked`, `freePickId`) — already generic over `pick_type` and `slot`, so props display and unlock/paywall correctly with zero frontend changes.

## Known risks (documented, not solved by this design)

1. **Player-level hallucination is a materially higher embarrassment risk than a wrong spread.** Grounding reduces this to "the player/market/line must exist in real data we just fetched," the same discipline already trusted for games — but it does not make prop generation zero-risk, and this should get a manual `generate-slot` dry-run review before its first live post, same as any new content type on a live-posting account.
2. **New recurring Odds API cost**: 3 extra per-event calls per generation day (up to 12/week in season) on top of the existing bulk calls. Not verified against current Odds API plan headroom in this design — worth a quick quota check before relying on this running for a full season.
3. **No sport-diversity guarantee** in which 3 games get selected — accepted, not a bug (see Purpose).
4. **Doubling of daily tweet volume** on generation days (2 tweets instead of 1) is the entire point of this design, but it also means X API posting-volume usage roughly doubles on those days — not verified against the current X API plan's write limits in this design.

## Relationship to existing systems

Unaffected, unchanged: the existing `morning`/`midday`/`afternoon`/`evening` generation and posting logic, `POSTING_PAUSED`, `composeTweet`, the manual real-tweet aggregation pipeline (`xVerify.js`, `verify-slot`), and all paywall/checkout code. This design adds one new cron trigger, one new slot value flowing through already-generic slot machinery, and two new functions (`getEventProps`, `generatePropPicks`) plus one new grounding check (`matchesRealProp`).
