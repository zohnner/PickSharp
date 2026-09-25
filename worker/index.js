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
  logEvent,
  getFunnelSummary,
  logXaiSpend,
  getXaiSpendTotalUsd,
  insertDiscoveredCandidates,
  getDiscoveredCandidates,
  dismissCandidate,
} from './db.js';
import { priceForConfidence, bundlePrice } from './pricing.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { composeTweet } from './tweetCopy.js';
import { postTweet } from './x.js';
import { getUpcomingOdds, getEventProps } from './oddsApi.js';
import { fetchTweet, TweetNotFoundError, fetchTweetMetrics } from './xVerify.js';
import { discoverCandidatesForHandle } from './xaiDiscovery.js';
import { computeConfidenceFromOdds } from './tiering.js';
import { generatePicks, generatePropPicks } from './pickGenerator.js';

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

// A slot's picks are only useful if they're for games people can bet on today -- a
// Thursday post exists for Thursday Night Football, not Sunday's slate. The slate runs
// from now until the next 09:00 UTC (5 AM EDT / 4 AM EST), so late West Coast kickoffs
// still count as "tonight" while tomorrow's games never do. Every generation cron fires
// after 09:00 UTC, so this always resolves to the following morning.
function todaysSlate(oddsGames, now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(9, 0, 0, 0);
  if (end <= now) end.setUTCDate(end.getUTCDate() + 1);
  return oddsGames.filter((g) => {
    const commence = new Date(g.commence_time).getTime();
    return commence > now.getTime() && commence < end.getTime();
  });
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

function matchesRealProp(pick, gamesWithProps) {
  if (!pick.game_time_utc) return false;
  const entry = gamesWithProps.find(({ game }) => matchesRealGame(pick, [game]));
  if (!entry) return false;

  const player = (pick.player || '').toLowerCase();
  if (!player) return false;

  const bookmaker = entry.propsData.bookmakers?.[0];
  return (bookmaker?.markets || []).some(
    (m) =>
      m.key === pick.market &&
      (m.outcomes || []).some((o) => (o.description || '').toLowerCase() === player && o.point === pick.line)
  );
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

  await logEvent(env.DB, { eventType: 'checkout_started', pickId: pick.id, buyerToken: buyer_token });

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

  await Promise.all(
    purchasable.map((pick) => logEvent(env.DB, { eventType: 'checkout_started', pickId: pick.id, buyerToken: buyer_token }))
  );

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
  if (env.POSTING_PAUSED === 'true') {
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

  const liveTodays = picks.filter((p) => !isStale(p));
  const freeId = freePickId(liveTodays.length > 0 ? liveTodays : picks);
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
  if (env.POSTING_PAUSED === 'true') return { posted: false, reason: 'Posting is paused until further notice', status: 503 };

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

  const liveTodays = picks.filter((p) => !isStale(p));
  const freeId = freePickId(liveTodays.length > 0 ? liveTodays : picks);
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
  // Everything below (prompt, grounding, confidence) only ever sees today's games, so
  // the model can't pick -- and grounding can't accept -- a game from later in the week.
  oddsGames = todaysSlate(oddsGames);
  if (oddsGames.length === 0) {
    console.log(`[${slot}] No games left on today's slate, skipping generation.`);
    return { skipped: true, reason: 'no games today' };
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

// A fulfilled per-event props fetch can still return HTTP 200 with `bookmakers: []`
// (or markets with no outcomes) when the sportsbook hasn't posted props for that game
// yet -- truthy but useless. This distinguishes that case from a genuinely usable
// response so an empty data block doesn't dilute the prompt and waste one of the
// limited game "slots" props generation gets.
function hasUsableProps(propsData) {
  return Boolean(propsData?.bookmakers?.[0]?.markets?.some((m) => (m.outcomes || []).length > 0));
}

async function generateForPropsSlot(env) {
  const alreadyGenerated = await env.DB.prepare(
    `SELECT 1 FROM picks WHERE author = 'PickSharp' AND slot = 'props' AND date(created_at, '-4 hours') = date('now', '-4 hours')`
  ).first();
  if (alreadyGenerated) {
    console.log('[props] PickSharp picks already generated today, skipping.');
    return { skipped: true, reason: 'already generated' };
  }

  let oddsGames;
  try {
    oddsGames = await getUpcomingOdds(env);
  } catch (err) {
    console.error('[props] Odds fetch failed, cannot generate:', err.message);
    return { skipped: true, reason: 'odds fetch failed' };
  }

  const upcoming = todaysSlate(oddsGames)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, 3);
  if (upcoming.length === 0) {
    console.log("[props] No games left on today's slate, skipping generation.");
    return { skipped: true, reason: 'no games today' };
  }

  const propResults = await Promise.allSettled(upcoming.map((game) => getEventProps(env, game.sport_key, game.id)));
  const gamesWithProps = [];
  propResults.forEach((result, i) => {
    if (result.status === 'fulfilled' && hasUsableProps(result.value)) {
      gamesWithProps.push({ game: upcoming[i], propsData: result.value });
    } else if (result.status === 'fulfilled') {
      console.log(`[props] No usable prop markets yet for ${upcoming[i].away_team} @ ${upcoming[i].home_team}, skipping.`);
    } else if (result.status === 'rejected') {
      console.error(
        `[props] Event-props fetch failed for ${upcoming[i].away_team} @ ${upcoming[i].home_team}:`,
        result.reason?.message
      );
    }
  });
  if (gamesWithProps.length === 0) {
    console.log('[props] No usable prop data for any selected game, skipping generation.');
    return { skipped: true, reason: 'no prop data' };
  }

  let candidates;
  try {
    candidates = await generatePropPicks(env, gamesWithProps);
  } catch (err) {
    console.error('[props] Pick generation failed:', err.message);
    return { skipped: true, reason: 'generation failed' };
  }

  const grounded = candidates.filter((p) => matchesRealProp(p, gamesWithProps));
  if (grounded.length === 0) {
    console.error('[props] All generated picks failed grounding, nothing inserted.');
    return { inserted: 0 };
  }
  if (grounded.length < candidates.length) {
    console.warn(`[props] ${candidates.length - grounded.length} generated pick(s) dropped for failing grounding.`);
  }

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
      slot: 'props',
      affiliate_link: env.AFFILIATE_LINK || null,
    });
    ids.push(id);
  }

  console.log(`[props] Generated and inserted ${ids.length} PickSharp prop picks.`);
  return { inserted: ids.length, ids };
}

