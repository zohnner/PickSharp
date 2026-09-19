import {
  getPicks,
  insertPick,
  deletePickById,
  upsertUser,
  getUserById,
  getTodaysPicksRaw,
  getPicksByIds,
  freePickId,
  getUnlockedPickIds,
  insertUnlocks,
} from './db.js';
import { priceForConfidence, bundlePrice } from './pricing.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { composeTweet } from './tweetCopy.js';
import { postTweet } from './x.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function requireAdmin(request, env) {
  const secret = request.headers.get('x-admin-secret');
  return secret && env.ADMIN_SECRET && secret === env.ADMIN_SECRET;
}

async function getSupabaseUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

async function handleSignup(request, env) {
  const { email, password } = await request.json();
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) return json({ error: body.msg || body.error_description || 'Signup failed' }, res.status);

  if (body.id) {
    await upsertUser(env.DB, { id: body.id, email });
  }
  return json(body, 200);
}

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) return json({ error: body.msg || body.error_description || 'Login failed' }, res.status);
  return json(body, 200);
}

async function handleGetMe(request, env) {
  const supabaseUser = await getSupabaseUser(request, env);
  if (!supabaseUser) return json({ error: 'Unauthorized' }, 401);

  await upsertUser(env.DB, { id: supabaseUser.id, email: supabaseUser.email });
  const user = await getUserById(env.DB, supabaseUser.id);
  return json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
}

async function handleGetPicksToday(request, env) {
  const url = new URL(request.url);
  const buyerToken = url.searchParams.get('buyer_token') || '';

  const todays = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(todays);
  const unlockedIds = await getUnlockedPickIds(env.DB, buyerToken);

  const todaysIds = new Set(todays.map((p) => p.id));
  const missingUnlockedIds = [...unlockedIds].filter((id) => !todaysIds.has(id));

  let picks = todays;
  if (missingUnlockedIds.length > 0) {
    const olderUnlocked = await getPicksByIds(env.DB, missingUnlockedIds);
    picks = picks.concat(olderUnlocked);
  }

  const shaped = picks
    .map((pick) => {
      const locked = pick.id !== freeId && !unlockedIds.has(pick.id);
      if (!locked) {
        return { ...pick, locked: false };
      }
      const { pick_text, affiliate_link, ...rest } = pick;
      return { ...rest, locked: true, price_cents: priceForConfidence(pick.confidence) };
    })
    .sort((a, b) => {
      if (a.created_at < b.created_at) return 1;
      if (a.created_at > b.created_at) return -1;
      return 0;
    });

  return json({ picks: shaped });
}

async function handleAdminListPicks(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const picks = await getPicks(env.DB, {});
  return json({ picks });
}

async function handleAdminCreatePick(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const pick = await request.json();

  if (!pick.author || !pick.pick_text || !pick.pick_type || !pick.confidence || !pick.game || !pick.game_time) {
    return json({ error: 'Missing required pick fields' }, 400);
  }

  const id = await insertPick(env.DB, pick);
  return json({ id }, 201);
}

async function handleAdminDeletePick(request, env, id) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  await deletePickById(env.DB, id);
  return json({ success: true });
}

async function handleCheckoutPick(request, env) {
  const { pick_id, buyer_token } = await request.json();
  if (!pick_id || !buyer_token) {
    return json({ error: 'pick_id and buyer_token are required' }, 400);
  }

  const picks = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(picks);
  const pick = picks.find((p) => p.id === pick_id);

  if (!pick || pick.id === freeId) {
    return json({ error: 'Pick not found or not purchasable' }, 400);
  }

  const unlockedIds = await getUnlockedPickIds(env.DB, buyer_token);
  if (unlockedIds.has(pick.id)) {
    return json({ error: 'Pick already unlocked' }, 400);
  }

  const origin = new URL(request.url).origin;
  const priceCents = priceForConfidence(pick.confidence);

  let session;
  try {
    session = await createCheckoutSession(env, {
      lineItems: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: priceCents,
            product_data: { name: `${pick.author} pick: ${pick.game}` },
          },
          quantity: 1,
        },
      ],
      metadata: { buyer_token, pick_ids: String(pick.id) },
      successUrl: `${origin}/picks?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/picks`,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  return json({ url: session.url });
}

