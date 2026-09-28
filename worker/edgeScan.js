// Edge logger orchestration: schedule check -> free balance check -> paid odds fetch ->
// D1 writes. All math and timing rules live in pure modules; this file only does I/O.
import { findEdges, closingUpdates, edgeKey, pinnacleCloses, closeForEdge } from './edges.js';
import {
  isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, toFeedIso, ALL_MARKETS,
  effectiveReserve, parseReserve, parsePositiveInt, detectResetDay,
  DEFAULT_CREDITS_PER_DAY, DEFAULT_QUOTA_RESET_DAY,
} from './edgeSchedule.js';
import { EDGE_SPORTS, fetchSharpComparison, getRemainingCredits } from './oddsApi.js';

// D1 allows 50 queries per invocation on the free plan: 15 upserts + 15 close updates +
// the handful of selects/inserts around them stays under it, leaving headroom for
// handleDailyPostCheck (~5 queries) when it shares the same invocation.
const MAX_WRITES_PER_KIND = 15;

// markets: sport -> markets to request. Discovery asks for everything; a closing scan only
// for the markets with logged edges kicking off in its window (1 credit per market).
async function dueScan(db, scheduledMs) {
  if (isDiscoveryTick(scheduledMs)) {
    return { kind: 'discovery', markets: new Map(EDGE_SPORTS.map((s) => [s, ALL_MARKETS])) };
  }
  const { fromIso, toIso } = closingWindow(scheduledMs);
  const { results } = await db
    .prepare(`SELECT DISTINCT sport, market FROM edges WHERE commence_time >= ? AND commence_time < ?`)
    .bind(fromIso, toIso)
    .all();
  const markets = new Map();
  for (const { sport, market } of results) {
    const list = markets.get(sport) || [];
    // An unknown market can't be narrowed down safely; fall back to all three.
    const add = ALL_MARKETS.includes(market) ? [market] : ALL_MARKETS;
    markets.set(sport, [...new Set([...list, ...add])]);
  }
  return { kind: 'closing', markets };
}