async function generateAndPostPropsSlot(env) {
  try {
    const generated = await generateForPropsSlot(env);
    console.log('[props] generation:', JSON.stringify(generated));
  } catch (err) {
    console.error('[props] generateForPropsSlot threw unexpectedly:', err.message);
  }
  try {
    const posted = await postSlot(env, 'props');
    console.log('[props] posting:', JSON.stringify(posted));
  } catch (err) {
    console.error('[props] postSlot threw unexpectedly:', err.message);
  }
}

const GENERATION_SLOTS = ['morning', 'midday', 'afternoon', 'evening', 'props'];

async function handleGenerateSlot(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const { slot } = await request.json();
  if (!slot) return json({ error: 'slot is required' }, 400);
  if (!GENERATION_SLOTS.includes(slot)) {
    return json({ error: `slot must be one of: ${GENERATION_SLOTS.join(', ')}` }, 400);
  }
  const result = slot === 'props' ? await generateForPropsSlot(env) : await generateForSlot(env, slot);
  return json(result);
}

// Routes the affiliate CTA through the Worker instead of a direct <a href> so a click is
// reliably logged even if the tab is backgrounded before any frontend beacon could fire.
async function handleAffiliateGo(request, env) {
  const url = new URL(request.url);
  const pickId = url.searchParams.get('pick_id');
  const buyerToken = url.searchParams.get('buyer_token');
  const destination = env.AFFILIATE_LINK || 'https://ak.draftkings.com';

  await logEvent(env.DB, {
    eventType: 'affiliate_click',
    pickId: pickId ? Number(pickId) : null,
    buyerToken,
  }).catch((err) => console.error('Failed to log affiliate_click event:', err.message));

  return Response.redirect(destination, 302);
}

async function handleAdminFunnel(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const summary = await getFunnelSummary(env.DB);
  return json(summary);
}

const PIPELINE_SLOTS = ['morning', 'midday', 'afternoon', 'evening', 'props'];

