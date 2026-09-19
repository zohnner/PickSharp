CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- Supabase auth user id (uuid)
  email TEXT NOT NULL UNIQUE,
  is_premium INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  pick_type TEXT NOT NULL CHECK (pick_type IN ('spread', 'moneyline', 'prop', 'over_under')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  game TEXT NOT NULL,
  game_time TEXT NOT NULL,
  affiliate_link TEXT NOT NULL DEFAULT 'https://ak.draftkings.com',
  slot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS picker_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL UNIQUE,
  win_rate REAL NOT NULL DEFAULT 55.0,
  total_picks INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,         -- e.g. 'affiliate_click', 'pick_view'
  pick_id INTEGER,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pick_id) REFERENCES picks(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pick_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_token TEXT NOT NULL,
  pick_id INTEGER NOT NULL,
  stripe_session_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pick_id) REFERENCES picks(id),
  UNIQUE (stripe_session_id, pick_id)
);

CREATE INDEX IF NOT EXISTS idx_pick_unlocks_buyer ON pick_unlocks(buyer_token);
CREATE INDEX IF NOT EXISTS idx_picks_created_at ON picks(created_at);

CREATE TABLE IF NOT EXISTS daily_posts (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_id TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);

CREATE TABLE IF NOT EXISTS buyer_sources (
  buyer_token TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed data: hardcoded MVP test picks
INSERT OR IGNORE INTO picker_stats (author, win_rate) VALUES
  ('@CodyBrownBets', 55),
  ('@SharpFootball', 55),
  ('@jasonrmcintyre', 55),
  ('@DocsSports', 55),
  ('@nflpickspage', 55);

INSERT INTO picks (author, pick_text, pick_type, confidence, game, game_time) VALUES
  ('@CodyBrownBets', 'Kansas City -5.5', 'spread', 'high', 'KC @ BAL', 'Sept 15 1:00 PM'),
  ('@SharpFootball', 'Over 47', 'over_under', 'medium', 'KC @ BAL', 'Sept 15 1:00 PM'),
  ('@jasonrmcintyre', 'Bills ML', 'moneyline', 'high', 'BUF @ MIA', 'Sept 15 4:25 PM'),
  ('@DocsSports', 'Josh Allen 280+ passing', 'prop', 'medium', 'BUF @ MIA', 'Sept 15 4:25 PM'),
  ('@nflpickspage', 'Under 41', 'over_under', 'low', 'DAL @ NYG', 'Sept 15 8:20 PM');
