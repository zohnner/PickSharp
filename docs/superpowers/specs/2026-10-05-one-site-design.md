# One site: shared chrome, Worker-rendered home and tools index

Date: 2026-10-05. Status: approved in brainstorming, awaiting spec review.
Builds on: `2026-10-02-audience-capture-design.md` (the Worker-rendered odds and tool pages).

## Problem

The public site is two systems that look different:

- **React app** (Vite/Tailwind, served by `ASSETS`): `/`, `/record`, `/auth`, `/dashboard`, `/admin`,
  `/terms`, `/privacy`. Logo image, gold palette, 1152px (`max-w-6xl`) layout, a "Get edges free"
  button. Tools is hidden on phones.
- **Worker pages** (`worker/pages.js` `layout()`): `/odds`, game pages, both calculators. Plain-text
  brand, green links and buttons, a 760px column, no header CTA, and different footer text.

A visitor going from `/` to `/odds` crosses from one look to the other, which matters most the week
of the Show HN post. Also, Tools links straight to the no-vig calculator because there is no tools
page, and `/` is client-rendered, which is weak for SEO.

## Decisions made in brainstorming

1. **Scope:** one consistent header, nav, footer, logo and gold palette across both systems, plus a
   `/tools` page and a nav that works on phones. The /odds and game-page UX overhaul waits for real
   snapshot data.
2. **Accounts are hidden from the public nav.** The nav is Odds, Tools, Record and "Get edges free".
   `/auth`, `/dashboard` and `/admin` are reached by URL.
3. **Approach:** move `/` and the new `/tools` to the Worker so the whole public funnel (`/`, `/odds`,
   game pages, `/tools`, both calculators) uses one `layout()`, and have a shared data module feed
   both the Worker layout and the React `Nav`/`Footer`. `/record` moves to the Worker in a follow-up
   spec. Rejected: shared data with no page moves (leaves `/` client-rendered, and the two headers
   can drift in layout), and having the Worker inject a header into the SPA shell (every SPA load runs
   through HTMLRewriter, and local Vite dev loses the header).
4. **Timing:** ship before the Show HN post, after `/odds` is confirmed with real data from the
   Tue Oct 6 scan.

## Constraints

- Workers free plan: 10ms CPU per request. Pages stay plain string builders.
- Public numbers are core edges only. The new pages cite no figures at all.
- The Terms of Service content is the owner's to-do and is not touched.

## 1. Shared module: `shared/site.js`

Plain data, no markup:

- `NAV`: `[{ key: 'odds', label: 'Odds', href: '/odds' }, { key: 'tools', label: 'Tools', href: '/tools' }, { key: 'record', label: 'Record', href: '/record' }]`
- `CTA_LABEL`: `'Get edges free'`
- `FOOTER`: `disclaimer` (the current React footer paragraph, verbatim), `helpline`
  (`{ label: '1-800-GAMBLER', tel: '1-800-522-4700' }`), `eligibility` (`'Must be 21+ and located in a
  jurisdiction where sports betting is legal.'`), `links` (`[{ label: 'Terms of Service', href: '/terms' },
  { label: 'Privacy Policy', href: '/privacy' }]`).
- `COLORS`: `sharp` (the current palette from `tailwind.config.js`, moved here) and `gradient`
  (`['#f3dd8f', '#c6971f', '#8a6a17']`, hover `['#f7e6a8', '#d4a72e', '#9c7818']`).

Readers:

- `worker/pages.js` builds the header, footer and CSS colors from it.
- `src/components/Nav.jsx` and `src/components/Footer.jsx` map over `NAV` and `FOOTER`.
- `tailwind.config.js` imports `COLORS.sharp`.

Vite, Tailwind and wrangler's esbuild all resolve this relative import. `npm run build` and the
wrangler dry run confirm it.

## 2. Routing

- `wrangler.toml` `run_worker_first` gains `"/"` and `"/tools"` (`/tools/*` may not match the bare
  path).
- `worker/site.js`: `isSitePath` adds exact `/` and `/tools`. `handleSite` adds `renderHome` and
  `renderToolsIndex` branches, with no D1 reads.
