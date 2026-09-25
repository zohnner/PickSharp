const STRIPE_API = 'https://api.stripe.com/v1';

function formEncode(obj, prefix = '') {
  const params = [];
  for (const [key, value] of Object.entries(obj)) {
    // Skip undefined and null values
    if (value === undefined || value === null) {
      continue;
    }
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        // Skip undefined and null items
        if (item === undefined || item === null) {
          return;
        }
        if (item && typeof item === 'object') {
          params.push(formEncode(item, `${paramKey}[${i}]`));
        } else {
          params.push(`${encodeURIComponent(`${paramKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (value && typeof value === 'object') {
      params.push(formEncode(value, paramKey));
    } else {
      params.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return params.join('&');
}

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Stripe request failed: ${res.status}`);
  }
  return data;
}

export async function createCheckoutSession(env, { lineItems, metadata, successUrl, cancelUrl }) {
  return stripeRequest(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems,
    metadata,
    managed_payments: { enabled: false },
  });
}

export async function retrieveCheckoutSession(env, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw new Error('Invalid session_id format');
  }
  return stripeRequest(env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// Stripe signs each webhook as HMAC-SHA256(secret, `${t}.${rawBody}`) in the
// Stripe-Signature header ("t=...,v1=...[,v1=...]"). Rejects anything older than
// `toleranceSec` so a captured request can't be replayed later.
export async function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

// For the admin panel: which kind of key is configured, without exposing it.
export function stripeMode(secretKey) {
  if (!secretKey) return 'missing';
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  return 'unrecognized';
}

// Pick ids a paid Checkout Session is owed, or null if it isn't a paid PickSharp session.
export function paidSessionPickIds(session) {
  if (session?.payment_status !== 'paid') return null;
  if (!session.metadata?.buyer_token || !session.metadata?.pick_ids) return null;
  const ids = session.metadata.pick_ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}
