const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

function extractJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in model response');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function isValidPick(pick) {
  return Boolean(
    pick &&
      typeof pick.pick_type === 'string' &&
      PICK_TYPES.includes(pick.pick_type) &&
      typeof pick.game === 'string' &&
      pick.game.trim().length > 0 &&
      typeof pick.game_time_utc === 'string' &&
      !Number.isNaN(new Date(pick.game_time_utc).getTime()) &&
      typeof pick.pick_text === 'string' &&
      pick.pick_text.trim().length > 0
  );
}

// Derived from game_time_utc (the verbatim, grounded timestamp) instead of asking the
// model to also write its own human-readable time -- that let it echo a correct
// game_time_utc while inventing a mismatched display string (e.g. a real 4:25 PM ET
// kickoff shown as "8:25 PM ET"), since nothing tied the two together.
function formatGameTime(isoString) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(isoString));
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')} ${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ET`;
}

function isValidPropPick(pick) {
  return Boolean(
    pick &&
      pick.pick_type === 'prop' &&
      typeof pick.game === 'string' &&
      pick.game.trim().length > 0 &&
      typeof pick.game_time_utc === 'string' &&
      !Number.isNaN(new Date(pick.game_time_utc).getTime()) &&
      typeof pick.player === 'string' &&
      pick.player.trim().length > 0 &&
      typeof pick.pick_text === 'string' &&
      pick.pick_text.trim().length > 0
  );
}

// Only the "Over" side of each market is summarized -- an Over/Under pair at the
// same line carries the same information for picking a side, and halving the pairs
// keeps the prompt shorter across up to 3 games worth of prop markets.
function summarizePropGame(game, propsData) {
  const bookmaker = propsData.bookmakers?.[0];
  const lines = (bookmaker?.markets || [])
    .flatMap((m) =>
      (m.outcomes || [])
        .filter((o) => o.name === 'Over')
        .map((o) => `${o.description} ${m.key}: Over ${o.point} (${o.price})`)
    )
    .join('\n');
  return `${game.away_team} @ ${game.home_team}, kickoff ${game.commence_time}:\n${lines}`;
}

function buildPropsPrompt(gamesWithProps) {
  const now = new Date().toISOString();
  const gamesSummary = gamesWithProps.map(({ game, propsData }) => summarizePropGame(game, propsData)).join('\n\n');

  return `You are generating player prop bet picks for PickSharp, a sports-picks website. These are PickSharp's own picks -- do not attribute them to any real person.

The current time is ${now} (UTC). Only pick from the games and players listed below.

Upcoming games and real player prop lines:
${gamesSummary}

Generate 3 to 5 player prop picks grounded in this real data. Respond with ONLY a JSON array, no other text, where each element has exactly these fields:
- pick_type: always "prop"
- game: the exact "<away_team> @ <home_team>" string from the data above, verbatim, unabbreviated
- game_time_utc: the exact kickoff value from the data above for that game, verbatim
- player: the exact player name from the data above, verbatim
- pick_text: a short pick description grounded in the real prop lines shown above, e.g. "Patrick Mahomes Over 275.5 Passing Yards"

Do not invent a player, game, or line that isn't in the data above.`;
}

export async function generatePropPicks(env, gamesWithProps) {
  const prompt = buildPropsPrompt(gamesWithProps);
  const response = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 1024,
  });

  const text = response.response || '';
  let candidates;
  try {
    candidates = extractJson(text);
  } catch (err) {
    throw new Error(`Could not parse model response as JSON: ${err.message}`);
  }
  if (!Array.isArray(candidates)) {
    throw new Error('Model response was not a JSON array');
  }
  return candidates.filter(isValidPropPick).map((pick) => ({ ...pick, game_time: formatGameTime(pick.game_time_utc) }));
}

function summarizeGame(g) {
  const bookmaker = g.bookmakers?.[0];
  const markets = (bookmaker?.markets || [])
    .map(
      (m) =>
        `${m.key}: ${(m.outcomes || [])
          .map((o) => `${o.name} ${o.price}${o.point !== undefined ? ` (${o.point})` : ''}`)
          .join(', ')}`
    )
    .join(' | ');
  return `${g.away_team} @ ${g.home_team}, kickoff ${g.commence_time}: ${markets}`;
}

function buildPrompt(oddsGames) {
  const now = new Date().toISOString();
  const upcoming = oddsGames.filter((g) => new Date(g.commence_time).getTime() > Date.now());
  const gamesForPrompt = (upcoming.length > 0 ? upcoming : oddsGames)
    .slice()
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, 15);
  const gamesSummary = gamesForPrompt.map(summarizeGame).join('\n');

  return `You are generating sports betting picks for PickSharp, a sports-picks website. These are PickSharp's own picks -- do not attribute them to any real person.

The current time is ${now} (UTC). Only pick games that have NOT started yet as of this time -- every game listed below has a kickoff after this time, sorted soonest first. Strongly prefer the soonest upcoming games over ones further in the future, since these picks need to be useful to someone reading them right now.

Upcoming games and real odds (soonest first):
${gamesSummary}

Generate 3 to 5 picks grounded in this real data, prioritizing the games kicking off soonest. Respond with ONLY a JSON array, no other text, where each element has exactly these fields:
- pick_type: one of "spread", "moneyline", "prop", "over_under"
- game: the exact "<away_team> @ <home_team>" string from the data above, verbatim, unabbreviated
- game_time_utc: the exact commence_time value from the data above for that game, verbatim
- pick_text: a short pick description grounded in the real odds shown above, e.g. "Kansas City Chiefs -5.5"

Do not invent a game, team, or line that isn't in the data above.`;
}

export async function generatePicks(env, oddsGames) {
  const prompt = buildPrompt(oddsGames);
  const response = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 1024,
  });

  const text = response.response || '';
  let candidates;
  try {
    candidates = extractJson(text);
  } catch (err) {
    throw new Error(`Could not parse model response as JSON: ${err.message}`);
  }
  if (!Array.isArray(candidates)) {
    throw new Error('Model response was not a JSON array');
  }
  return candidates.filter(isValidPick).map((pick) => ({ ...pick, game_time: formatGameTime(pick.game_time_utc) }));
}
