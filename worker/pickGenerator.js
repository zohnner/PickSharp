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
      typeof pick.game_time === 'string' &&
      pick.game_time.trim().length > 0 &&
      typeof pick.game_time_utc === 'string' &&
      !Number.isNaN(new Date(pick.game_time_utc).getTime()) &&
      typeof pick.pick_text === 'string' &&
      pick.pick_text.trim().length > 0
  );
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
- game_time: a human-readable kickoff time, e.g. "Sept 21 1:00 PM ET"
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
  return candidates.filter(isValidPick);
}
