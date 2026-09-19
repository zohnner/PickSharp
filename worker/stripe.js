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
