// Server-rendered public pages: plain HTML so search engines index them without running
// React. Pure string builders -- site.js loads the data and picks the status code. Every
// value that came from a feed goes through escapeHtml.
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';
import { MARKETS, sportPath } from './oddsSnapshot.js';

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

const CSS = `body{margin:0;background:#0a0a0a;color:#e5e5e5;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
main,header,footer{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;gap:16px;align-items:center;border-bottom:1px solid #262626}
header a{color:#e5e5e5;text-decoration:none}header .brand{font-weight:700;margin-right:auto}
a{color:#34d399}h1{font-size:1.5rem;line-height:1.25}h2{font-size:1.15rem;margin-top:28px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:.95rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #262626}th{color:#a3a3a3;font-weight:500}
.book{color:#a3a3a3;font-size:.85em}.edge td{color:#fbbf24}.muted{color:#a3a3a3;font-size:.9rem}
.signup{margin:24px 0;padding:16px;border:1px solid #262626;border-radius:8px;background:#141414}
.signup input[type=email]{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5}
.signup button{padding:10px 16px;border:0;border-radius:6px;background:#10b981;color:#04130d;font-weight:700;cursor:pointer}
.signup small{display:block;margin-top:8px;color:#a3a3a3}.ok{color:#34d399}.err{color:#f87171}
footer{border-top:1px solid #262626;color:#a3a3a3;font-size:.85rem}
.calc label{display:block;margin:12px 0 4px}.calc input{padding:8px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5;width:140px}
.calc output{display:block;margin-top:12px;font-size:1.1rem}`;

export function layout({ title, description, canonical, body, analyticsToken }) {
  const analytics = analyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(analyticsToken)}"}'></script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="/favicon-32.png">
<style>${CSS}</style>${analytics}</head>
<body><header><a class="brand" href="/">PickSharp</a><a href="/odds">Odds</a><a href="/tools/no-vig-calculator">Tools</a><a href="/record">Record</a></header>
<main>${body}</main>
<footer><p>21+ · Gambling problem? Call 1-800-GAMBLER. Prices are a daily snapshot and can move; confirm at the book before betting.</p>
<p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></footer></body></html>`;
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
<p><strong>${edgeCount} edge${edgeCount === 1 ? '' : 's'} found today.</strong> Each one is a price better than fair at a US book.</p>
${signupForm({ source, returnTo: '/odds', subscribed, error, cta: 'Get them free by email.' })}
${sections || '<p>No upcoming games in today\'s scan.</p>'}`;
  return layout({
    title: 'NFL & college football odds: best lines and fair prices today',
    description: 'Compare NFL and college football odds across US sportsbooks, with the no-vig fair price for every spread, total and moneyline.',
    canonical: `${siteUrl}/odds`,
    body,
    analyticsToken,
  });
}
