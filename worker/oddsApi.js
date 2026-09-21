const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba'];

// player_anytime_td is intentionally excluded: The Odds API returns those as yes/no
// outcomes with no numeric `point`, incompatible with this design's point-based line
// grounding -- it was being fetched and paid for but could never produce a pick.
// Could be added back later with dedicated handling for that outcome shape.
const PROP_MARKETS = {
  americanfootball_nfl: 'player_pass_yds,player_rush_yds,player_receptions',
  americanfootball_ncaaf: 'player_pass_yds,player_rush_yds,player_receptions',
  basketball_nba: 'player_points,player_rebounds,player_assists,player_threes',
};

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
  const results = await Promise.allSettled(SPORTS.map((sportKey) => fetchSportOdds(env, sportKey)));
  const games = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      games.push(...result.value);
    } else {
      console.error('Odds fetch failed for one sport, continuing with the rest:', result.reason?.message);
    }
  }
  if (games.length === 0 && results.every((r) => r.status === 'rejected')) {
    throw new Error('Odds fetch failed for every sport');
  }
  return games;
}

export async function getEventProps(env, sportKey, eventId) {
  const markets = PROP_MARKETS[sportKey];
  if (!markets) return null;

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API event-props request failed for ${sportKey}/${eventId}: ${res.status} ${body}`);
  }
  return res.json();
}
