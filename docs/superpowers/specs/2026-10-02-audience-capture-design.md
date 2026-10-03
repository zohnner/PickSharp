# Audience capture: odds pages, edge email, X price gaps, reply kit

Date: 2026-10-02. Status: approved in brainstorming, awaiting spec review.
Parent strategy: `2026-09-23-profitability-strategy-design.md` (distribution step of the build order).

## Problem

Since launch PickSharp has had 5 X-referred visitors, 1 user (the owner), 2 affiliate clicks, 0 email
signups and $0 revenue. Football season is when people look for betting help, but the X account has
almost no reach. The paid product can't launch until the CLV gate clears, and the DraftKings affiliate
application is still pending.

## Constraints

- $0 acquisition budget. The owner has ~2 hours a week, so everything else must be automated.
- Odds API: free 500-credit plan, no upgrade. This feature must spend **0 extra credits**.
- Cloudflare Workers free plan: 10ms CPU per invocation, 50 D1 queries per invocation, 5 cron triggers
  per account (both crons are already in use; new jobs must ride the existing `1,6,...,56` tick).
- X API is pay-per-use: $0.015 per post, $0.20 with a link. Manual posts from the X app are free.
- Resend free plan: 100 emails/day.
- Never fabricate records or impersonate anyone. Never hide losing results.

## Goal and success measure

Build an email list of bettors who care about price. The list is where revenue comes from later
(affiliate once approved, the paid product once the gate clears).
**Checkpoint 4 weeks after deploy:** signups per week, by source. That decides where the owner's
2 hours go next.

## Decisions made in brainstorming

1. **Approach:** A (search-indexable odds pages and free calculators) + B (a daily X post and a
   manual reply kit), feeding one email list. Reddit is out.
2. **Edges on public pages are hidden behind a teaser.** A side whose best price beats the fair price
   shows "Edge found on this game. Get it free by email" with a signup form, instead of the price.
   It's revealed after kickoff, with its result.
3. **Pre-launch email offer:** every core edge, free, "during our public trial". It replaces the daily
   AI free-pick email. Subscribers are told before the paid launch and offered a founding-member price.

## 1. Odds snapshot (data)

- **Built by:** the 16:01 UTC discovery scan (`worker/edgeScan.js`), from the events it already
  fetched. No new Odds API requests.
- **New pure module** `worker/oddsSnapshot.js`: `buildSnapshot(events, nowMs)` returns, per game:
  `event_id`, `sport`, `game`, `home_team`, `away_team`, `commence_time`, `slug`, and per market
  (`h2h`, `spreads`, `totals`) per side: `point`, `best_price`, `best_book`, `worst_price`,
  `worst_book`, `fair_prob` (Pinnacle margin removed with `shinFairProbs` from `worker/devig.js`, the
  same method as the edges; `null` when Pinnacle has no line), and `is_edge`. `is_edge` is
  `isCoreEdge(best_price * fair_prob - 1, market, best_price)` (the core rule in
  `worker/coreEdge.js`), and is `false` when `fair_prob` is `null`. So the teaser hides exactly the
  sides the email sends. Only US books count for best and worst; Pinnacle is the reference only.
- **Slug:** `<away-mascot>-at-<home-mascot>-<YYYY-MM-DD ET>`, e.g. `jaguars-at-bengals-2026-10-04`.
  If two games collide (college teams can share a mascot), the second gets the school name.
