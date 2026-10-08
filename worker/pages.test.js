import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, fmtAmerican, signupSource, signupForm, renderGamePage, renderOddsIndex, layout } from './pages.js';
import { CALC_JS, renderNoVigCalculator, renderEvCalculator, renderSitemap, robotsTxt } from './pages.js';
import { shinFairProbs } from './devig.js';
import { NAV, CTA_LABEL, FOOTER } from '../shared/site.js';

const side = (o) => ({ outcome: 'Cincinnati Bengals', point: -2.5, best_price: 2.1, best_book: 'fanduel', worst_price: 1.87, worst_book: 'draftkings', books: 2, fair_prob: 0.5, is_edge: false, ...o });
const game = {
  event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z',
  slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04',
  markets: {
    spreads: [side({ is_edge: true }), side({ outcome: 'Jacksonville Jaguars', point: 2.5, best_price: 1.9, best_book: 'draftkings', worst_price: 1.8, worst_book: 'fanduel' })],
    totals: [side({ outcome: 'Over', point: 47.5, best_price: 1.93, best_book: 'draftkings', fair_prob: 0.5236 })],
  },
};
const BEFORE = Date.parse('2026-10-02T17:00:00Z');
const AFTER = Date.parse('2026-10-04T21:00:00Z');
const base = { game, takenAt: '2026-10-02T16:01:00.000Z', source: 'game_page', siteUrl: 'https://wepicksharp.com' };

test('escaping and odds formatting', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(fmtAmerican(2.1), '+110');
  assert.equal(fmtAmerican(1.87), '-115');
  assert.equal(fmtAmerican(null), '—');
});

test('signup source takes a valid ?src, otherwise the page default', () => {
  assert.equal(signupSource('x_reply', 'game_page'), 'x_reply');
  assert.equal(signupSource('<script>', 'game_page'), 'game_page');
  assert.equal(signupSource(null, 'tool'), 'tool');
});