// Derived entirely from existing data (picks + daily_posts) -- no new schema. Answers
// "did each scheduled run actually work today" without digging through raw Cloudflare logs.
async function handleAdminPipelineStatus(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);

  const { results: postedRows } = await env.DB.prepare(
    `SELECT slot, tweet_id FROM daily_posts WHERE date = date('now', '-4 hours')`
  ).all();
  const postedBySlot = new Map(postedRows.map((r) => [r.slot, r]));

  const { results: pickCounts } = await env.DB.prepare(
    `SELECT slot, COUNT(*) AS count FROM picks
     WHERE date(created_at, '-4 hours') = date('now', '-4 hours') AND slot IS NOT NULL
     GROUP BY slot`
  ).all();
  const countsBySlot = new Map(pickCounts.map((r) => [r.slot, r.count]));

  const status = await Promise.all(
    PIPELINE_SLOTS.map(async (slot) => {
      const posted = postedBySlot.get(slot);
      let metrics = null;
      if (posted) {
        try {
          metrics = await fetchTweetMetrics(env, posted.tweet_id);
        } catch (err) {
          console.error(`[${slot}] Failed to fetch tweet metrics:`, err.message);
        }
      }
      return {
        slot,
        picks_generated: countsBySlot.get(slot) || 0,
        posted: Boolean(posted),
        tweet_id: posted?.tweet_id || null,
        metrics,
      };
    })
  );

  return json({ status });
}

// The xAI credit budget is fixed and non-refundable, and TICK_TO_USD is only a
// calibrated estimate -- so the running total needs to be visible somewhere a
// human actually looks, not just in a manual D1 query.
function budgetCeilingUsd(env) {
  return Number(env.XAI_DISCOVERY_BUDGET_CEILING_USD ?? '18');
}

async function handleGetDiscoveredCandidates(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const candidates = await getDiscoveredCandidates(env.DB);

  const ceiling = budgetCeilingUsd(env);
  let spent = null;
  try {
    spent = await getXaiSpendTotalUsd(env.DB);
  } catch (err) {
    // Non-critical: the candidate list is still useful without the spend line.
    console.error('[discovery] Could not read spend total:', err.message);
  }

  return json({
    candidates,
    spent_usd: spent,
    ceiling_usd: Number.isFinite(ceiling) ? ceiling : null,
  });
}

async function handleDismissCandidate(request, env, id) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  await dismissCandidate(env.DB, id);
  return json({ success: true });
}

