const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf'];

async function fetchSportOdds(env, sportKey) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API request failed for ${sportKey}: ${res.status} ${body}`);
  }
  return res.json();
}

export async function getUpcomingOdds(env) {
  const results = await Promise.all(SPORTS.map((sportKey) => fetchSportOdds(env, sportKey)));
  return results.flat();
}