test('signup form posts the source and return path, and thanks a subscriber instead', () => {
  const f = signupForm({ source: 'x_reply', returnTo: '/odds', cta: 'Get edges' });
  assert.match(f, /method="post" action="\/api\/subscribe"/);
  assert.match(f, /name="source" value="x_reply"/);
  assert.match(f, /name="return_to" value="\/odds"/);
  assert.match(signupForm({ source: 'tool', returnTo: '/', subscribed: true }), /on the list/);
  assert.match(signupForm({ source: 'tool', returnTo: '/', error: true, cta: 'x' }), /didn't look right/);
});

test('game page before kickoff: title, prices, fair price, and edge sides hidden behind the teaser', () => {
  const html = renderGamePage({ ...base, nowMs: BEFORE });
  assert.match(html, /<title>Jacksonville Jaguars vs Cincinnati Bengals odds: best line &amp; fair price \(Oct 4\)<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/wepicksharp.com\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04"/);
  assert.match(html, /Prices as of 12:01 PM ET/);
  assert.match(html, /Jacksonville Jaguars \+2.5/);
  assert.match(html, /-111 <span class="book">DraftKings<\/span>/);
  // The edge side shows the teaser, never its price.
  assert.match(html, /Edge found on this side/);
  assert.doesNotMatch(html, /\+110 <span class="book">FanDuel/);
  assert.match(html, /1-800-GAMBLER/);
});

test('game page after kickoff reveals prices and our logged edges with results', () => {
  const revealed = [{ selection: 'Cincinnati Bengals -2.5', book: 'FanDuel', odds: 110, ev: 0.05, grade: 'win', clv: 0.021, clvEstimated: false }];
  const html = renderGamePage({ ...base, nowMs: AFTER, revealed, score: '17-24' });
  assert.doesNotMatch(html, /Edge found on this side/);
  assert.match(html, /\+110 <span class="book">FanDuel/);
  assert.match(html, /Final: Jacksonville Jaguars 17, Cincinnati Bengals 24/);
  assert.match(html, /Cincinnati Bengals -2.5 at FanDuel \+110 · 5.0% edge · WIN · CLV \+2.1%/);
});

test('team names from the feed are escaped', () => {
  const evil = { ...game, away_team: '<img src=x>', game: '<img src=x> @ Cincinnati Bengals' };
  assert.doesNotMatch(renderGamePage({ ...base, game: evil, nowMs: BEFORE }), /<img src=x>/);
});

test('odds index lists upcoming games by sport and counts today\'s edges', () => {
  const html = renderOddsIndex({ games: [game], takenAt: base.takenAt, nowMs: BEFORE, source: 'odds_index', siteUrl: base.siteUrl });
  assert.match(html, /href="\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04"/);
  assert.match(html, /<h2>NFL<\/h2>/);
  assert.match(html, /1 edge found today/);
});

const calc = new Function(`${CALC_JS}; return { toDecimal, toAmerican, shinFair };`)();

test('the browser calculator math matches the engine', () => {
  assert.equal(calc.toDecimal(-110), 1 + 100 / 110);
  assert.equal(calc.toDecimal(150), 2.5);
  assert.equal(calc.toAmerican(2.5), 150);
  assert.equal(calc.toAmerican(1.5), -200);
  for (const pair of [[1.91, 1.91], [1.5, 2.7], [1.2, 5.5], [3.2, 1.38]]) {
    const js = calc.shinFair(pair);
    const engine = shinFairProbs(pair);
    assert.ok(Math.abs(js[0] - engine[0]) < 1e-9 && Math.abs(js[1] - engine[1]) < 1e-9, String(pair));
  }
  assert.equal(calc.shinFair([1.9, 2.2]), null); // no margin to remove
});

test('calculator pages carry the script, a how-to, and the signup form', () => {
  const nv = renderNoVigCalculator({ source: 'tool', siteUrl: 'https://wepicksharp.com' });
  assert.match(nv, /<title>No-vig fair odds calculator/);
  assert.match(nv, /function shinFair/);
  assert.match(nv, /name="source" value="tool"/);
  const ev = renderEvCalculator({ source: 'tool', siteUrl: 'https://wepicksharp.com' });
  assert.match(ev, /<title>Expected value \(EV\) betting calculator/);
});

test('sitemap and robots', () => {
  const xml = renderSitemap('https://wepicksharp.com', [{ path: '/odds', lastmod: '2026-10-02' }, { path: '/tools/ev-calculator' }]);
  assert.match(xml, /<loc>https:\/\/wepicksharp.com\/odds<\/loc><lastmod>2026-10-02<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/wepicksharp.com\/tools\/ev-calculator<\/loc>/);
  const robots = robotsTxt('https://wepicksharp.com');
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/wepicksharp.com\/sitemap.xml/);
});

const page = (o = {}) => layout({ title: 'T', description: 'D', canonical: 'https://wepicksharp.com/x', body: '<p>b</p>', ...o });

test('layout renders the shared header and footer, in gold', () => {
  const html = page();
  for (const n of NAV) assert.match(html, new RegExp(`<a href="${n.href}"`), n.key);
  assert.match(html, new RegExp(`>${CTA_LABEL}</a>`));
  assert.match(html, /<img src="\/logo-white.png" alt="PickSharp"/);
  assert.ok(html.includes(escapeHtml(FOOTER.disclaimer)), 'disclaimer');
  assert.match(html, /href="tel:1-800-522-4700">1-800-GAMBLER<\/a>/);
  assert.ok(html.includes(FOOTER.eligibility), 'eligibility');
  assert.match(html, /<a href="\/terms">Terms of Service<\/a>/);
  assert.doesNotMatch(html, /#10b981|#34d399/i);
});

test('layout marks the active section and points the CTA at the right form', () => {
  assert.match(page({ active: 'odds' }), /<a href="\/odds" class="on" aria-current="page">/);
  assert.doesNotMatch(page({ active: null }), /aria-current/);
  assert.match(page(), /class="btn cta" href="#signup"/);
  assert.match(page({ hasSignup: false }), /class="btn cta" href="\/#signup"/);
  assert.match(page({ wide: true }), /<main class="wide">/);
  assert.match(page(), /<main>/);
});

test('layout adds escaped Open Graph tags', () => {
  const html = page({ title: 'A & "B"', description: '<d>' });
  assert.match(html, /<meta property="og:title" content="A &amp; &quot;B&quot;">/);
  assert.match(html, /<meta property="og:description" content="&lt;d&gt;">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/wepicksharp.com\/x">/);
});

test('odds pages carry the snapshot note and mark Odds active; calculators mark Tools', () => {
  const g = renderGamePage({ ...base, nowMs: BEFORE });
  assert.match(g, /daily snapshot and can move/);
  assert.match(g, /<a href="\/odds" class="on"/);
  const idx = renderOddsIndex({ games: [game], takenAt: base.takenAt, nowMs: BEFORE, source: 'odds_index', siteUrl: base.siteUrl });
  assert.match(idx, /daily snapshot and can move/);
  assert.match(renderNoVigCalculator({ source: 'tool', siteUrl: base.siteUrl }), /<a href="\/tools" class="on"/);
  assert.match(renderEvCalculator({ source: 'tool', siteUrl: base.siteUrl }), /<a href="\/tools" class="on"/);
});