function recordScan(db, { kind, sports, ran, reason = null, remaining = null, found = null }) {
  return db
    .prepare(
      `INSERT INTO edge_scans (kind, sports, ran, reason, credits_remaining, edges_found) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(kind, sports.join(','), ran, reason, remaining, found)
    .run();
}

export async function runEdgeScan(env, scheduledMs, deps = {}) {
  const fetchOdds = deps.fetchSharpComparison || fetchSharpComparison;
  const getBalance = deps.getRemainingCredits || getRemainingCredits;
  const db = env.DB;

  if (!isEdgeTick(scheduledMs)) return { ran: false, reason: 'not an edge tick' };

  const { kind, markets } = await dueScan(db, scheduledMs);
  const sports = [...markets.keys()];
  if (sports.length === 0) return { ran: false, reason: 'nothing due' };
  const credits = [...markets.values()].reduce((n, list) => n + list.length, 0);

  if (env.EDGE_SCAN_PAUSED === 'true') {
    await recordScan(db, { kind, sports, ran: 0, reason: 'paused' });
    return { ran: false, reason: 'paused', kind };
  }

  const remaining = await getBalance(env);
  // Discovery (the product) only has to clear the floor. Closing scans must also leave
  // the credits held back for the discovery scans still to come before the quota resets,
  // so when credits run low the closes stop first.
  const floor = parseReserve(env.EDGE_SCAN_RESERVE);
  let reserve = floor;
  if (kind === 'closing') {
    // The reset day comes from the balance history once a reset has been seen; until then
    // the configured guess stands.
    const { results: history } = await db
      .prepare(
        `SELECT credits_remaining, scanned_at FROM edge_scans WHERE credits_remaining IS NOT NULL
         ORDER BY id DESC LIMIT 60`
      )
      .all();
    reserve = effectiveReserve(scheduledMs, {
      floor,
      perDay: parsePositiveInt(env.EDGE_PIPELINE_CREDITS_PER_DAY, DEFAULT_CREDITS_PER_DAY),
      resetDay:
        detectResetDay([...history].reverse()) ??
        parsePositiveInt(env.EDGE_QUOTA_RESET_DAY, DEFAULT_QUOTA_RESET_DAY),
    });
  }
  if (!withinBudget(remaining, credits, reserve)) {
    console.log(`[edges] ${kind} scan skipped by budget guard (remaining=${remaining})`);
    await recordScan(db, { kind, sports, ran: 0, reason: 'budget', remaining });
    return { ran: false, reason: 'budget', kind };
  }

  const results = await Promise.allSettled(
    sports.map((sport) => fetchOdds(env, sport, scheduledMs, markets.get(sport).join(',')))
  );
  const events = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') events.push(...r.value);
    else console.error(`[edges] odds fetch failed for ${sports[i]}:`, r.reason?.message);
  });
  if (results.every((r) => r.status === 'rejected')) {
    await recordScan(db, { kind, sports, ran: 0, reason: 'fetch failed', remaining });
    return { ran: false, reason: 'fetch failed', kind };
  }

  // 1. Upsert edges: first_* fields stick; peak and last-seen advance.
  const found = findEdges(events, scheduledMs).sort((a, b) => b.ev - a.ev);
  if (found.length > MAX_WRITES_PER_KIND) {
    console.warn(`[edges] ${found.length} edges found, logging the top ${MAX_WRITES_PER_KIND}`);
  }

  let closes = [];
  try {
    const upserts = found.slice(0, MAX_WRITES_PER_KIND).map((e) =>
      db
        .prepare(
          `INSERT INTO edges (event_id, sport, game, commence_time, market, outcome, point, book,
             first_price, first_fair_prob, first_ev, peak_ev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id, market, outcome, COALESCE(point, -9999), book)
           DO UPDATE SET peak_ev = MAX(peak_ev, excluded.first_ev), last_edge_seen_at = datetime('now'),
             commence_time = excluded.commence_time`
        )
        .bind(e.event_id, e.sport, e.game, e.commence_time, e.market, e.outcome, e.point, e.book,
          e.price, e.fair_prob, e.ev, e.ev)
    );
    if (upserts.length > 0) await db.batch(upserts);

    // 2. Refresh the closing line of every logged edge whose game hasn't started. The last
    //    write before kickoff stands as the close.
    // Ordered soonest-first so that if there are more open edges than MAX_WRITES_PER_KIND,
    // the write cap below keeps the ones about to kick off rather than an arbitrary slice.
    const { results: openEdges } = await db
      .prepare(
        `SELECT id, event_id, sport, market, outcome, point, book FROM edges WHERE commence_time > ?
         ORDER BY commence_time ASC`
      )
      .bind(toFeedIso(scheduledMs))
      .all();
    // The fair price comes from Pinnacle at its current line (adjusted back to the logged
    // point if the line moved -- see closeForEdge); the book's own price is informational
    // and null when it no longer offers the logged number.
    const latest = new Map(closingUpdates(events, scheduledMs).map((c) => [edgeKey(c), c]));
    const pinCloses = pinnacleCloses(events, scheduledMs);
    for (const row of openEdges) {
      const c = closeForEdge(row, pinCloses);
      if (!c) continue;
      closes.push(
        db
          .prepare(
            `UPDATE edges SET close_price = ?, close_fair_prob = ?, close_updated_at = datetime('now'),
               commence_time = ?, close_point = ? WHERE id = ?`
          )
          .bind(latest.get(edgeKey(row))?.price ?? null, c.fair_prob, c.commence_time, c.point, row.id)
      );
    }
    if (closes.length > MAX_WRITES_PER_KIND) {
      console.warn(`[edges] ${closes.length} closes to refresh, writing ${MAX_WRITES_PER_KIND}`);
    }
    if (closes.length > 0) await db.batch(closes.slice(0, MAX_WRITES_PER_KIND));
  } catch (err) {
    // A D1 failure partway through the write phase (upserts, open-edge select, closes)
    // would otherwise leave no edge_scans row at all for this due scan. Best-effort record
    // it as a db error -- a failure of that record itself must not mask the real error.
    try {
      await recordScan(db, { kind, sports, ran: 0, reason: 'db error', remaining });
    } catch (recordErr) {
      console.error(`[edges] failed to record db-error scan:`, recordErr.message);
    }
    throw err;
  }

  await recordScan(db, { kind, sports, ran: 1, remaining, found: found.length });
  console.log(`[edges] ${kind} scan: ${found.length} edges, ${closes.length} closes updated`);
  return { ran: true, kind, found: found.length, closesUpdated: closes.length };
}
