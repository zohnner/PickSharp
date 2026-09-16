export async function getPicks(db, { sinceDays } = {}) {
  let query = `
    SELECT p.id, p.author, p.pick_text, p.pick_type, p.confidence, p.game, p.game_time,
           p.affiliate_link, p.created_at, COALESCE(s.win_rate, 55.0) AS win_rate
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
  const { author, pick_text, pick_type, confidence, game, game_time, affiliate_link } = pick;
  const result = await db
    .prepare(
      `INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time, affiliate_link)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'https://ak.draftkings.com'))`
    )
    .bind(author, pick_text, pick_type, confidence, game, game_time, affiliate_link || null)
    .run();
  return result.meta.last_row_id;
}

export async function deletePickById(db, id) {
  await db.prepare('DELETE FROM picks WHERE id = ?').bind(id).run();
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