- **Storage:** new table `odds_snapshots (sport TEXT, snapshot_date TEXT /* ET YYYY-MM-DD */,
  taken_at TEXT, payload TEXT /* JSON */, PRIMARY KEY (sport, snapshot_date))`. One upsert per sport
  per day (2–3 writes), plus one `DELETE` of rows older than 14 days. Budget for the 16:01 invocation:
  up to ~35 edge queries (15 upserts + 15 closes + selects) + ~5 for `handleDailyPostCheck` + 4 for the
  snapshot = ~44 of 50. If edge writes ever need more, the snapshot moves to the 16:06 tick (it can
  read the events back only if they're cached, so check this during planning).
- **Prices are a daily snapshot, not live.** Every surface shows "Prices as of <time> ET".
- **CPU risk:** add a test that builds a snapshot from a full Saturday fixture (~60 NCAAF + 16 NFL
  games) and checks it runs well under budget. If it doesn't, write one sport per tick.

## 2. Public pages (rendered by the Worker)

- `wrangler.toml` `run_worker_first` gains `/odds*`, `/tools/*`, `/sitemap.xml` and `/robots.txt`.
  These routes return complete HTML from the Worker, so search engines don't need to run React.
- **New module** `worker/pages.js` holds a pure `layout({ title, description, canonical, body })` and
  one render function per page. Every page has the site's colors, a header linking to `/record` and
  `/picks`, a footer with "21+ · Gambling problem? Call 1-800-GAMBLER", and the Cloudflare Web
  Analytics snippet when `CF_ANALYTICS_TOKEN` is set.
- **`/odds`:** today's and upcoming snapshot games grouped by sport and kickoff (ET), with
  "N edges found today. Get them free by email." and the signup form.
- **`/odds/:sport/:slug`** (`nfl` | `ncaaf`, and later `nba`):
  - `<title>`: "<Away> vs <Home> odds: best line & fair price (<Mon D>)". A meta description and a
    canonical URL.
  - One table per market: side | best price (book) | worst price (book) | fair price (American).
  - **Before kickoff**, `is_edge` sides show the teaser and an inline form instead of the prices.
  - **After kickoff**, the page shows the final score from `game_results` when graded, and reveals
    the logged edges for that game with their result and CLV, using the same logic as `/record`.
  - An unknown slug returns 404. A slug whose snapshot was pruned returns 410.
- **`/tools/no-vig-calculator`:** enter two-way American odds; it shows the fair odds for each side
  and the bookmaker's margin. **`/tools/ev-calculator`:** enter your odds and a fair price or
  probability; it shows EV%. Both use a few lines of inline JS that port the same Shin math, with a
  shared test vector so the JS and the Worker agree. Each has a short how-to paragraph (the content
  that ranks) and the signup form.
- **Signup form:** a plain HTML form posting to the existing `/api/subscribe` with
  `source = game_page | odds_index | tool`. It works without JS. A redirect, or JSON when JS is
  present, confirms it.
- **`/sitemap.xml`:** the tools, `/odds`, `/record`, and game pages from the last 14 days.
  **`/robots.txt`:** allow everything except `/api`, `/admin` and `/dashboard`, and point to the
  sitemap.

## 3. Daily edge email (replaces the AI free-pick email)

- **When:** on the 16:06 UTC tick (the same tick as the free X edge), if today's discovery logged at
  least one new core edge (`first_seen_at` today, core, kicking off in the future). The existing
  once-a-day guard (`daily_emails`) still applies.
- **Content:** subject "N edges today: <best one in short>". For each edge: bet, book, price, fair
  price, EV%, kickoff in ET. Framing: "Free during our public trial. Every edge is tracked with its
  result and closing line at /record." Then the existing unsubscribe link and postal address.
- **Code:** `composeEdgeEmail(edges, opts)` in `worker/email.js`, sent through the existing
  `sendToList`. The AI pick slot stops calling `sendDailyEmail` (the X AI posts are unchanged). The
  weekly recap email is unchanged.
- **Limits:** usage is already logged to `api_usage`, and the existing 80% alert covers Resend's
  100/day.

## 4. X price-gap post

- **When:** on the 16:11 UTC tick, on days when the snapshot has games kicking off within 36h.
- **Content:** the 3 largest best-vs-worst gaps on the *same* bet (same market, side and point),
  ranked by implied-probability difference, with a minimum of 15 cents
  (e.g. −125 vs −145). Example: "Same bet, different price 👇 Bengals ML: −125 FanDuel / −145 BetMGM
  ...". No fair price (so no edges leak), no link ("link in bio"). The text is built and
  length-checked like `composeFreeEdgeTweet`.
- **Guards:** once per day (a new `price_gap_posts` table), posting respects `POSTING_PAUSED`, and
  usage is logged as `x_post`. Nothing qualifying means no post.
- **Cost:** ~$0.015 a post, under $0.50 a month.

## 5. Reply kit (admin)

- `GET /api/admin/reply-kit` (admin only) returns today's snapshot games, each with 1–2 ready-to-paste
  reply lines, e.g. "Best price on Bengals −2.5 today is −105 at ESPN BET (worst −118). Full board:
  wepicksharp.com/odds/nfl/<slug>?src=x_reply". Edge sides are never included, to match the pages.
- The admin panel gets a "Reply kit" section with copy buttons.
- **The guide** `docs/reply-kit.md`: reply in game-day threads of large NFL/CFB and betting accounts;
  give the number first; answer the thread's actual question; about 15 replies a session; never paste
  the same text twice; never reply to minors or to people in distress about gambling.

## 6. Attribution and measurement

- Links carry `?src=` (`x_reply`, `x_post`, `game_page`, `odds_index`, `tool`, `email`). The pages
  pass `src` through to the form's `source`, so `email_signups.source` records the first-touch channel.
- The admin funnel adds "signups by source, last 7 / 28 days".
- **Page views:** Cloudflare Web Analytics (free, cookieless). The owner turns it on and sets
  `CF_ANALYTICS_TOKEN`.

## Owner actions

1. Google Search Console: verify `wepicksharp.com` (done 2026-10-02), then submit
   `https://wepicksharp.com/sitemap.xml` after deploy.
2. Turn on Cloudflare Web Analytics and set `CF_ANALYTICS_TOKEN`.
3. Deploy (`npx wrangler deploy`) and apply the `odds_snapshots` and `price_gap_posts` migrations
   to the remote D1.
4. ~2 hours a week using the reply kit.

## Out of scope

Paid acquisition, Reddit, live (intraday) prices, NBA game pages before the NBA joins discovery
(they come automatically once it does), player props, and accounts or logins for subscribers.

## Testing

Unit tests (node:test, like the existing ones): snapshot building (best and worst, US books only, fair
price, `is_edge` agreeing with `isCoreEdge`, slug collisions), the CPU fixture, page rendering
(teaser before kickoff and reveal after, 404 and 410, escaping of team names, sitemap contents), the
calculator math test vector, edge email composition, gap selection (the same-bet rule, the 15-cent
minimum, tweet length), reply-kit lines that exclude edge sides, and `src` making it through to the
signup source. Then the full test suite and `vite build`.
