import { getPicks, insertPick, deletePickById, upsertUser, getUserById } from './db.js';

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
  return json({ user });
}

async function handleGetPicksToday(request, env) {
  const supabaseUser = await getSupabaseUser(request, env);
  let isPremium = false;

  if (supabaseUser) {
    const user = await getUserById(env.DB, supabaseUser.id);
    isPremium = Boolean(user?.is_premium);
  }

  const picks = await getPicks(env.DB, isPremium ? {} : { sinceDays: 7 });
  return json({ picks });
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
};
