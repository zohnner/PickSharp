# PickSharp Profitability Strategy

**Date:** 2026-09-23
**Status:** Approved direction; each sub-project below gets its own spec → plan → build cycle.

## Driving goal

PickSharp exists to make money as a real business. Target: $5k+/month, with the owner willing to invest money and serious weekly time over 6–12 months. Every roadmap decision is judged by whether it moves revenue.

**Hard line:** no fabricated records, fake testimonials, impersonation, or unlicensed affiliate activity. These are the fastest way to lose the X account, affiliate payouts, and the Stripe account, and any of those takes revenue to zero.

## Where we are (2026-09-23)

- Total funnel since launch: 4 visitors from X, 1 registered user (the owner), 0 paid unlocks, $0 revenue. The only affiliate click and checkout were 24 seconds apart, so they were almost certainly one tester.
- **The bottleneck is traffic, not payments or the track record.**
- The current product (AI-generated picks from a small open model reading market odds) has no edge. Over time it should land around 48–50% against the spread, below the ~52.4% break-even at -110. A business that *sells* these picks eventually runs into that honest record.
- The generator has published contradictory picks on the same game (Giants +6.5 / Rams -6.5, and both moneylines).

## Direction: edge tool (product) + media (distribution)

Stop *predicting* games. Sell *measurable pricing edges* instead:

- **Edge detection.** Remove the bookmaker's margin from Pinnacle's odds to get a fair price, then flag US-sportsbook lines priced better than that fair price (+EV bets).
- **Proof.** Closing line value (CLV): whether our flagged price beats the final line. It shows up within weeks, unlike win/loss, which needs hundreds of results.
- **Product.** A curated daily list of edges for regular bettors, not power users: "the 3–5 best edges today", each with plain-English reasoning and which book to bet at. This avoids competing head-on with the broad scanners (OddsJam and similar, ~$100–200/mo).
- **Price.** About $19/month subscription.
- **Delivery.** Email alerts the moment an edge is found, plus a live web feed.
- **Free vs. paid.** Subscribers get every edge live. Publicly: one live edge per day (X + email), and every other edge posted after its game with the result and closing line, so the full record can be checked by anyone.
- **Affiliate fit.** +EV betting needs accounts at several sportsbooks, so tracked sign-up links (DraftKings, FanDuel, etc.) belong naturally in the product.

## Scope decisions

- **Sports/data:** NFL, NCAAF, NBA game lines (spreads, totals, moneylines); US books plus Pinnacle (Odds API `us` + `eu` regions); **staying on The Odds API free 500-credit plan (owner decision 2026-09-23)**: a daily discovery scan plus closing scans only for games with logged edges, behind a credit reserve that protects the AI pipeline. See the edge logger spec. Props and more sports only after the edge is proven.
  - Known consequence: until the NBA starts (~2026-10-20), Mon–Wed will usually have no edges, so launch messaging should focus on weekend edges.
- **Launch gate:** subscriptions go on sale only after a public proof period of ~3–4 weeks or 100+ edges with average CLV of about +1% or better. If CLV is not positive, tune thresholds or rethink before spending on marketing.
- **Current AI-picks pipeline:** keeps running as-is for X content. Only the same-game contradiction guard gets added. AI picks will not be graded; grading/CLV is built for edges. Retire AI generation and pay-per-pick when the edge product launches.

## Spike result (2026-09-23): edges on game lines are rare

One live snapshot (Wednesday; 103 upcoming NFL/NCAAF games, 74 with Pinnacle lines, ~1,600 comparisons against 9 US books):
- Proportional margin removal flagged 51 edges ≥2%, 50 of them longshot moneylines. That's the known favorite-longshot artifact, not real edge.
- Power and Shin methods: 3–4 edges ≥2%; only **2** that both agree on (a +310 NFL moneyline and a +550 NCAAF moneyline).
- Spreads/totals: **zero** edges at 1% or more. US books post a different number from Pinnacle on 59% of spread/total outcomes, so a fuller engine would need alternate-line pricing.
- The Odds API key is on the free 500-credit plan (322 credits left after the spike). The owner chose to stay on it, so the pipeline was trimmed (odds cache + 3-day window, ~80 → ~33 credits per game day) and the logger was redesigned around kickoff-timed scans.

Decision: before building subscriptions or marketing, build a **minimal edge logger** (Shin method, daily discovery + closing scans, free-tier budget, closing-line capture) and run it for 2–3 weekends to measure real edge volume and CLV. If volume is too thin, next options are props (more data spend) or leaning on media + affiliate.

## Sub-projects, in order

1. **Edge engine:** Pinnacle + US books ingestion, fair-price calculation, +EV detection with thresholds, capturing the closing line, edge storage. Replaces AI generation as the content source.
2. **Proof layer:** result grading (ESPN public scoreboard, which is free and keeps history; see the 2026-09-23 grading design in chat history) plus CLV, shown on a public record page.
3. **Distribution engine:** automated X posts (1 live edge/day + delayed recaps), an email list with alerts, tracked affiliate links.
4. **Subscription product:** Stripe subscriptions, members' live feed plus instant email alerts. Launches only after the proof gate passes.
5. **Business setup (owner):** legal entity, affiliate program applications, real Terms/Privacy details plus attorney review.

## Immediate (before Thursday 2026-09-24 13:00 UTC)

- Ship the same-game contradiction guard in `generateForSlot`: at most one spread, one moneyline and one total per game across all existing PickSharp picks (not just today's), and the spread and moneyline must be on the same team.
