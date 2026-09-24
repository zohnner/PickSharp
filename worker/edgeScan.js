// Edge logger orchestration: schedule check -> free balance check -> paid odds fetch ->
// D1 writes. All math and timing rules live in pure modules; this file only does I/O.
import { findEdges, closingUpdates, edgeKey } from './edges.js';
import {
  isEdgeTick, isDiscoveryTick, closingWindow, withinBudget, toFeedIso,
  effectiveReserve, parseReserve, parsePositiveInt,
  DEFAULT_CREDITS_PER_DAY, DEFAULT_QUOTA_RESET_DAY,
} from './edgeSchedule.js';
import { EDGE_SPORTS, fetchSharpComparison, getRemainingCredits } from './oddsApi.js';

// D1 allows 50 queries per invocation on the free plan: 20 upserts + 20 close updates +
// the handful of selects/inserts around them stays under it.
const MAX_WRITES_PER_KIND = 20;

async function dueScan(db, scheduledMs) {
  if (isDiscoveryTick(scheduledMs)) return { kind: 'discovery', sports: EDGE_SPORTS };
  const { fromIso, toIso } = closingWindow(scheduledMs);
  const { results } = await db
    .prepare(`SELECT DISTINCT sport FROM edges WHERE commence_time >= ? AND commence_time < ?`)
    .bind(fromIso, toIso)
    .all();
  return { kind: 'closing', sports: results.map((r) => r.sport) };
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

  const { kind, sports } = await dueScan(db, scheduledMs);
  if (sports.length === 0) return { ran: false, reason: 'nothing due' };

  if (env.EDGE_SCAN_PAUSED === 'true') {
    await recordScan(db, { kind, sports, ran: 0, reason: 'paused' });
    return { ran: false, reason: 'paused', kind };
  }

  const remaining = await getBalance(env);
  const reserve = effectiveReserve(scheduledMs, {
    floor: parseReserve(env.EDGE_SCAN_RESERVE),
    perDay: parsePositiveInt(env.EDGE_PIPELINE_CREDITS_PER_DAY, DEFAULT_CREDITS_PER_DAY),
    resetDay: parsePositiveInt(env.EDGE_QUOTA_RESET_DAY, DEFAULT_QUOTA_RESET_DAY),
  });
  if (!withinBudget(remaining, sports.length, reserve)) {
    console.log(`[edges] ${kind} scan skipped by budget guard (remaining=${remaining})`);
    await recordScan(db, { kind, sports, ran: 0, reason: 'budget', remaining });
    return { ran: false, reason: 'budget', kind };
  }

  const results = await Promise.allSettled(sports.map((sport) => fetchOdds(env, sport, scheduledMs)));
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
  const upserts = found.slice(0, MAX_WRITES_PER_KIND).map((e) =>
    db
      .prepare(
        `INSERT INTO edges (event_id, sport, game, commence_time, market, outcome, point, book,
           first_price, first_fair_prob, first_ev, peak_ev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, market, outcome, COALESCE(point, -9999), book)
         DO UPDATE SET peak_ev = MAX(peak_ev, excluded.first_ev), last_edge_seen_at = datetime('now')`
      )
      .bind(e.event_id, e.sport, e.game, e.commence_time, e.market, e.outcome, e.point, e.book,
        e.price, e.fair_prob, e.ev, e.ev)
  );
  if (upserts.length > 0) await db.batch(upserts);

  // 2. Refresh the closing line of every logged edge whose game hasn't started. The last
  //    write before kickoff stands as the close.
  const { results: openEdges } = await db
    .prepare(`SELECT id, event_id, market, outcome, point, book FROM edges WHERE commence_time > ?`)
    .bind(toFeedIso(scheduledMs))
    .all();
  const latest = new Map(closingUpdates(events, scheduledMs).map((c) => [edgeKey(c), c]));
  const closes = [];
  for (const row of openEdges) {
    const c = latest.get(edgeKey(row));
    if (!c) continue;
    closes.push(
      db
        .prepare(`UPDATE edges SET close_price = ?, close_fair_prob = ?, close_updated_at = datetime('now') WHERE id = ?`)
        .bind(c.price, c.fair_prob, row.id)
    );
  }
  if (closes.length > MAX_WRITES_PER_KIND) {
    console.warn(`[edges] ${closes.length} closes to refresh, writing ${MAX_WRITES_PER_KIND}`);
  }
  if (closes.length > 0) await db.batch(closes.slice(0, MAX_WRITES_PER_KIND));

  await recordScan(db, { kind, sports, ran: 1, remaining, found: found.length });
  console.log(`[edges] ${kind} scan: ${found.length} edges, ${closes.length} closes updated`);
  return { ran: true, kind, found: found.length, closesUpdated: closes.length };
}
