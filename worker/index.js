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
  isTweetIngested,
  markPickVerified,
} from './db.js';
import { priceForConfidence, bundlePrice } from './pricing.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { composeTweet } from './tweetCopy.js';
import { postTweet } from './x.js';
import { getUpcomingOdds } from './oddsApi.js';
import { fetchTweet, TweetNotFoundError } from './xVerify.js';
import { computeConfidenceFromOdds } from './tiering.js';
import { generatePicks } from './pickGenerator.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
};

const TRACKED_AUTHORS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];

function parseTweetId(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/(\d+)/);
  return match ? match[3] : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function requireAdmin(request, env) {
  const secret = request.headers.get('x-admin-secret');
  if (secret && env.ADMIN_SECRET && secret === env.ADMIN_SECRET) return true;

  if (!env.ADMIN_EMAILS) return false;
  const user = await getSupabaseUser(request, env);
  if (!user?.email) return false;
  const allowlist = env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(user.email.toLowerCase());
}

function isStale(pick) {
  return Boolean(pick.game_time_utc) && pick.game_time_utc <= new Date().toISOString();
}

function matchesRealGame(pick, oddsGames) {
  if (!pick.game_time_utc) return true;
  const pickTime = new Date(pick.game_time_utc).getTime();
  if (Number.isNaN(pickTime)) return true;
  const toleranceMs = 3 * 60 * 60 * 1000;
  const gameText = (pick.game || '').toLowerCase();

  return oddsGames.some((g) => {
    const commence = new Date(g.commence_time).getTime();
    if (Number.isNaN(commence) || Math.abs(commence - pickTime) > toleranceMs) return false;
    const home = (g.home_team || '').toLowerCase();
    const away = (g.away_team || '').toLowerCase();
    return Boolean(home) && Boolean(away) && gameText.includes(home) && gameText.includes(away);
  });
}

function verifiesAuthor(pick, tweetUsername) {
  if (!tweetUsername) return false;
  const expected = pick.author.replace(/^@/, '').toLowerCase();
  return tweetUsername.toLowerCase() === expected;
}

