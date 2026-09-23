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
  game_time_utc TEXT,
  source_tweet_url TEXT,
  source_tweet_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
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
  event_type TEXT NOT NULL,         -- 'checkout_started' | 'affiliate_click'
  pick_id INTEGER,
  buyer_token TEXT,                 -- most visitors never log in; track by buyer_token, not user_id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pick_id) REFERENCES picks(id)
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

CREATE TABLE IF NOT EXISTS ingested_tweets (
  tweet_id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buyer_sources (
  buyer_token TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS xai_spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  cost_usd_ticks INTEGER NOT NULL,
  estimated_usd REAL NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovered_tweet_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  post_text TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  posted_at TEXT,
  pick_type TEXT,
  game TEXT,
  game_time_utc TEXT,
  pick_text TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed INTEGER NOT NULL DEFAULT 0
);

-- No seed data: picker_stats rows are only ever inserted once a real win/loss
-- track record exists for an author -- never a fabricated default.
