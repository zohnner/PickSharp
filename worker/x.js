import { logUsage } from './usage.js';
const X_API_BASE = 'https://api.x.com/2';

function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function buildAuthHeader(env, method, url) {
  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
    .join('&');

  const signatureBase = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join(
    '&'
  );

  const signingKey = `${percentEncode(env.X_API_KEY_SECRET)}&${percentEncode(env.X_ACCESS_TOKEN_SECRET)}`;
  const signature = await hmacSha1(signingKey, signatureBase);

  const authParams = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(authParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(authParams[key])}"`)
      .join(', ')
  );
}

export async function postTweet(env, text) {
  const url = `${X_API_BASE}/tweets`;
  const authHeader = await buildAuthHeader(env, 'POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`X API request failed: ${res.status} ${res.statusText}`);
  }
  if (!res.ok) {
    throw new Error(data.detail || data.title || `X API request failed: ${res.status}`);
  }
  // Every post goes through here, so this is the one place X's monthly post cap is counted.
  await logUsage(env, 'x_post');
  return data.data.id;
}
