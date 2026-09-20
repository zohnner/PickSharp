const X_API_BASE = 'https://api.x.com/2';

export class TweetNotFoundError extends Error {}

export async function fetchTweet(env, tweetId) {
  const url = `${X_API_BASE}/tweets/${tweetId}?expansions=author_id&user.fields=username`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  });

  if (res.status === 404) {
    throw new TweetNotFoundError(`Tweet ${tweetId} not found`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API request failed for tweet ${tweetId}: ${res.status} ${body}`);
  }

  const data = await res.json();
  if (!data.data) {
    throw new TweetNotFoundError(`Tweet ${tweetId} not found`);
  }

  const username = data.includes?.users?.[0]?.username;
  return { text: data.data.text, username };
}