async function handleCheckoutBundle(request, env) {
  const { pick_ids, buyer_token } = await request.json();
  if (!Array.isArray(pick_ids) || pick_ids.length === 0 || !buyer_token) {
    return json({ error: 'pick_ids (non-empty array) and buyer_token are required' }, 400);
  }

  const picks = await getTodaysPicksRaw(env.DB);
  const freeId = freePickId(picks);
  const unlockedIds = await getUnlockedPickIds(env.DB, buyer_token);
  const purchasable = picks.filter(
    (p) => pick_ids.includes(p.id) && p.id !== freeId && !unlockedIds.has(p.id)
  );

  if (purchasable.length === 0) {
    return json({ error: 'No purchasable picks in pick_ids' }, 400);
  }

  const origin = new URL(request.url).origin;
  const lineItems = purchasable.map((pick) => ({
    price_data: {
      currency: 'usd',
      unit_amount: bundlePrice(priceForConfidence(pick.confidence)),
      product_data: { name: `${pick.author} pick: ${pick.game}` },
    },
    quantity: 1,
  }));

  let session;
  try {
    session = await createCheckoutSession(env, {
      lineItems,
      metadata: { buyer_token, pick_ids: purchasable.map((p) => p.id).join(',') },
      successUrl: `${origin}/picks?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/picks`,
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  return json({ url: session.url });
}

async function handleCheckoutConfirm(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const buyerToken = url.searchParams.get('buyer_token');

  if (!sessionId || !buyerToken) {
    return json({ error: 'session_id and buyer_token are required' }, 400);
  }

  let session;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  if (session.payment_status !== 'paid') {
    return json({ error: 'Payment not confirmed' }, 402);
  }
  if (session.metadata?.buyer_token !== buyerToken) {
    return json({ error: 'buyer_token does not match this session' }, 400);
  }

  if (!session.metadata?.pick_ids) {
    return json({ error: 'Session has no associated picks' }, 400);
  }
  const pickIds = session.metadata.pick_ids.split(',').map(Number).filter(Number.isInteger);
  if (pickIds.length === 0) {
    return json({ error: 'Session has no associated picks' }, 400);
  }
  await insertUnlocks(env.DB, { buyerToken, pickIds, stripeSessionId: sessionId });

  return json({ unlocked_pick_ids: pickIds });
}

// "Today" is anchored to US Eastern time (fixed -4h/EDT offset — would need -5h during EST/winter months; not auto-adjusted).
const QUIET_PERIOD_MINUTES = 15;

async function handleDailyPostCheck(env) {
  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = 'manual'`
  ).first();
  if (alreadyPosted) return;

  const picks = (await getTodaysPicksRaw(env.DB)).filter((p) => p.slot === 'manual' || p.slot === null);
  if (picks.length === 0) return;

  const newestRow = await env.DB.prepare(
    `SELECT MAX(created_at) AS newest FROM picks WHERE date(created_at, '-4 hours') = date('now', '-4 hours') AND (slot = 'manual' OR slot IS NULL)`
  ).first();
  const minutesRow = await env.DB.prepare(
    `SELECT (julianday('now') - julianday(?)) * 24 * 60 AS minutes_since`
  )
    .bind(newestRow.newest)
    .first();
  if (minutesRow.minutes_since < QUIET_PERIOD_MINUTES) return;

  if (!env.PUBLIC_SITE_URL) {
    console.error('PUBLIC_SITE_URL is not configured — cannot compose tweet link.');
    throw new Error('PUBLIC_SITE_URL is not configured');
  }

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    console.error('Failed to post daily tweet:', err.message);
    throw err;
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), 'manual', ?)`)
    .bind(tweetId)
    .run();
}

async function handlePostSlot(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);

  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = ?`
  )
    .bind(slot)
    .first();
  if (alreadyPosted) return json({ error: 'Already posted for this slot today' }, 400);

  const picks = (await getTodaysPicksRaw(env.DB)).filter((p) => p.slot === slot);
  if (picks.length === 0) return json({ error: 'No picks found for this slot today' }, 400);

  if (!env.PUBLIC_SITE_URL) {
    return json({ error: 'PUBLIC_SITE_URL is not configured' }, 500);
  }

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), ?, ?)`)
    .bind(slot, tweetId)
    .run();

  return json({ tweet_id: tweetId, pick_count: picks.length });
}

async function handleTrackSource(request, env) {
  const { buyer_token, source } = await request.json();
  if (!buyer_token || !source) {
    return json({ error: 'buyer_token and source are required' }, 400);
  }
  if (typeof buyer_token !== 'string' || buyer_token.length > 64) {
    return json({ error: 'invalid buyer_token' }, 400);
  }
  if (typeof source !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(source)) {
    return json({ error: 'invalid source' }, 400);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO buyer_sources (buyer_token, source) VALUES (?, ?)')
    .bind(buyer_token, source)
    .run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/api/auth/signup' && request.method === 'POST') {
        return await handleSignup(request, env);
      }
      if (pathname === '/api/auth/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (pathname === '/api/user/me' && request.method === 'GET') {
        return await handleGetMe(request, env);
      }
      if (pathname === '/api/picks/today' && request.method === 'GET') {
        return await handleGetPicksToday(request, env);
      }
      if (pathname === '/api/checkout/pick' && request.method === 'POST') {
        return await handleCheckoutPick(request, env);
      }
      if (pathname === '/api/checkout/bundle' && request.method === 'POST') {
        return await handleCheckoutBundle(request, env);
      }
      if (pathname === '/api/checkout/confirm' && request.method === 'GET') {
        return await handleCheckoutConfirm(request, env);
      }
      if (pathname === '/api/track-source' && request.method === 'POST') {
        return await handleTrackSource(request, env);
      }
      if (pathname === '/api/admin/post-slot' && request.method === 'POST') {
        return await handlePostSlot(request, env);
      }
      if (pathname === '/api/admin/picks' && request.method === 'GET') {
        return await handleAdminListPicks(request, env);
      }
      if (pathname === '/api/admin/picks' && request.method === 'POST') {
        return await handleAdminCreatePick(request, env);
      }
      const deleteMatch = pathname.match(/^\/api\/admin\/picks\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleAdminDeletePick(request, env, Number(deleteMatch[1]));
      }

      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleDailyPostCheck(env));
  },
};
