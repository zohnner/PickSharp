const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
// The Odds API bills per request (markets x regions); a drained quota makes every slot
// silently skip with 'odds fetch failed', so surface the remaining balance in the logs.
function logQuota(res, label) {
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining !== null) {
    console.log(`[odds-quota] ${label}: remaining=${remaining} used=${res.headers.get('x-requests-used')}`);
  }
}

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

// Generation only targets imminent games, and a request whose window holds no games is
// billed 0 credits (verified live) -- so an off-season sport costs nothing until its
// opener comes within range, with no hardcoded season dates.
const ODDS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// A slot's generation and its posting-time grounding check run minutes apart in one
// invocation and used to pay for the identical fetch twice on the free 500-credit plan.
const ODDS_CACHE_MS = 10 * 60 * 1000;
let oddsCache = null; // { fetchedAtMs, games }

export function resetOddsCacheForTests() {
  oddsCache = null;
}

async function fetchSportOdds(env, sportKey, nowMs) {
  const commenceTimeTo = new Date(nowMs + ODDS_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american&commenceTimeTo=${commenceTimeTo}`;
  const res = await fetch(url);
  logQuota(res, sportKey);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API request failed for ${sportKey}: ${res.status} ${body}`);
  }
  return res.json();
}

export async function getUpcomingOdds(env, { nowMs = Date.now() } = {}) {
  if (oddsCache && nowMs - oddsCache.fetchedAtMs < ODDS_CACHE_MS) return oddsCache.games;

  const results = await Promise.allSettled(SPORTS.map((sportKey) => fetchSportOdds(env, sportKey, nowMs)));
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
  // Only a complete result is cached, so a partial outage retries on the next call.
  if (results.every((r) => r.status === 'fulfilled')) oddsCache = { fetchedAtMs: nowMs, games };
  return games;
}

export async function getEventProps(env, sportKey, eventId) {
  const markets = PROP_MARKETS[sportKey];
  if (!markets) return null;

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
  const res = await fetch(url);
  logQuota(res, `${sportKey}/props`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API event-props request failed for ${sportKey}/${eventId}: ${res.status} ${body}`);
  }
  return res.json();
}
