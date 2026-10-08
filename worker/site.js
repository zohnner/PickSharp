// I/O for the public pages: reads odds_snapshots (and, after kickoff, the game's logged
// edges), then hands plain data to pages.js. Responses are cached for 5 minutes at the edge,
// which keeps crawler traffic off D1 and inside the CPU budget.
import { renderGamePage, renderOddsIndex, renderNoVigCalculator, renderEvCalculator, renderHome, renderToolsIndex, renderSitemap, robotsTxt, signupSource } from './pages.js';
import { etIsoDate, sportFromPath, sportPath } from './oddsSnapshot.js';
import { buildRecord } from './record.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 14;

export function isSitePath(pathname) {
  return (
    pathname === '/' ||
    pathname === '/odds' ||
    pathname.startsWith('/odds/') ||
    pathname === '/tools' ||
    pathname.startsWith('/tools/') ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt'
  );
}

// Where the signup form sends the visitor back to. Same-site paths only, so the form can't
// be used as an open redirect.
export function safeReturnPath(p) {
  return typeof p === 'string' && p.length <= 300 && /^\/(?!\/)[^\s\\]*$/.test(p) ? p : '/odds';
}

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=300' : 'public, max-age=60' },
  });

// The newest snapshot of each sport, merged and sorted by kickoff.
export async function loadLatestGames(db) {
  const { results } = await db
    .prepare(
      `SELECT sport, snapshot_date, taken_at, payload FROM odds_snapshots o
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM odds_snapshots WHERE sport = o.sport)`
    )
    .all();
  const games = results.flatMap((r) => JSON.parse(r.payload));
  games.sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  const takenAt = results.map((r) => r.taken_at).sort().at(-1) || null;
  return { games, takenAt };
}

// A game appears in every snapshot from up to 7 days before kickoff; the newest one taken
// on or before its kickoff date has its last pre-game prices. Two rows, because a game that
// kicks off before the noon scan is missing from that day's snapshot.
async function loadGame(db, sport, slug, gameDate) {
  const { results } = await db
    .prepare('SELECT taken_at, payload FROM odds_snapshots WHERE sport = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 2')
    .bind(sport, gameDate)
    .all();
  for (const row of results) {
    const game = JSON.parse(row.payload).find((g) => g.slug === slug);
    if (game) return { game, takenAt: row.taken_at };
  }
  return null;
}

async function loadReveal(db, game, nowMs) {
  const { results } = await db
    .prepare(
      `SELECT e.*, g.home_team, g.away_team, g.home_score, g.away_score, g.status AS result_status
       FROM edges e LEFT JOIN game_results g ON g.event_id = e.event_id WHERE e.event_id = ?`
    )
    .bind(game.event_id)
    .all();
  const revealed = buildRecord(results, nowMs).edges;
  const final = results.find((r) => r.result_status === 'final');
  return { revealed, score: final ? `${final.away_score}-${final.home_score}` : null };
}

function formState(url) {
  return { subscribed: url.searchParams.get('subscribed') === '1', error: url.searchParams.get('subscribe_error') === '1' };
}

export async function handleSite(request, env, nowMs = Date.now()) {
  const url = new URL(request.url);
  const { pathname } = url;
  const siteUrl = env.PUBLIC_SITE_URL || url.origin;
  const common = { siteUrl, analyticsToken: env.CF_ANALYTICS_TOKEN, ...formState(url) };
  const src = url.searchParams.get('src');

  // Static pages: no D1 reads.
  if (pathname === '/') return html(renderHome({ ...common, source: signupSource(src, 'landing') }));
  if (pathname === '/tools') return html(renderToolsIndex({ ...common, source: signupSource(src, 'tools_index') }));

  if (pathname === '/odds') {
    const { games, takenAt } = await loadLatestGames(env.DB);
    return html(renderOddsIndex({ ...common, games, takenAt, nowMs, source: signupSource(src, 'odds_index') }));
  }

  const match = pathname.match(/^\/odds\/([a-z]+)\/([a-z0-9-]+)$/);
  if (match) {
    const sport = sportFromPath(match[1]);
    const dateMatch = match[2].match(/(\d{4}-\d{2}-\d{2})$/);
    if (!sport || !dateMatch) return html('<h1>Not found</h1>', 404);
    const found = await loadGame(env.DB, sport, match[2], dateMatch[1]);
    if (!found) {
      const expired = Date.parse(`${dateMatch[1]}T23:59:59Z`) < nowMs - KEEP_DAYS * DAY_MS;
      return expired ? html('<h1>This game\'s odds page has expired</h1><p><a href="/odds">Today\'s odds</a></p>', 410) : html('<h1>Not found</h1>', 404);
    }
    const started = Date.parse(found.game.commence_time) <= nowMs;
    const reveal = started ? await loadReveal(env.DB, found.game, nowMs) : { revealed: [], score: null };
    return html(renderGamePage({ ...common, ...found, ...reveal, nowMs, source: signupSource(src, 'game_page') }));
  }

  const TOOLS = { '/tools/no-vig-calculator': renderNoVigCalculator, '/tools/ev-calculator': renderEvCalculator };
  if (TOOLS[pathname]) return html(TOOLS[pathname]({ ...common, source: signupSource(src, 'tool') }));

  if (pathname === '/robots.txt') {
    return new Response(robotsTxt(siteUrl), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }

  // The coming week's games (the latest snapshot per sport) plus the static pages. Past game
  // pages stay reachable; parsing 14 days of snapshots here would risk the CPU limit.
  if (pathname === '/sitemap.xml') {
    const { games, takenAt } = await loadLatestGames(env.DB);
    const today = takenAt ? etIsoDate(takenAt) : undefined;
    const entries = [
      { path: '/' },
      { path: '/odds', lastmod: today },
      { path: '/tools' },
      { path: '/tools/no-vig-calculator' },
      { path: '/tools/ev-calculator' },
      { path: '/record', lastmod: today },
      ...games.map((g) => ({ path: `/odds/${sportPath(g.sport)}/${g.slug}`, lastmod: today })),
    ];
    return new Response(renderSitemap(siteUrl, entries), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }

  return html('<h1>Not found</h1>', 404);
}