async function handleDiscoverNow(request, env) {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
  const result = await runDiscovery(env);
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

// Never throws -- callable from both an admin-triggered endpoint (needs a response)
// and ctx.waitUntil in the scheduled handler (no response to send). Every failure
// path returns a summary object instead, same convention as postSlot/generateForSlot.
async function runDiscovery(env) {
  if (env.XAI_DISCOVERY_PAUSED === 'true') {
    return { ran: false, reason: 'XAI_DISCOVERY_PAUSED is set' };
  }

  // A typo'd env var would make Number() return NaN, and `spent >= NaN` is always
  // false -- i.e. a run with no budget cap at all. Fail closed instead.
  const ceiling = budgetCeilingUsd(env);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    console.error(
      `[discovery] Invalid XAI_DISCOVERY_BUDGET_CEILING_USD: ${JSON.stringify(env.XAI_DISCOVERY_BUDGET_CEILING_USD)}`
    );
    return { ran: false, reason: 'invalid budget ceiling' };
  }

  // If we cannot read what has been spent, we cannot know we are under the
  // ceiling -- treat that as "do not spend", not as "$0 spent so far".
  let spent;
  try {
    spent = await getXaiSpendTotalUsd(env.DB);
  } catch (err) {
    console.error('[discovery] Could not read spend total:', err.message);
    return { ran: false, reason: 'could not read spend total' };
  }
  if (spent >= ceiling) {
    return { ran: false, reason: `Budget ceiling reached: $${spent.toFixed(2)} spent of $${ceiling.toFixed(2)}` };
  }

  // Extraction needs real games to ground against (both to give the model a
  // verbatim-reuse list, and to verify what it returns) -- without odds data
  // there is nothing to validate an extracted game/time against, so this run
  // is skipped entirely rather than proceeding ungrounded. Same fail-closed
  // posture as generateForSlot's own odds-fetch failure handling.
  let oddsGames;
  try {
    oddsGames = await getUpcomingOdds(env);
  } catch (err) {
    console.error('[discovery] Odds fetch failed, cannot ground extractions:', err.message);
    return { ran: false, reason: 'odds fetch failed' };
  }

  const handles = [];
  for (const author of TRACKED_AUTHORS) {
    const handle = author.replace(/^@/, '');
    // Everything for one handle -- the API call and all its D1 writes -- is
    // isolated here, so one handle's failure never aborts the remaining handles
    // and never escapes as an unhandled rejection under ctx.waitUntil.
    let result = null;
    let spendLogged = false;
    try {
      result = await discoverCandidatesForHandle(env, handle, oddsGames);

      // Log spend FIRST, before anything that could fail: a post-200 parse error
      // still cost real money, and that record is the budget's source of truth.
      await logXaiSpend(env.DB, { handle, costUsdTicks: result.costUsdTicks, estimatedUsd: result.estimatedUsd });
      spendLogged = true;

      if (result.error) {
        console.error(`[discovery] Failed for ${handle}:`, result.error);
        handles.push({ handle, found: 0, estimated_usd: result.estimatedUsd, error: result.error });
        continue;
      }

      const candidates = [];
      for (const post of result.posts) {
        const tweetId = parseTweetId(post.url);
        if (!tweetId) continue;
        if (await isTweetIngested(env.DB, tweetId)) continue;
        // Same grounding check the AI-generation pipeline already uses in
        // production -- an extracted game/time that doesn't match a real
        // upcoming game is discarded, not surfaced, regardless of how
        // confident the model's own self-filtering claimed to be.
        if (!matchesRealGame({ game: post.game, game_time_utc: post.game_time_utc }, oddsGames)) continue;
        candidates.push({
          handle: author,
          tweet_id: tweetId,
          post_text: post.text,
          post_url: post.url,
          posted_at: post.posted_at,
          pick_type: post.pick_type,
          game: post.game,
          game_time_utc: post.game_time_utc,
          pick_text: post.pick_text,
        });
      }
      await insertDiscoveredCandidates(env.DB, candidates);

      handles.push({ handle, found: candidates.length, estimated_usd: result.estimatedUsd });
    } catch (err) {
      console.error(`[discovery] Failed for ${handle}:`, err.message);
      if (result && !spendLogged) {
        console.error(
          `[discovery] UNLOGGED SPEND: ~$${result.estimatedUsd.toFixed(4)} billed for ${handle} but not written to xai_spend_log`
        );
      }
      handles.push({
        handle,
        found: 0,
        estimated_usd: result?.estimatedUsd ?? 0,
        error: err.message,
        spend_logged: spendLogged,
      });
    }
  }

  return { ran: true, handles };
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
      if (pathname === '/api/go/affiliate' && request.method === 'GET') {
        return await handleAffiliateGo(request, env);
      }
      if (pathname === '/api/admin/funnel' && request.method === 'GET') {
        return await handleAdminFunnel(request, env);
      }
      if (pathname === '/api/admin/pipeline-status' && request.method === 'GET') {
        return await handleAdminPipelineStatus(request, env);
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
      if (pathname === '/api/admin/discovered-candidates' && request.method === 'GET') {
        return await handleGetDiscoveredCandidates(request, env);
      }
      const dismissMatch = pathname.match(/^\/api\/admin\/discovered-candidates\/(\d+)\/dismiss$/);
      if (dismissMatch && request.method === 'POST') {
        return await handleDismissCandidate(request, env, Number(dismissMatch[1]));
      }
      if (pathname === '/api/admin/discover' && request.method === 'POST') {
        return await handleDiscoverNow(request, env);
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
    const hour = fired.getUTCHours();
    const minute = fired.getUTCMinutes();
    if (isGenerationDay && minute === 0 && SLOT_HOURS[hour]) {
      ctx.waitUntil(generateAndPostSlot(env, SLOT_HOURS[hour]));
    } else if (isGenerationDay && hour === 22 && minute === 15) {
      // Only this specific firing is meaningful -- 13:15/17:15 also match this cron
      // (consolidated to stay under Cloudflare's account-wide 5-trigger cap) but fall
      // through to the branch below, which is already a safe no-op there.
      ctx.waitUntil(generateAndPostPropsSlot(env));
    } else if (isGenerationDay && hour === 12 && minute === 30) {
      ctx.waitUntil(runDiscovery(env));
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
