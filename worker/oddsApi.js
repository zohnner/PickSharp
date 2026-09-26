import { toFeedIso } from './edgeSchedule.js';
import { etDate, espnScoreboardUrl, ESPN_FETCH_INIT } from './grading.js';
import { parseEspnOdds } from './espnOdds.js';

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

// A slot's generation and its posting-time grounding check run minutes apart in one
// invocation; the ESPN college scoreboard is ~1.2 MB, so parse it once, not twice.
const ODDS_CACHE_MS = 10 * 60 * 1000;
let oddsCache = null; // { fetchedAtMs, games }

export function resetOddsCacheForTests() {
  oddsCache = null;
}

// The pick pipeline's lines come from ESPN (free) so the 500-credit Odds API plan is
// left entirely to the edge engine. Only the current Eastern date is fetched: the slate
// is "tonight", and each extra college scoreboard costs real CPU on the free plan.
async function fetchSportOdds(env, sportKey, nowMs) {
  const res = await fetch(espnScoreboardUrl(sportKey, etDate(nowMs)), ESPN_FETCH_INIT);
  if (!res.ok) throw new Error(`ESPN scoreboard request failed for ${sportKey}: ${res.status}`);
  return parseEspnOdds(await res.json(), sportKey);
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

export const EDGE_SPORTS = ['americanfootball_nfl', 'americanfootball_ncaaf'];

// Up to 10 named bookmakers bill as one region (3 credits for 3 markets, verified live);
// Pinnacle is the sharp reference, the rest are books a US bettor can actually use.
const EDGE_BOOKMAKERS = 'pinnacle,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,hardrockbet';
const EDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchSharpComparison(env, sportKey, nowMs) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds?apiKey=${env.ODDS_API_KEY}&bookmakers=${EDGE_BOOKMAKERS}&markets=h2h,spreads,totals&oddsFormat=decimal&commenceTimeTo=${toFeedIso(nowMs + EDGE_WINDOW_MS)}`;
  const res = await fetch(url);
  logQuota(res, `${sportKey}/edges`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`The Odds API edge request failed for ${sportKey}: ${res.status} ${body}`);
  }
  return res.json();
}

// /v4/sports costs 0 credits but still returns the quota headers -- used as a free
// balance check before every paid edge scan.
export async function getRemainingCredits(env) {
  try {
    const res = await fetch(`${ODDS_API_BASE}/sports?apiKey=${env.ODDS_API_KEY}`);
    const raw = res.headers.get('x-requests-remaining');
    const remaining = raw === null ? NaN : Number(raw);
    return Number.isFinite(remaining) ? remaining : null;
  } catch (err) {
    console.error('Odds API balance check failed:', err.message);
    return null;
  }
}
