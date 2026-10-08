// Server-rendered public pages: plain HTML so search engines index them without running
// React. Pure string builders -- site.js loads the data and picks the status code. Every
// value that came from a feed goes through escapeHtml.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { MARKETS, sportPath } from './oddsSnapshot.js';
import { NAV, CTA_LABEL, FOOTER, COLORS } from '../shared/site.js';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtAmerican(decimal) {
  const o = americanOdds(decimal);
  if (o == null) return '—';
  return o > 0 ? `+${o}` : `${o}`;
}

const bookName = (key) => BOOK_NAMES[key] || key;
const MARKET_TITLES = { spreads: 'Spread', totals: 'Total', h2h: 'Moneyline' };
const SPORT_LABELS = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'College football', basketball_nba: 'NBA' };
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const ET = 'America/New_York';
// Some ICU builds put a narrow no-break space before AM/PM; normalize it.
const timeEt = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET }).replace(/ /g, ' ');
const kickoffEt = (iso) =>
  `${new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: ET })}, ${timeEt(iso)} ET`;
const shortDateEt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET });

const SRC_PATTERN = /^[a-z0-9_-]{1,32}$/;
export function signupSource(src, fallback) {
  return typeof src === 'string' && SRC_PATTERN.test(src) ? src : fallback;
}