function extractTeams(pick) {
  return (pick.game || '')
    .toLowerCase()
    .split(' @ ')
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractNumberCandidates(pick, teams) {
  const matches = (pick.pick_text || '').match(/\d+(\.\d+)?/g) || [];
  return matches.filter((n) => !teams.some((team) => team.includes(n)));
}

function containsNumber(text, number) {
  const escaped = number.replace('.', '\\.');
  const re = new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`);
  return re.test(text);
}

function verifiesContent(pick, tweetText) {
  const text = (tweetText || '').toLowerCase();
  const teams = extractTeams(pick);
  const sideMatches = teams.some((team) => team && text.includes(team));
  if (!sideMatches) return false;

  const numberCandidates = extractNumberCandidates(pick, teams);
  if (numberCandidates.length === 0) return true;
  return numberCandidates.some((n) => containsNumber(text, n));
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
  const liveTodays = todays.filter((p) => !isStale(p));
  const freeId = freePickId(liveTodays.length > 0 ? liveTodays : todays);
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
      const gameStarted = isStale(pick);
      const locked = pick.id !== freeId && !unlockedIds.has(pick.id) && !gameStarted;
      if (!locked) {
        return { ...pick, locked: false, game_started: gameStarted };
      }
      const { pick_text, affiliate_link, source_tweet_url, source_tweet_id, ...rest } = pick;
      return { ...rest, locked: true, game_started: gameStarted, price_cents: priceForConfidence(pick.confidence) };
    })
    .sort((a, b) => {
      if (a.created_at < b.created_at) return 1;
      if (a.created_at > b.created_at) return -1;
      return 0;
    });

  return json({ picks: shaped });
}

async function handleAdminListPicks(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const picks = await getPicks(env.DB, {});
  return json({ picks });
}

async function handleAdminCreatePick(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const pick = await request.json();

  if (!pick.author || !pick.pick_text || !pick.pick_type || !pick.confidence || !pick.game || !pick.game_time) {
    return json({ error: 'Missing required pick fields' }, 400);
  }

  let sourceTweetId = null;
  if (pick.source_tweet_url) {
    sourceTweetId = parseTweetId(pick.source_tweet_url);
    if (!sourceTweetId) {
      return json({ error: 'source_tweet_url must contain a status/<id> segment' }, 400);
    }
    if (!TRACKED_AUTHORS.includes(pick.author)) {
      return json({ error: `author must be one of the tracked accounts: ${TRACKED_AUTHORS.join(', ')}` }, 400);
    }
    if (await isTweetIngested(env.DB, sourceTweetId)) {
      return json({ error: 'This tweet has already been submitted' }, 400);
    }
  }

  const needsGameTimeUtc = (pick.slot && pick.slot !== 'manual') || sourceTweetId;
  if (needsGameTimeUtc && !pick.game_time_utc) {
    return json({ error: 'game_time_utc is required for non-manual slots and for picks with a source tweet' }, 400);
  }

  const id = await insertPick(env.DB, {
    ...pick,
    affiliate_link: pick.affiliate_link || env.AFFILIATE_LINK || null,
    source_tweet_url: sourceTweetId ? pick.source_tweet_url : null,
    source_tweet_id: sourceTweetId,
    confidence: sourceTweetId ? 'medium' : pick.confidence,
  });
  return json({ id }, 201);
}

async function handleAdminDeletePick(request, env, id) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  await deletePickById(env.DB, id);
  return json({ success: true });
}

async function handleCheckoutPick(request, env) {
  const { pick_id, buyer_token } = await request.json();
  if (!pick_id || !buyer_token) {
    return json({ error: 'pick_id and buyer_token are required' }, 400);
  }

  const picks = await getTodaysPicksRaw(env.DB);
  const liveTodays = picks.filter((p) => !isStale(p));
  const freeId = freePickId(liveTodays.length > 0 ? liveTodays : picks);
  const pick = picks.find((p) => p.id === pick_id);

  if (!pick || pick.id === freeId) {
    return json({ error: 'Pick not found or not purchasable' }, 400);
  }
  if (isStale(pick)) {
    return json({ error: "This pick's game has already started" }, 400);
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
  const liveTodays = picks.filter((p) => !isStale(p));
  const freeId = freePickId(liveTodays.length > 0 ? liveTodays : picks);
  const unlockedIds = await getUnlockedPickIds(env.DB, buyer_token);
  const purchasable = picks.filter(
    (p) => pick_ids.includes(p.id) && p.id !== freeId && !unlockedIds.has(p.id) && !isStale(p)
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
  if (env.POSTING_PAUSED) {
    console.log('Posting is paused (POSTING_PAUSED set) — skipping quiet-period check.');
    return;
  }

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

// Shared by handlePostSlot and handleVerifySlot: runs grounding (real-game) and
// source-tweet verification/tiering against `picks`, mutating DB rows and the
// returned array in place. Does NOT filter out still-pending (unverified, not
// deleted) source-tweet picks — callers decide what to do with those:
// handlePostSlot excludes them from posting; handleVerifySlot reports on them.
async function verifyAndTierPicks(env, slot, initialPicks) {
  let picks = initialPicks;

  const needsOdds = slot !== 'manual' || picks.some((p) => p.source_tweet_id && !p.verified);
  let oddsGames = null;
  if (needsOdds) {
    try {
      oddsGames = await getUpcomingOdds(env);
    } catch (err) {
      console.error(`[${slot}] Odds fetch failed, grounding/tiering skipped:`, err.message);
    }
  }

  if (slot !== 'manual' && oddsGames) {
    const ungrounded = picks.filter((p) => !matchesRealGame(p, oddsGames));
    if (ungrounded.length > 0) {
      await Promise.all(ungrounded.map((p) => deletePickById(env.DB, p.id)));
      const ungroundedIds = new Set(ungrounded.map((p) => p.id));
      picks = picks.filter((p) => !ungroundedIds.has(p.id));
    }
  }

  // Real market odds are required to compute a genuine price tier (not just to check
  // this pick's own game) — without them, verification is deferred entirely this run
  // rather than marking a pick verified with a placeholder tier that would then never
  // be recomputed (verification only re-runs while verified=0).
  if (oddsGames) {
    const toVerify = picks.filter((p) => p.source_tweet_id && !p.verified);
    for (const pick of toVerify) {
      let tweet;
      try {
        tweet = await fetchTweet(env, pick.source_tweet_id);
      } catch (err) {
        if (err instanceof TweetNotFoundError) {
          console.error(`[${slot}] Pick ${pick.id} (${pick.author}) deleted: source tweet not found.`);
          await deletePickById(env.DB, pick.id);
          picks = picks.filter((p) => p.id !== pick.id);
        } else {
          console.error(`[${slot}] Tweet verification skipped for pick ${pick.id}, X API failed:`, err.message);
        }
        continue;
      }

      if (!verifiesAuthor(pick, tweet.username)) {
        console.error(
          `[${slot}] Pick ${pick.id} deleted: claimed author "${pick.author}" does not match tweet author "${tweet.username}".`
        );
        await deletePickById(env.DB, pick.id);
        picks = picks.filter((p) => p.id !== pick.id);
        continue;
      }

      if (!verifiesContent(pick, tweet.text)) {
        // Content-only mismatches are left unverified rather than deleted: real tweets
        // often abbreviate team names (e.g. "Chiefs" vs. the full name required in
        // `game` for odds-API grounding), so a false negative here is expected and
        // shouldn't destroy admin work. The pick stays invisible/unpostable (below)
        // and can be retried on a later run.
        console.error(
          `[${slot}] Pick ${pick.id} left unverified: content did not match tweet text (author "${tweet.username}" confirmed correct).`
        );
        continue;
      }

      const confidence = computeConfidenceFromOdds(pick, oddsGames);
      await markPickVerified(env.DB, pick.id, confidence);
      pick.verified = 1;
      pick.confidence = confidence;
    }
  } else if (picks.some((p) => p.source_tweet_id && !p.verified)) {
    console.error(`[${slot}] Odds unavailable this run — deferring verification for all unverified source-tweet picks.`);
  }

  return picks;
}

async function handleVerifySlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);

  const picks = (await getTodaysPicksRaw(env.DB, { includeUnverified: true })).filter((p) => p.slot === slot);
  if (picks.length === 0) return json({ error: 'No picks found for this slot today' }, 400);

  const sourceIds = picks.filter((p) => p.source_tweet_id).map((p) => p.id);
  const afterPicks = await verifyAndTierPicks(env, slot, picks);
  const afterById = new Map(afterPicks.map((p) => [p.id, p]));

  const results = sourceIds.map((id) => {
    const pick = afterById.get(id);
    if (!pick) return { id, status: 'deleted' };
    return pick.verified
      ? { id, status: 'verified', confidence: pick.confidence }
      : { id, status: 'pending' };
  });

  return json({ slot, results });
}

// Core posting logic, independent of HTTP -- callable both from the admin endpoint
// (handlePostSlot, below) and directly from the scheduled handler for full automation.
// Never throws: every failure path returns { posted: false, reason, status }, so a
// caller in ctx.waitUntil (no HTTP response to send) can just log the outcome.
async function postSlot(env, slot) {
  if (env.POSTING_PAUSED) return { posted: false, reason: 'Posting is paused until further notice', status: 503 };

  const alreadyPosted = await env.DB.prepare(
    `SELECT 1 FROM daily_posts WHERE date = date('now', '-4 hours') AND slot = ?`
  )
    .bind(slot)
    .first();
  if (alreadyPosted) return { posted: false, reason: 'Already posted for this slot today', status: 400 };

  let picks = (await getTodaysPicksRaw(env.DB, { includeUnverified: true })).filter((p) => p.slot === slot);
  if (picks.length === 0) return { posted: false, reason: 'No picks found for this slot today', status: 400 };

  picks = await verifyAndTierPicks(env, slot, picks);

  // Safety net: no pick with a source tweet ever reaches posting logic unless it was
  // actually marked verified above, regardless of which path left it unverified.
  picks = picks.filter((p) => !p.source_tweet_id || p.verified);

  if (picks.length === 0) return { posted: false, reason: 'No picks found for this slot today', status: 400 };

  if (!env.PUBLIC_SITE_URL) {
    return { posted: false, reason: 'PUBLIC_SITE_URL is not configured', status: 500 };
  }

  const freeId = freePickId(picks);
  const freePick = picks.find((p) => p.id === freeId);
  const tweetText = composeTweet(freePick, env.PUBLIC_SITE_URL);

  let tweetId;
  try {
    tweetId = await postTweet(env, tweetText);
  } catch (err) {
    console.error(`[${slot}] postTweet failed:`, err.message);
    return { posted: false, reason: err.message, status: 502 };
  }

  await env.DB.prepare(`INSERT INTO daily_posts (date, slot, tweet_id) VALUES (date('now', '-4 hours'), ?, ?)`)
    .bind(slot, tweetId)
    .run();

  return { posted: true, tweet_id: tweetId, pick_count: picks.length };
}

async function handlePostSlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);

  const result = await postSlot(env, slot);
  if (result.posted) {
    return json({ tweet_id: result.tweet_id, pick_count: result.pick_count });
  }
  return json({ error: result.reason }, result.status);
}

async function generateForSlot(env, slot) {
  const alreadyGenerated = await env.DB.prepare(
    `SELECT 1 FROM picks WHERE author = 'PickSharp' AND slot = ? AND date(created_at, '-4 hours') = date('now', '-4 hours')`
  )
    .bind(slot)
    .first();
  if (alreadyGenerated) {
    console.log(`[${slot}] PickSharp picks already generated today, skipping.`);
    return { skipped: true, reason: 'already generated' };
  }

  let oddsGames;
  try {
    oddsGames = await getUpcomingOdds(env);
  } catch (err) {
    console.error(`[${slot}] Odds fetch failed, cannot generate:`, err.message);
    return { skipped: true, reason: 'odds fetch failed' };
  }
  if (oddsGames.length === 0) {
    console.log(`[${slot}] No upcoming games, skipping generation.`);
    return { skipped: true, reason: 'no games' };
  }

  let candidates;
  try {
    candidates = await generatePicks(env, oddsGames);
  } catch (err) {
    console.error(`[${slot}] Pick generation failed:`, err.message);
    return { skipped: true, reason: 'generation failed' };
  }

  const grounded = candidates.filter((p) => matchesRealGame(p, oddsGames));
  if (grounded.length === 0) {
    console.error(`[${slot}] All generated picks failed grounding, nothing inserted.`);
    return { inserted: 0 };
  }
  if (grounded.length < candidates.length) {
    console.warn(`[${slot}] ${candidates.length - grounded.length} generated pick(s) dropped for failing grounding.`);
  }

  // The prompt asks for 3-5 picks, but nothing else caps it -- guard against a model
  // returning more than intended, since every grounded pick becomes a real, sellable item.
  const MAX_PICKS_PER_SLOT = 5;
  const toInsert = grounded.slice(0, MAX_PICKS_PER_SLOT);

  const ids = [];
  for (const pick of toInsert) {
    const confidence = computeConfidenceFromOdds(pick, oddsGames);
    const id = await insertPick(env.DB, {
      author: 'PickSharp',
      pick_text: pick.pick_text,
      pick_type: pick.pick_type,
      confidence,
      game: pick.game,
      game_time: pick.game_time,
      game_time_utc: pick.game_time_utc,
      slot,
      affiliate_link: env.AFFILIATE_LINK || null,
    });
    ids.push(id);
  }

  console.log(`[${slot}] Generated and inserted ${ids.length} PickSharp picks.`);
  return { inserted: ids.length, ids };
}

const GENERATION_SLOTS = ['morning', 'midday', 'evening'];

async function handleGenerateSlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);
  if (!GENERATION_SLOTS.includes(slot)) {
    return json({ error: `slot must be one of: ${GENERATION_SLOTS.join(', ')}` }, 400);
  }
  const result = await generateForSlot(env, slot);
  return json(result);
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
      if (pathname === '/api/admin/verify-slot' && request.method === 'POST') {
        return await handleVerifySlot(request, env);
      }
      if (pathname === '/api/admin/generate-slot' && request.method === 'POST') {
        return await handleGenerateSlot(request, env);
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
    // Derived from the actual fire time (event.scheduledTime), not a string match against
    // event.cron -- Cloudflare's cron trigger API doesn't document whether it echoes back
    // the configured cron expression verbatim or in some normalized form, and a mismatch
    // there would silently break dispatch. Standard JS Date UTC semantics are unambiguous.
    const SLOT_HOURS = { 13: 'morning', 17: 'midday', 22: 'evening' };
    const fired = new Date(event.scheduledTime);
    const isGenerationDay = [0, 4, 6].includes(fired.getUTCDay()); // Sun, Thu, Sat
    const slot = isGenerationDay && fired.getUTCMinutes() === 0 ? SLOT_HOURS[fired.getUTCHours()] : undefined;
    if (slot) {
      ctx.waitUntil(generateAndPostSlot(env, slot));
    } else {
      ctx.waitUntil(handleDailyPostCheck(env));
    }
  },
};

// Chains generation into posting for full automation -- each half already carries its
// own idempotency guard (already-generated / already-posted), so this stays safe under
// Cloudflare's at-least-once cron redelivery: a retry just no-ops on whichever half
// already succeeded. Both halves already avoid throwing internally; the try/catch here
// is a last-resort guard so ctx.waitUntil never sees an unhandled rejection.
async function generateAndPostSlot(env, slot) {
  try {
    const generated = await generateForSlot(env, slot);
    console.log(`[${slot}] generation:`, JSON.stringify(generated));
  } catch (err) {
    console.error(`[${slot}] generateForSlot threw unexpectedly:`, err.message);
  }
  try {
    const posted = await postSlot(env, slot);
    console.log(`[${slot}] posting:`, JSON.stringify(posted));
  } catch (err) {
    console.error(`[${slot}] postSlot threw unexpectedly:`, err.message);
  }
}
