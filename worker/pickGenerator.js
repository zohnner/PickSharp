const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const PERSONAS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];
const VALID_PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const VALID_CONFIDENCES = ['high', 'medium', 'low'];

function buildPrompt(oddsData) {
  return `You are generating sports betting pick content for a set of fictional "sharp bettor" personas on a sports picks website. You will be given today's odds data for NFL/NCAAF games.

Generate 3-5 picks total, each attributed to one of these exact personas (rotate across them where sensible, don't reuse the same one twice in this batch unless you have more than 5 picks): ${PERSONAS.join(', ')}.

Odds data:
${JSON.stringify(oddsData).slice(0, 8000)}

Respond with ONLY a JSON array (no markdown formatting, no code fences, no explanation before or after) of objects with exactly this shape:
[{"author": "one of the personas listed above, verbatim", "pick_text": "short pick description, e.g. 'Kansas City -5.5' or 'Over 47'", "pick_type": "one of: spread, moneyline, prop, over_under", "confidence": "one of: high, medium, low", "game": "e.g. 'KC @ BAL'", "game_time": "e.g. 'Sept 21 1:00 PM'"}]`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function validatePick(pick) {
  return (
    pick &&
    typeof pick === 'object' &&
    PERSONAS.includes(pick.author) &&
    typeof pick.pick_text === 'string' &&
    pick.pick_text.length > 0 &&
    VALID_PICK_TYPES.includes(pick.pick_type) &&
    VALID_CONFIDENCES.includes(pick.confidence) &&
    typeof pick.game === 'string' &&
    pick.game.length > 0 &&
    typeof pick.game_time === 'string' &&
    pick.game_time.length > 0
  );
}

export async function generatePicks(env, oddsData) {
  const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(oddsData) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text;
  if (!rawText) {
    throw new Error('Anthropic API response had no text content');
  }

  let picks;
  try {
    picks = JSON.parse(extractJson(rawText));
  } catch (err) {
    throw new Error(`Anthropic API response was not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(picks) || picks.length === 0) {
    throw new Error('Anthropic API response was not a non-empty array');
  }

  const invalid = picks.filter((p) => !validatePick(p));
  if (invalid.length > 0) {
    throw new Error(`Anthropic API returned ${invalid.length} invalid pick(s): ${JSON.stringify(invalid)}`);
  }

  return picks;
}
