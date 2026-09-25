// Pure grading helpers: ESPN scoreboard parsing, matching ESPN games to Odds API
// events, and settling an edge against a final score. I/O lives in gradeGames.js.

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// groups=80 is every FBS game; without it ESPN's college scoreboard returns only a
// featured subset.
const ESPN_PATHS = {
  americanfootball_nfl: 'football/nfl/scoreboard',
  americanfootball_ncaaf: 'football/college-football/scoreboard',
  basketball_nba: 'basketball/nba/scoreboard',
};
const ESPN_EXTRA = { americanfootball_ncaaf: '&groups=80&limit=300' };

// ESPN files games under their US Eastern date, so a 00:15 UTC Friday kickoff is on
// Thursday's scoreboard.
export function etDate(isoOrMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoOrMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

export function espnScoreboardUrl(sport, yyyymmdd) {
  const path = ESPN_PATHS[sport];
  if (!path) return null;
  return `${ESPN_BASE}/${path}?dates=${yyyymmdd}${ESPN_EXTRA[sport] || ''}`;
}

// Accents, punctuation and case differ between feeds ("San José State" vs "San Jose
// State", "Hawai'i" vs "Hawaii"), so names compare on letters and digits only.
export function normalizeTeam(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Returns only completed games; anything in progress, postponed or malformed is skipped
// and simply retried on a later run.
export function parseEspnScoreboard(data) {
  const games = [];
  for (const event of data?.events || []) {
    const comp = event.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    const home = comp.competitors?.find((c) => c.homeAway === 'home');
    const away = comp.competitors?.find((c) => c.homeAway === 'away');
    const homeScore = Number(home?.score);
    const awayScore = Number(away?.score);
    if (!home || !away || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const names = (c) =>
      [c.team?.displayName, `${c.team?.location || ''} ${c.team?.name || ''}`].map(normalizeTeam).filter(Boolean);
    games.push({ date: event.date, home: names(home), away: names(away), homeScore, awayScore });
  }
  return games;
}

const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

// `game` is the edges.game string, "<away> @ <home>" in Odds API names.
export function splitGame(game) {
  const [away, home] = String(game).split(' @ ');
  return home ? { away, home } : null;
}

export function findFinal(espnGames, { game, commence_time }) {
  const teams = splitGame(game);
  if (!teams) return null;
  const home = normalizeTeam(teams.home);
  const away = normalizeTeam(teams.away);
  const kickoff = Date.parse(commence_time);
  return (
    espnGames.find(
      (g) =>
        g.home.includes(home) &&
        g.away.includes(away) &&
        !(Math.abs(Date.parse(g.date) - kickoff) > MATCH_WINDOW_MS)
    ) || null
  );
}

// result: { home_team, away_team, home_score, away_score } with Odds API team names.
// Returns 'win' | 'loss' | 'push', or null when the edge can't be graded against it.
export function gradeEdge(edge, result) {
  const { market, outcome, point } = edge;
  const total = result.home_score + result.away_score;
  let margin;
  if (market === 'totals') {
    if (point == null) return null;
    if (outcome === 'Over') margin = total - point;
    else if (outcome === 'Under') margin = point - total;
    else return null;
  } else {
    let own, opp;
    if (outcome === result.home_team) [own, opp] = [result.home_score, result.away_score];
    else if (outcome === result.away_team) [own, opp] = [result.away_score, result.home_score];
    else return null;
    if (market === 'h2h') margin = own - opp;
    else if (market === 'spreads' && point != null) margin = own + point - opp;
    else return null;
  }
  return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
}

// Flat one-unit stake at the decimal price the edge was first logged at.
export function unitsFor(grade, decimalPrice) {
  if (grade === 'win') return decimalPrice - 1;
  if (grade === 'loss') return -1;
  return 0;
}
