const XAI_API_BASE = 'https://api.x.ai/v1';
// Calibrated 2026-09-22 from a confirmed $0.45 charge for 4,777,800,000 ticks.
// xAI does not document this conversion officially — re-derive if actual
// billing drifts from what xai_spend_log's running total predicts.
const TICK_TO_USD = 0.45 / 4_777_800_000;

const RESULT_LIMIT = 12;
const SEARCH_WINDOW_DAYS = 2;
const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];

// Same "give the model the real data, demand verbatim reuse" pattern as
// worker/pickGenerator.js's summarizeGame/buildPrompt -- not shared code (each
// generator/discovery module keeps its own prompt-building, matching this
// codebase's existing convention), but the same idea: a model that has to pick
// an exact team-name string from a provided list can't drift from real games,
// whereas one asked to "extract the game" from free text can invent a name.
function summarizeGamesForPrompt(oddsGames) {
  const upcoming = oddsGames
    .filter((g) => new Date(g.commence_time).getTime() > Date.now())
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, 15);
  return upcoming.map((g) => `${g.away_team} @ ${g.home_team}, kickoff ${g.commence_time}`).join('\n');
}

function buildPrompt(handle, oddsGames) {
  const gamesSummary = summarizeGamesForPrompt(oddsGames);

  return `Call the x_search tool exactly once, searching only "from:${handle}" with a result limit of ${RESULT_LIMIT}. Do not look up user profiles. Do not perform any additional searches.

Here are real upcoming games, for matching posts against (soonest first):
${gamesSummary}

After you get results, respond with ONLY compact JSON, no markdown, no prose, no code fences, in exactly this shape:
{"posts":[{"text":"<verbatim post text>","url":"<post url>","posted_at":"<timestamp>","pick_type":"...","game":"...","game_time_utc":"...","pick_text":"..."}]}

A post qualifies ONLY if it is a sports betting pick (a team/game plus a spread, moneyline, total, or player prop) AND you can confidently fill in all four extraction fields from the post's own text:
- pick_type: one of "spread", "moneyline", "prop", "over_under"
- game: the exact "<away_team> @ <home_team>" string from the games list above, verbatim, unabbreviated — only include the post if you can match it to one of those real games
- game_time_utc: the exact kickoff value from the games list above for that game, verbatim
- pick_text: a short pick description grounded in the post's own words, e.g. "Kansas City Chiefs -5.5"

If a post's pick is only shown in an image, video, or a linked bet-slip (not stated in the post text itself), or you cannot match it to a real game in the list above, LEAVE THAT POST OUT of the array entirely — do not include it with guessed or partial fields, and do not invent a game/team/line that isn't in the list above. Max ${RESULT_LIMIT} posts. If none qualify, return {"posts":[]}.`;
}

function isValidExtractedPost(post) {
  return Boolean(
    post &&
      typeof post.text === 'string' &&
      post.text.trim().length > 0 &&
      typeof post.url === 'string' &&
      post.url.trim().length > 0 &&
      typeof post.pick_type === 'string' &&
      PICK_TYPES.includes(post.pick_type) &&
      typeof post.game === 'string' &&
      post.game.trim().length > 0 &&
      typeof post.game_time_utc === 'string' &&
      !Number.isNaN(new Date(post.game_time_utc).getTime()) &&
      typeof post.pick_text === 'string' &&
      post.pick_text.trim().length > 0
  );
}

// Resolves (never rejects) for anything that happens AFTER xAI returns 2xx --
// at that point the call has been billed, so the caller must still get the cost
// back to log it. Those failures come back as { posts: [], error }. Genuinely
// unbilled failures (non-2xx, network errors) still throw: there is no spend to log.
export async function discoverCandidatesForHandle(env, handle, oddsGames) {
  const today = new Date();
  const windowStart = new Date(today.getTime() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // One day past today: xAI does not document whether to_date is inclusive, and an
  // exclusive range would make the 12:30 UTC cron systematically miss posts made
  // that same morning -- exactly the window discovery exists to catch.
  const windowEnd = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const res = await fetch(`${XAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4.20-0309-non-reasoning',
      input: [{ role: 'user', content: buildPrompt(handle, oddsGames) }],
      tools: [
        {
          type: 'x_search',
          allowed_x_handles: [handle],
          from_date: fmt(windowStart),
          to_date: fmt(windowEnd),
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`xAI API request failed for ${handle}: ${res.status} ${text}`);
  }

  // Past this point xAI has billed us. Every failure below reports the cost back
  // instead of throwing, so the caller can log the spend before handling the error.
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // No parseable body means no usage block either -- log the attempt at 0 so the
    // error is at least visible; the true cost is unknowable from here.
    return failure(0, `xAI API response body for ${handle} was not valid JSON: ${err.message}`);
  }

  const costUsdTicks = data.usage?.cost_in_usd_ticks ?? 0;

  const message = data.output?.find((o) => o.type === 'message');
  const rawText = message?.content?.[0]?.text;
  if (!rawText) {
    return failure(costUsdTicks, `xAI API response for ${handle} had no message content`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return failure(costUsdTicks, `xAI API response for ${handle} was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.posts)) {
    return failure(costUsdTicks, `xAI API response for ${handle} had no "posts" array`);
  }

  // Defense in depth: the prompt already asks the model to self-filter to
  // fully-extractable posts, but nothing here trusts that it actually did --
  // same "never trust free-text model output" posture as pickGenerator.js's
  // isValidPick. A post missing/malforming any extraction field is dropped,
  // not passed through with a guessed value.
  return {
    posts: parsed.posts.filter(isValidExtractedPost),
    costUsdTicks,
    estimatedUsd: costUsdTicks * TICK_TO_USD,
  };
}

function failure(costUsdTicks, error) {
  return {
    posts: [],
    costUsdTicks,
    estimatedUsd: costUsdTicks * TICK_TO_USD,
    error,
  };
}