- `src/App.jsx`: the `Landing` import and the `/` route are removed, with no replacement. (A
  `window.location.replace('/')` safety-net route would reload forever under local `vite` dev.)
  Instead, the one client-side `<Link to="/">` (`AdminPanel`'s "Back to home") becomes `<a href="/">`,
  and a test bans `to="/"` anywhere in `src/`.
- `src/pages/Landing.jsx` is deleted, and so is `src/components/EmailCapture.jsx` (Landing is its
  only user). `subscribeEmail` in `src/lib/api.js` is deleted too if nothing else imports it.
  `/api/subscribe` itself is unchanged; the Worker form already posts to it.
- `src/components/Nav.jsx`: every link is a plain `<a>` (full page load). The session-dependent
  Dashboard and Log out links are removed. `Nav` no longer takes `session`.
- `/index.html` is still served by `ASSETS` as the SPA shell. Nothing links to it; it is left alone.

**Risk to verify:** that `"/"` in `run_worker_first` matches only the root path. Checked in
`wrangler dev` (see section 6), since a unit test can't prove it.

## 3. Shared header, footer and palette

**Header** (same structure in both systems):

- `/logo-white.png` (1591×682) linking to `/`: 32px tall on phones, 44px from 640px.
- Odds, Tools, Record links, then the gold-gradient "Get edges free" button with `#171717` text.
- Full-width bar with a `#262626` bottom border; content in a 1152px container with 16px side
  padding.
- **Phones (below 520px): two rows.** Row 1: logo left, CTA right. Row 2: the three links, spread
  evenly, slightly smaller. Done with `flex-wrap` and `order`, no JS. At 360px a single row needs
  roughly 75 + 125 + 105px plus gaps against 328px usable, too tight to trust when we can't screenshot
  below ~500px.
- **CTA target:** `#signup` on pages that have a signup form, `/#signup` otherwise. `layout()` takes
  `hasSignup` (default `true`); every current Worker page has a form. React `Nav` always uses
  `/#signup`.
- **Active link** shown in gold: `layout()` takes `active` (`'odds' | 'tools' | null`); React `Nav`
  marks Record when `location.pathname === '/record'`.

**Footer** (same text in both systems), in the 1152px container, neutral-500 (`#737373`) small text:

1. The disclaimer paragraph.
2. "Gambling problem? Call 1-800-GAMBLER" (a `tel:` link), then the eligibility line.
3. "© {year} PickSharp. All rights reserved. · Terms of Service · Privacy Policy".

The Worker's old footer line "Prices are a daily snapshot and can move; confirm at the book before
betting." moves into the body of `/odds` and game pages, under the "Prices as of" line.

**Worker CSS:**

- All green goes: links `#d4a72e` with underline on hover; `.signup button` gets the gradient and
  `#171717` text; `.ok` becomes `#d4a72e`.
- Backgrounds and borders already match Tailwind's neutral scale and stay.
- The amber `.edge` rows on game pages stay (part of the later /odds UX work).
- Body content stays in the 760px column. Header, footer and the home page use 1152px.

**Head:** `layout()` adds `og:title`, `og:description` and `og:url` (escaped) to every page. No
`og:image` yet.

## 4. Home page: `renderHome()`

Copy is ported verbatim from `Landing.jsx` (commit 77a61ea).

- **Hero** (centered): H1 "Find bets priced <gold>better than the market</gold>"; the 9-books /
  Pinnacle paragraph; buttons "See today's odds" (gold, `/odds`) and "View the record" (outline,
  `/record`); then `signupForm({ source: 'landing', returnTo: '/' })`, which carries `id="signup"`.
- **Three columns** on a `#171717` band: "Math, not opinions", "Proof, not promises", "Free tools"
  (links to both calculators). Stacked on phones, three across from 640px.
- **Trial section:** "Free during the public trial" and the 100-edge, +1% CLV bar paragraph.
- No stats or record figures.
- Title "PickSharp: find bets priced better than the market"; description from the hero paragraph;
  canonical `${siteUrl}/`; `active: null`.

Keeping `source: 'landing'` keeps the admin funnel's existing signups-by-source row continuous.

## 5. Tools index: `renderToolsIndex()`

- H1 "Free sports betting tools". One line: both tools use the same Shin no-vig method as our edge
  scan.
- Two cards linking to the calculators:
  - No-vig calculator: "Remove the vig from a two-way line and get fair odds and true win chance."
  - EV calculator: "Compare your odds to the fair odds and see expected value per bet."
- A link to `/odds`, then `signupForm({ source: 'tools_index', returnTo: '/tools' })`.
- `active: 'tools'` here and on both calculator pages; `active: 'odds'` on `/odds` and game pages.
- Added to the sitemap.

Both new pages go through the existing `html()` helper (5-minute edge cache).

## 6. Testing

Node `--test`, next to the existing 209 tests, which stay green.

- `worker/pages.test.js`:
  - `layout()` contains every `NAV` href, the CTA label, the logo `<img>`, the footer disclaimer,
    the `tel:` link, and no `#10b981` or `#34d399`.
  - `active` marks the right link; `hasSignup` switches the CTA between `#signup` and `/#signup`.
  - `og:` tags present and escaped.
  - `renderHome`: the H1, `/odds` and `/record` buttons, a signup form with `source` `landing` and
    `return_to` `/`.
  - `renderToolsIndex`: links to both calculators, `source` `tools_index`.
- `worker/site.test.js`: `isSitePath` is true for `/` and `/tools` and false for `/record`, `/auth`,
  `/admin`; `handleSite` returns 200 HTML for `/` and `/tools`; the sitemap includes `/tools`.
- `worker/shared-site.test.js` (inside the existing `worker/**/*.test.js` glob): `NAV` entries are
  well formed; the sources of `src/components/Nav.jsx` and `Footer.jsx` import `shared/site` and
  contain no hardcoded `/odds`, `/tools` or `/record` hrefs; the `tailwind.config.js` source imports
  the shared palette. (The repo has no jsdom or React Testing Library; this source-level check avoids
  adding test tooling launch week.)

**Manual, before deploy:**

1. `npm test`, `npm run build`, `npx wrangler deploy --dry-run --outdir $TEMP/ps-dry`.
2. In `wrangler dev`: `/` and `/tools` come from the Worker (no `id="root"`); `/record`, `/auth` and
   `/admin` still serve the SPA; `/picks` still ends on `/odds`; the home signup form returns to
   `/?subscribed=1#signup`.
3. Desktop screenshots of `/`, `/odds`, a calculator, `/tools` and `/record` to compare chrome. The
   two-row header checked at a 500px viewport, and the CSS logic checked in review.

## 7. Rollout

- Branch `one-site`. G-Unit builds from the plan; Claude reviews (APPROVE / CHANGES REQUESTED).
- Merge after `/odds` is confirmed with real data from the Tue Oct 6 scan. The owner deploys Tue
  evening; one `npx wrangler deploy` ships the Worker, the `run_worker_first` change and `dist/`
  together.
- After deploy: `curl -s https://<site>/ | grep -c 'id="root"'` prints 0, and one click-through of
  the nav on a real phone.
- Rollback: revert the merge commit and redeploy. No schema or data change.

## Out of scope

`/record` on the Worker (next spec), the /odds and game-page UX overhaul, `og:image`, the Terms of
Service rewrite, and account links in the nav.
