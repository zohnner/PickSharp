# Edge Logger Design

**Date:** 2026-09-23
**Status:** Approved design
**Parent:** `2026-09-23-profitability-strategy-design.md` (sub-project 1, minimal version)

## Purpose

Measure, with real data, whether Pinnacle-vs-US-book pricing edges on football game lines are frequent enough and hold up against the closing line well enough to sell as a subscription. This is a measuring instrument, not the product: nothing public, nothing posted, no emails.

The launch gate it feeds: ~3–4 weeks or 100+ edges with average CLV of about +1% or better.

## Scanning

- **When:** the existing `1,6,11,...,56 * * * *` cron. In `scheduled()`, fires at minutes 1/16/31/46 between 12:00 and 05:59 UTC run the edge scan *in addition to* the existing `handleDailyPostCheck` (both via `ctx.waitUntil`). Dispatch is derived from `event.scheduledTime` like the other branches. No new cron trigger, because the account is at Cloudflare's 5-trigger cap.
  - There's no overlap with the generation cron (`0,15,30 12,13,17,22 ...`), whose minutes 0/15/30 never match 1/16/31/46.
- **What:** for each sport in `EDGE_SPORTS` (`americanfootball_nfl`, `americanfootball_ncaaf`): `GET /v4/sports/{sport}/odds?bookmakers=pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,hardrockbet&markets=h2h,spreads,totals&oddsFormat=decimal`.
  - Up to 10 named bookmakers bill as 1 region, so each call costs 3 credits (confirmed live in the spike), 6 per scan.
  - Monthly budget: 18 h/day × 4 scans/h × 6 = 432 credits/day, about 13K/month. Together with the current AI pipeline (~80 credits per game day), that fits the 20K plan.
  - Per-sport failures are isolated with `Promise.allSettled`, like `getUpcomingOdds`. `logQuota` logs the remaining balance.
- **Kill switch:** `EDGE_SCAN_PAUSED` in `wrangler.toml`, exact match `=== 'true'`. **It ships as `"true"`.** On the free 500-credit plan the scanner would drain the remaining credits in under a day and break the AI pipeline. The owner flips it to `"false"` after upgrading to the paid plan.

## Detection

**`worker/devig.js`** (pure)
- `shinFairProbs([priceA, priceB])` takes 2-way decimal prices and returns fair probabilities that sum to 1, using the Shin method with the `z` parameter solved by bisection on [0, 0.4].
- Proportional margin removal is **not** used anywhere: the spike showed it inflates longshots (51 false edges versus 2 real ones).

**`worker/edges.js`** (pure)
- `findEdges(events, nowMs)` returns candidate edges. For each event that hasn't started and has a `pinnacle` bookmaker, and each Pinnacle market with exactly 2 outcomes:
  - Compute Shin fair probabilities.
  - For each non-Pinnacle book's outcome with the **same market key, outcome name and `point`** (exact match; alternate-line pricing is out of scope), compute `ev = fairProb × bookPrice − 1`.
  - Return every outcome with `ev ≥ 0.01` as `{event_id, sport, game: "Away @ Home", commence_time, market, outcome, point, book, price, fair_prob, ev}`.
- `closingUpdates(events, nowMs)` returns the latest Pinnacle fair probability and the latest price per (event, market, outcome, point, book), for every combination present on events that haven't started. This is what keeps closing lines current for already-logged edges, including ones whose EV has since dropped below 1%.

## Storage

New table in `worker/schema.sql` (applied with the existing idempotent `npm run db:migrate:remote`):

```sql
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  game TEXT NOT NULL,
  commence_time TEXT NOT NULL,          -- ISO 8601 UTC from the odds feed
  market TEXT NOT NULL,                 -- h2h | spreads | totals
  outcome TEXT NOT NULL,                -- team name, or Over/Under
  point REAL,                           -- NULL for h2h
  book TEXT NOT NULL,
  first_price REAL NOT NULL,            -- decimal price when first seen (what a subscriber could have bet)
  first_fair_prob REAL NOT NULL,
  first_ev REAL NOT NULL,
  peak_ev REAL NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_edge_seen_at TEXT NOT NULL DEFAULT (datetime('now')),  -- last scan where ev >= 1%
  close_price REAL,                     -- book price at the last scan before kickoff
  close_fair_prob REAL,                 -- Pinnacle Shin fair prob at the last scan before kickoff
  close_updated_at TEXT
);

-- SQLite treats NULLs as distinct in UNIQUE constraints, so h2h rows (point NULL)
-- are deduplicated through a sentinel in an expression index instead.
CREATE UNIQUE INDEX IF NOT EXISTS edges_identity
  ON edges (event_id, market, outcome, COALESCE(point, -9999), book);
```

**Per scan (`runEdgeScan(env)` in `worker/edgeScan.js`, which does the I/O; `edges.js` stays pure):**
1. Upsert each found edge (`INSERT ... ON CONFLICT DO UPDATE` against `edges_identity`). A new row sets the `first_*` fields. An existing row keeps its `first_*` fields and updates `peak_ev = MAX(peak_ev, excluded.first_ev)` and `last_edge_seen_at`.
2. For every logged edge whose `commence_time` is still in the future, write `close_price`, `close_fair_prob` and `close_updated_at` from `closingUpdates`. After kickoff the event drops out of the odds feed, so the last write stands as the close, taken within 15 minutes of kickoff.
- **CLV** is computed at read time: `first_price × close_fair_prob − 1`.
- The writes are batched with `env.DB.batch()` so one scan makes a bounded number of round trips.

## Visibility

`GET /api/admin/edges` (`requireAdmin`) returns:
- `summary`: logged edges in total and by sport, market, and EV band (1–2%, 2–3%, 3%+); edges per scan-day; median minutes between first and last sighting; for edges with a close, the average CLV and the share with positive CLV, overall and at 2%+ EV.
- `recent`: the latest 50 edges with their computed CLV.

## Error handling

- The scan never throws out of `scheduled()`: it has a top-level try/catch with `console.error`, like `generateAndPostSlot`.
- If the odds fetch fails for one sport, that sport is logged and skipped. If every sport fails, the scan is a no-op, so no rows change.
- Markets where Pinnacle's outcomes aren't exactly 2, or a price is ≤ 1, are skipped.

## Testing

- `worker/devig.test.js`: the Shin probabilities sum to 1; an even market (1.95/1.95) gives 0.5/0.5; on a lopsided market the longshot's fair probability is below proportional margin removal's (the property that removed the spike's false edges). Also a reference value computed independently.
- `worker/edges.test.js`, using a small hand-built fixture shaped like the real Odds API response (modeled on the spike's saved snapshot):
  - Finds a known Shin edge.
  - Matches only exact points.
  - Skips events that have started and markets that aren't 2-way.
  - `closingUpdates` covers the logged combinations.
- **Production check after the owner upgrades the plan:** set `EDGE_SCAN_PAUSED="false"`, deploy, wait for one scheduled scan, confirm the `[odds-quota]` log lines and the rows in `edges`, and check `/api/admin/edges`.

## Out of scope

Win/loss grading (the proof layer), props, alternate-line pricing, NBA (added in October if the budget allows), email alerts, public pages, and posting to X.
