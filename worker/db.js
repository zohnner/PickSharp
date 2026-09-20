export async function getPicks(db, { sinceDays } = {}) {
  let query = `
    SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
           p.affiliate_link, p.slot, p.game_time_utc, p.source_tweet_url, p.source_tweet_id, p.verified, p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
    FROM picks p
    LEFT JOIN picker_stats s ON s.author = p.author
  `;
  const params = [];
  if (sinceDays) {
    query += ` WHERE p.created_at >= datetime('now', ?)`;
    params.push(`-${sinceDays} days`);
  }
  query += ' ORDER BY p.created_at DESC';

  const { results } = await db.prepare(query).bind(...params).all();
  return results;
}

export async function insertPick(db, pick) {
  const {
    author, pick_text, pick_type, confidence, game, game_time,
    affiliate_link, slot, game_time_utc, source_tweet_url, source_tweet_id,
  } = pick;

  const insertStmt = db
    .prepare(
      `INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, affiliate_link, slot, game_time_utc, source_tweet_url, source_tweet_id)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'https://ak.draftkings.com'), ?, ?, ?, ?)`
    )
    .bind(
      author, pick_text, pick_type, confidence, game, game_time,
      affiliate_link || null, slot || 'manual', game_time_utc || null,
      source_tweet_url || null, source_tweet_id || null
    );

  if (source_tweet_id) {
    const ingestStmt = db
      .prepare(`INSERT INTO ingested_tweets (tweet_id, author) VALUES (?, ?)`)
      .bind(source_tweet_id, author);
    const [insertResult] = await db.batch([insertStmt, ingestStmt]);
    return insertResult.meta.last_row_id;
  }

  const result = await insertStmt.run();
  return result.meta.last_row_id;
}

export async function isTweetIngested(db, tweetId) {
  const row = await db.prepare('SELECT 1 FROM ingested_tweets WHERE tweet_id = ?').bind(tweetId).first();
  return Boolean(row);
}

export async function markPickVerified(db, id, confidence) {
  await db.prepare('UPDATE picks SET verified = 1, confidence = ? WHERE id = ?').bind(confidence, id).run();
}

export async function deletePickById(db, id) {
  await db.batch([
    db.prepare('DELETE FROM ingested_tweets WHERE tweet_id = (SELECT source_tweet_id FROM picks WHERE id = ?)').bind(id),
    db.prepare('DELETE FROM picks WHERE id = ?').bind(id),
  ]);
}

export async function upsertUser(db, { id, email }) {
  await db
    .prepare(
      `INSERT INTO users (id, email) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email`
    )
    .bind(id, email)
    .run();
}

export async function getUserById(db, id) {
  return db.prepare('SELECT id, email, is_premium, created_at FROM users WHERE id = ?').bind(id).first();
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export async function getTodaysPicksRaw(db, { includeUnverified = false } = {}) {
  const gate = includeUnverified ? '' : 'AND (p.verified = 1 OR p.source_tweet_id IS NULL)';
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
              p.affiliate_link, p.slot, p.game_time_utc, p.source_tweet_url, p.source_tweet_id, p.verified,
              p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
       FROM picks p
       LEFT JOIN picker_stats s ON s.author = p.author
       WHERE date(p.created_at, '-4 hours') = date('now', '-4 hours')
       ${gate}
       ORDER BY p.created_at ASC`
    )
    .all();
  return results;
}

export function freePickId(picks) {
  if (picks.length === 0) return null;
  const freest = picks.reduce((current, pick) => {
    if (!current) return pick;
    const rank = CONFIDENCE_RANK[pick.confidence] ?? 1;
    const currentRank = CONFIDENCE_RANK[current.confidence] ?? 1;
    if (rank < currentRank) return pick;
    if (rank === currentRank && pick.created_at < current.created_at) return pick;
    return current;
  }, null);
  return freest.id;
}

export async function getPicksByIds(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
              p.affiliate_link, p.game_time_utc, p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
       FROM picks p
       LEFT JOIN picker_stats s ON s.author = p.author
       WHERE p.id IN (${placeholders})`
    )
    .bind(...ids)
    .all();
  return results;
}

export async function getUnlockedPickIds(db, buyerToken) {
  if (!buyerToken) return new Set();
  const { results } = await db
    .prepare('SELECT DISTINCT pick_id FROM pick_unlocks WHERE buyer_token = ?')
    .bind(buyerToken)
    .all();
  return new Set(results.map((r) => r.pick_id));
}

export async function insertUnlocks(db, { buyerToken, pickIds, stripeSessionId }) {
  const stmts = pickIds.map((pickId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO pick_unlocks (buyer_token, pick_id, stripe_session_id)
         VALUES (?, ?, ?)`
      )
      .bind(buyerToken, pickId, stripeSessionId)
  );
  await db.batch(stmts);
}
