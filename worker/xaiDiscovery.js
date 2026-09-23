const XAI_API_BASE = 'https://api.x.ai/v1';
// Calibrated 2026-09-22 from a confirmed $0.45 charge for 4,777,800,000 ticks.
// xAI does not document this conversion officially — re-derive if actual
// billing drifts from what xai_spend_log's running total predicts.
const TICK_TO_USD = 0.45 / 4_777_800_000;

const RESULT_LIMIT = 12;
const SEARCH_WINDOW_DAYS = 2;

function buildPrompt(handle) {
  return `Call the x_search tool exactly once, searching only "from:${handle}" with a result limit of ${RESULT_LIMIT}. Do not look up user profiles. Do not perform any additional searches.

After you get results, respond with ONLY compact JSON, no markdown, no prose, no code fences, in exactly this shape:
{"posts":[{"text":"<verbatim post text>","url":"<post url>","posted_at":"<timestamp>"}]}

Include only posts that look like a sports betting pick (a team/game plus a spread, moneyline, total, or player prop). Max ${RESULT_LIMIT} posts. If none found, return {"posts":[]}.`;
}

export async function discoverCandidatesForHandle(env, handle) {
  const today = new Date();
  const windowStart = new Date(today.getTime() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const res = await fetch(`${XAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4.20-0309-non-reasoning',
      input: [{ role: 'user', content: buildPrompt(handle) }],
      tools: [
        {
          type: 'x_search',
          allowed_x_handles: [handle],
          from_date: fmt(windowStart),
          to_date: fmt(today),
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`xAI API request failed for ${handle}: ${res.status} ${text}`);
  }

  const data = JSON.parse(text);
  const message = data.output?.find((o) => o.type === 'message');
  const rawText = message?.content?.[0]?.text;
  if (!rawText) {
    throw new Error(`xAI API response for ${handle} had no message content`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`xAI API response for ${handle} was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.posts)) {
    throw new Error(`xAI API response for ${handle} had no "posts" array`);
  }

  const costUsdTicks = data.usage?.cost_in_usd_ticks ?? 0;
  return {
    posts: parsed.posts,
    costUsdTicks,
    estimatedUsd: costUsdTicks * TICK_TO_USD,
  };
}