export function signupForm({ source, returnTo, subscribed = false, error = false, cta = 'Get every edge we find, free by email.' }) {
  if (subscribed) {
    return `<p class="ok" id="signup">✅ You're on the list. Each day's edges arrive by email after the noon ET scan.</p>`;
  }
  return `<form class="signup" id="signup" method="post" action="/api/subscribe">
  <p>${escapeHtml(cta)}</p>
  ${error ? `<p class="err">That email didn't look right. Try again?</p>` : ''}
  <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address">
  <input type="hidden" name="source" value="${escapeHtml(source)}">
  <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
  <button type="submit">Get edges free</button>
  <small>Free during our public trial. Unsubscribe anytime.</small>
</form>`;
}

const GOLD = COLORS.sharp[500];
const [G1, G2, G3] = COLORS.gradient;
const [H1, H2, H3] = COLORS.gradientHover;

// The header and footer match src/components/Nav.jsx and Footer.jsx: same 1152px container,
// same two-row header below 520px (logo + CTA, then the links), same gold.
const CSS = `body{margin:0;background:#0a0a0a;color:#e5e5e5;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1152px;margin:0 auto;padding:16px;box-sizing:border-box}
main{display:block;max-width:760px;margin:0 auto;padding:16px}main.wide{max-width:none;padding:0}
a{color:${GOLD};text-decoration:none}a:hover{text-decoration:underline}
.site-header{border-bottom:1px solid #262626}
.site-header .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}
.logo img{display:block;height:32px;width:auto}
.nav{display:flex;gap:24px;margin-left:auto}
.nav a{color:#a3a3a3;font-size:.875rem;font-weight:500}.nav a:hover,.nav a.on{color:${GOLD};text-decoration:none}
.btn,.signup button{display:inline-block;padding:8px 16px;border:0;border-radius:6px;background:linear-gradient(${G1},${G2},${G3});color:#171717;font-family:inherit;font-size:.875rem;font-weight:600;line-height:1.25;white-space:nowrap;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}
.btn:hover,.signup button:hover{background:linear-gradient(${H1},${H2},${H3});text-decoration:none}
@media(min-width:640px){.logo img{height:44px}}
@media(max-width:519px){.nav{order:3;width:100%;margin-left:0;justify-content:space-around;gap:0}.site-header .cta{margin-left:auto}}
h1{font-size:1.5rem;line-height:1.25}h2{font-size:1.15rem;margin-top:28px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:.95rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #262626}th{color:#a3a3a3;font-weight:500}
.book{color:#a3a3a3;font-size:.85em}.edge td{color:#fbbf24}.muted{color:#a3a3a3;font-size:.9rem}
.signup{margin:24px 0;padding:16px;border:1px solid #262626;border-radius:8px;background:#141414}
.signup input[type=email]{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5}
.signup button{padding:10px 16px}
.signup small{display:block;margin-top:8px;color:#a3a3a3}.ok{color:${GOLD}}.err{color:#f87171}
.calc label{display:block;margin:12px 0 4px}.calc input{padding:8px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5;width:140px}
.calc output{display:block;margin-top:12px;font-size:1.1rem}
.site-footer{border-top:1px solid #262626;margin-top:32px;color:#737373;font-size:.875rem}
.site-footer .wrap{padding:32px 16px}.site-footer p{margin:0 0 8px}
.site-footer a{color:inherit;text-decoration:underline}.site-footer a:hover{color:${GOLD}}
.site-footer .legal{display:flex;flex-wrap:wrap;gap:0 16px;margin-top:16px;color:#525252}
.hero{max-width:1152px;margin:0 auto;padding:64px 16px;box-sizing:border-box;text-align:center}
.hero h1{margin:0;color:#fff;font-size:2.25rem;font-weight:800;line-height:1.15;letter-spacing:-.025em}
.gold{color:${GOLD}}.lead{max-width:42rem;margin:16px auto 0;color:#a3a3a3;font-size:1.125rem}
.actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:32px}
.btn.lg{padding:12px 24px;font-size:1rem}
.btn-outline{display:inline-block;padding:12px 24px;border:1px solid #404040;border-radius:6px;color:#fff;font-weight:600}.btn-outline:hover{border-color:${GOLD};text-decoration:none}
.hero .signup{max-width:36rem;margin:32px auto 0;text-align:left}
.band{background:#171717}.cols{display:grid;gap:32px;padding:64px 16px}
.cols h3{margin:0;color:#fff;font-size:1.125rem}.cols p{color:#a3a3a3;font-size:.875rem}
.trial{max-width:56rem;margin:0 auto;padding:64px 16px;text-align:center}
.trial h2{margin:0;color:#fff;font-size:1.5rem}.trial p{max-width:42rem;margin:16px auto 0;color:#a3a3a3;font-size:.875rem}
.cards{display:grid;gap:16px;margin:24px 0}
.card{display:block;padding:16px;border:1px solid #262626;border-radius:8px;background:#141414;color:#e5e5e5}
.card:hover{border-color:${GOLD};text-decoration:none}.card strong{color:${GOLD}}
@media(min-width:640px){.hero h1{font-size:3rem}.cols{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:1fr 1fr}}`;

// One note for every page that shows snapshot prices. It used to sit in the footer.
const SNAPSHOT_NOTE = '<p class="muted">Prices are a daily snapshot and can move; confirm at the book before betting.</p>';

function header(active, hasSignup) {
  const links = NAV.map((n) =>
    n.key === active ? `<a href="${n.href}" class="on" aria-current="page">${n.label}</a>` : `<a href="${n.href}">${n.label}</a>`
  ).join('');
  return `<header class="site-header"><div class="wrap"><a class="logo" href="/"><img src="/logo-white.png" alt="PickSharp" width="1591" height="682"></a><nav class="nav" aria-label="Main">${links}</nav><a class="btn cta" href="${hasSignup ? '#signup' : '/#signup'}">${CTA_LABEL}</a></div></header>`;
}

function footer() {
  const links = FOOTER.links.map((l) => `<a href="${l.href}">${l.label}</a>`).join('');
  return `<footer class="site-footer"><div class="wrap"><p>${escapeHtml(FOOTER.disclaimer)}</p>
<p>Gambling problem? Call <a href="tel:${FOOTER.helpline.tel}">${FOOTER.helpline.label}</a>. ${FOOTER.eligibility}</p>
<p class="legal"><span>© ${new Date().getUTCFullYear()} PickSharp. All rights reserved.</span>${links}</p></div></footer>`;
}

// active: which NAV item to mark ('odds' | 'tools' | 'record' | null). hasSignup: the page has a
// signup form with id="signup", so the header CTA jumps to it instead of the home page's.
// wide: the page lays out its own full-width sections (the home page).
export function layout({ title, description, canonical, body, analyticsToken, active = null, hasSignup = true, wide = false }) {
  const analytics = analyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(analyticsToken)}"}'></script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:site_name" content="PickSharp">
<link rel="icon" href="/favicon-32.png">
<style>${CSS}</style>${analytics}</head>
<body>${header(active, hasSignup)}
<main${wide ? ' class="wide"' : ''}>${body}</main>
${footer()}</body></html>`;
}

function sideRow(market, side, started) {
  const label = escapeHtml(selectionLabel({ market, outcome: side.outcome, point: side.point }));
  if (side.is_edge && !started) {
    return `<tr class="edge"><td>${label}</td><td colspan="3">🔒 Edge found on this side. <a href="#signup">Get it free by email</a></td></tr>`;
  }
  const fair = side.fair_prob == null ? '—' : fmtAmerican(1 / side.fair_prob);
  return `<tr><td>${label}</td><td>${fmtAmerican(side.best_price)} <span class="book">${escapeHtml(bookName(side.best_book))}</span></td><td>${fmtAmerican(side.worst_price)} <span class="book">${escapeHtml(bookName(side.worst_book))}</span></td><td>${fair}</td></tr>`;
}

function marketTable(market, sides, started) {
  return `<h2>${MARKET_TITLES[market]}</h2>
<table><thead><tr><th>Bet</th><th>Best price</th><th>Worst price</th><th>Fair price</th></tr></thead>
<tbody>${sides.map((s) => sideRow(market, s, started)).join('')}</tbody></table>`;
}

function revealedList(revealed) {
  if (revealed.length === 0) return '';
  const items = revealed
    .map((e) => {
      const odds = e.odds > 0 ? `+${e.odds}` : `${e.odds}`;
      const clv = e.clv == null ? 'no close' : `CLV ${pct(e.clv)}${e.clvEstimated ? ' (est.)' : ''}`;
      return `<li>${escapeHtml(e.selection)} at ${escapeHtml(e.book)} ${odds} · ${(e.ev * 100).toFixed(1)}% edge · ${escapeHtml(String(e.grade).toUpperCase())} · ${clv}</li>`;
    })
    .join('');
  return `<h2>Our logged edges on this game</h2><ul>${items}</ul><p class="muted">Every edge we log is graded on <a href="/record">our public record</a>, wins and losses.</p>`;
}

// opts: { game, takenAt, nowMs, revealed?, score? ('away-home'), source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderGamePage({ game, takenAt, nowMs, revealed = [], score = null, source, subscribed, error, siteUrl, analyticsToken }) {
  const started = Date.parse(game.commence_time) <= nowMs;
  const path = `/odds/${sportPath(game.sport)}/${game.slug}`;
  const matchup = `${game.away_team} vs ${game.home_team}`;
  const tables = MARKETS.filter((m) => game.markets[m]?.length).map((m) => marketTable(m, game.markets[m], started)).join('');
  const [away, home] = score ? score.split('-') : [];
  const body = `<h1>${escapeHtml(matchup)} odds</h1>
<p class="muted">${escapeHtml(SPORT_LABELS[game.sport] || '')} · Kickoff ${kickoffEt(game.commence_time)} · Prices as of ${timeEt(takenAt)} ET</p>
${SNAPSHOT_NOTE}
${score ? `<p><strong>Final: ${escapeHtml(game.away_team)} ${escapeHtml(away)}, ${escapeHtml(game.home_team)} ${escapeHtml(home)}</strong></p>` : ''}
<p>The best and worst price across US sportsbooks for each bet, next to the fair price: Pinnacle's line with the bookmaker's margin removed. A price better than fair is an edge.</p>
${tables || '<p>No lines posted yet.</p>'}
${started ? revealedList(revealed) : ''}
${signupForm({ source, returnTo: path, subscribed, error, cta: started ? 'Get the next edges free by email.' : 'Get every edge we find, free by email, before kickoff.' })}`;
  return layout({
    title: `${matchup} odds: best line & fair price (${shortDateEt(game.commence_time)})`,
    description: `${matchup} odds compared across DraftKings, FanDuel, BetMGM, Caesars and more, with the no-vig fair price for the spread, total and moneyline.`,
    canonical: `${siteUrl}${path}`,
    body,
    analyticsToken,
    active: 'odds',
  });
}

// opts: { games, takenAt, nowMs, source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderOddsIndex({ games, takenAt, nowMs, source, subscribed, error, siteUrl, analyticsToken }) {
  const upcoming = games.filter((g) => Date.parse(g.commence_time) > nowMs);
  const edgeCount = upcoming.reduce((n, g) => n + Object.values(g.markets).flat().filter((s) => s.is_edge).length, 0);
  const bySport = new Map();
  for (const g of upcoming) bySport.set(g.sport, [...(bySport.get(g.sport) || []), g]);
  const sections = [...bySport]
    .map(([sport, list]) => `<h2>${escapeHtml(SPORT_LABELS[sport] || sport)}</h2><table><tbody>${list
      .map((g) => `<tr><td><a href="/odds/${sportPath(g.sport)}/${g.slug}">${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}</a></td><td class="muted">${kickoffEt(g.commence_time)}</td></tr>`)
      .join('')}</tbody></table>`)
    .join('');
  const body = `<h1>Football odds: best lines and fair prices</h1>
<p class="muted">${takenAt ? `Prices as of ${timeEt(takenAt)} ET, ${shortDateEt(takenAt)}` : 'Prices update daily around noon ET'}</p>
${SNAPSHOT_NOTE}
<p><strong>${edgeCount} edge${edgeCount === 1 ? '' : 's'} found today.</strong> Each one is a price better than fair at a US book.</p>
${signupForm({ source, returnTo: '/odds', subscribed, error, cta: 'Get them free by email.' })}
${sections || '<p>No upcoming games in today\'s scan.</p>'}`;
  return layout({
    title: 'NFL & college football odds: best lines and fair prices today',
    description: 'Compare NFL and college football odds across US sportsbooks, with the no-vig fair price for every spread, total and moneyline.',
    canonical: `${siteUrl}/odds`,
    body,
    analyticsToken,
    active: 'odds',
  });
}

// Browser copy of the engine's math (devig.js shinFairProbs). pages.test.js checks the two
// agree, so the calculator never shows a different fair price than the edges use.
export const CALC_JS = `
function toDecimal(a){a=Number(a);if(!isFinite(a)||(a>-100&&a<100))return null;return a>0?1+a/100:1+100/-a}
function toAmerican(d){if(!(d>1))return null;return d>=2?Math.round((d-1)*100):-Math.round(100/(d-1))}
function shinFair(prices){
  if(!prices||prices.length!==2||prices.some(function(p){return !(p>1)}))return null;
  var x=[1/prices[0],1/prices[1]],s=x[0]+x[1];if(s<=1)return null;
  function at(z){return x.map(function(v){return(Math.sqrt(z*z+4*(1-z)*v*v/s)-z)/(2*(1-z))})}
  var lo=0,hi=0.999;for(var i=0;i<100;i++){var m=(lo+hi)/2;if(m===lo||m===hi)break;var p=at(m);if(p[0]+p[1]>1)lo=m;else hi=m}
  var r=at(lo),t=r[0]+r[1];if(Math.abs(t-1)>1e-9)return null;return[r[0]/t,r[1]/t]}
function fmtA(a){return a==null?'—':(a>0?'+'+a:String(a))}`;

const NO_VIG_UI = `
function run(){var a=toDecimal(document.getElementById('a').value),b=toDecimal(document.getElementById('b').value),out=document.getElementById('out');
if(!a||!b){out.textContent='Enter both sides as American odds, e.g. -110 and -110.';return}
var f=shinFair([a,b]);if(!f){out.textContent='These prices have no margin to remove.';return}
var margin=(1/a+1/b-1)*100;
out.textContent='Fair odds: '+fmtA(toAmerican(1/f[0]))+' / '+fmtA(toAmerican(1/f[1]))+' · Win chance: '+(f[0]*100).toFixed(1)+'% / '+(f[1]*100).toFixed(1)+'% · Bookmaker margin: '+margin.toFixed(2)+'%'}
document.getElementById('calc').addEventListener('input',run);run();`;

const EV_UI = `
function run(){var p=toDecimal(document.getElementById('price').value),f=toDecimal(document.getElementById('fair').value),out=document.getElementById('out');
if(!p||!f){out.textContent='Enter your odds and the fair odds, e.g. +105 and -102.';return}
var ev=(p/f-1)*100;out.textContent='Expected value: '+(ev>=0?'+':'')+ev.toFixed(2)+'% per bet'+(ev>0?' (a +EV bet)':'')}
document.getElementById('calc').addEventListener('input',run);run();`;

// opts: { source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderNoVigCalculator({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<h1>No-vig fair odds calculator</h1>
<p>Enter both sides of a two-way bet (spread, total or moneyline) in American odds. The calculator removes the bookmaker's margin (the "vig") and shows the fair odds and each side's true win chance.</p>
<form class="calc" id="calc" onsubmit="return false">
<label for="a">Side A odds</label><input id="a" inputmode="numeric" value="-110">
<label for="b">Side B odds</label><input id="b" inputmode="numeric" value="-110">
<output id="out"></output></form>
<h2>How it works</h2>
<p>A book's two prices add up to more than 100% implied probability; the excess is its margin. We remove it with the Shin method, which accounts for books shading longshots more than favorites. It's the same method PickSharp uses on Pinnacle's lines to find edges: when a US book offers a better price than the fair price, the bet is +EV.</p>
<p>Next: check a price against fair with the <a href="/tools/ev-calculator">EV calculator</a>, or see <a href="/odds">today's fair prices for every game</a>.</p>
${signupForm({ source, returnTo: '/tools/no-vig-calculator', subscribed, error, cta: 'Get the bets that beat the fair price, free by email.' })}
<script>${CALC_JS}${NO_VIG_UI}</script>`;
  return layout({
    title: 'No-vig fair odds calculator (remove the vig)',
    description: 'Free no-vig calculator: remove the bookmaker margin from any two-way line and get the fair odds and true win probability.',
    canonical: `${siteUrl}/tools/no-vig-calculator`,
    body,
    analyticsToken,
    active: 'tools',
  });
}

export function renderEvCalculator({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<h1>Expected value (EV) betting calculator</h1>
<p>Enter the odds you can bet and the fair odds for the same side. The calculator shows your expected profit per bet as a percentage of the stake.</p>
<form class="calc" id="calc" onsubmit="return false">
<label for="price">Your odds</label><input id="price" inputmode="numeric" value="+105">
<label for="fair">Fair odds</label><input id="fair" inputmode="numeric" value="-102">
<output id="out"></output></form>
<h2>Where the fair odds come from</h2>
<p>Use the <a href="/tools/no-vig-calculator">no-vig calculator</a> on a sharp book's line (Pinnacle is the usual reference), or take the fair price from <a href="/odds">our daily odds pages</a>. A bet is +EV when your price pays more than the fair price implies.</p>
${signupForm({ source, returnTo: '/tools/ev-calculator', subscribed, error, cta: 'Get today\'s +EV bets free by email.' })}
<script>${CALC_JS}${EV_UI}</script>`;
  return layout({
    title: 'Expected value (EV) betting calculator',
    description: 'Free EV calculator for sports bets: compare your odds to the fair odds and see your expected value per bet.',
    canonical: `${siteUrl}/tools/ev-calculator`,
    body,
    analyticsToken,
    active: 'tools',
  });
}

// The home page. Copy is the former React Landing page (src/pages/Landing.jsx at 77a61ea),
// verbatim. It cites no record figures: public numbers are core edges only, and they live on /record.
// opts: { source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderHome({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<section class="hero">
<h1>Find bets priced <span class="gold">better than the market</span></h1>
<p class="lead">Every game day, PickSharp compares 9 US sportsbooks against Pinnacle's no-vig fair price and flags the bets a book is selling for more than they're worth. Every flagged bet is tracked against the closing line in public, misses included.</p>
<div class="actions"><a class="btn lg" href="/odds">See today's odds</a><a class="btn-outline" href="/record">View the record</a></div>
${signupForm({ source, returnTo: '/', subscribed, error })}
</section>
<section class="band"><div class="wrap cols">
<div><h3>Math, not opinions</h3><p>We remove the bookmaker's margin from Pinnacle's line to get a fair price, then compare it with each US book. An edge is a price above fair, not a prediction about who wins.</p></div>
<div><h3>Proof, not promises</h3><p>Beating the closing line is the standard test of whether a bet was good. Our <a href="/record">public record</a> shows the closing line value of every edge we log.</p></div>
<div><h3>Free tools</h3><p>Check any bet yourself with the <a href="/tools/no-vig-calculator">no-vig calculator</a> and the <a href="/tools/ev-calculator">EV calculator</a>.</p></div>
</div></section>
<section class="trial"><h2>Free during the public trial</h2>
<p>Every edge we find goes out free by email while we build the record. A paid plan comes only after the record clears a public bar: 100 qualifying edges with a known closing line, averaging +1% closing line value or better. Trial subscribers get a founding-member price.</p>
</section>`;
  return layout({
    title: 'PickSharp: find bets priced better than the market',
    description: "PickSharp compares 9 US sportsbooks against Pinnacle's no-vig fair price, flags bets priced above fair, and tracks every one against the closing line in public.",
    canonical: `${siteUrl}/`,
    body,
    analyticsToken,
    wide: true,
  });
}

// opts: { source, subscribed?, error?, siteUrl, analyticsToken? }
export function renderToolsIndex({ source, subscribed, error, siteUrl, analyticsToken }) {
  const body = `<h1>Free sports betting tools</h1>
<p>Both tools use the same Shin no-vig method as our edge scan.</p>
<div class="cards">
<a class="card" href="/tools/no-vig-calculator"><strong>No-vig calculator</strong><br>Remove the vig from a two-way line and get fair odds and true win chance.</a>
<a class="card" href="/tools/ev-calculator"><strong>EV calculator</strong><br>Compare your odds to the fair odds and see expected value per bet.</a>
</div>
<p>Or skip the math: <a href="/odds">today's fair prices for every game</a>.</p>
${signupForm({ source, returnTo: '/tools', subscribed, error, cta: 'Get the bets that beat the fair price, free by email.' })}`;
  return layout({
    title: 'Free sports betting tools: no-vig and EV calculators',
    description: 'Free sports betting calculators: remove the vig to get fair odds, and check the expected value of any bet.',
    canonical: `${siteUrl}/tools`,
    body,
    analyticsToken,
    active: 'tools',
  });
}

export function renderSitemap(siteUrl, entries) {
  const urls = entries
    .map((e) => `<url><loc>${escapeHtml(siteUrl + e.path)}</loc>${e.lastmod ? `<lastmod>${escapeHtml(e.lastmod)}</lastmod>` : ''}</url>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

export function robotsTxt(siteUrl) {
  return `User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /dashboard\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}
