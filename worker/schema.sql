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

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  game TEXT NOT NULL,
  commence_time TEXT NOT NULL,          -- odds-feed format YYYY-MM-DDTHH:MM:SSZ
  market TEXT NOT NULL,                 -- h2h | spreads | totals
  outcome TEXT NOT NULL,
  point REAL,                           -- NULL for h2h
  book TEXT NOT NULL,
  first_price REAL NOT NULL,            -- decimal price when first seen
  first_fair_prob REAL NOT NULL,
  first_ev REAL NOT NULL,
  peak_ev REAL NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_edge_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  close_price REAL,
  close_fair_prob REAL,
  close_updated_at TEXT,
  -- Pinnacle's closing line. When it differs from point, close_fair_prob was adjusted
  -- back to the logged point (edges.js closeForEdge) and the CLV is an estimate.
  -- Added 2026-09-26 on existing DBs: ALTER TABLE edges ADD COLUMN close_point REAL;
  close_point REAL
);

-- NULLs are distinct in SQLite UNIQUE constraints, so h2h rows dedupe via a sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS edges_identity
  ON edges (event_id, market, outcome, COALESCE(point, -9999), book);

CREATE INDEX IF NOT EXISTS edges_commence ON edges (commence_time);

-- One row per scan that was due, whether it ran or was skipped, so thin data from
-- skipped scans is never mistaken for thin edges.
CREATE TABLE IF NOT EXISTS edge_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- discovery | closing
  sports TEXT NOT NULL,                 -- comma-separated sport keys
  ran INTEGER NOT NULL,                 -- 1 ran, 0 skipped
  reason TEXT,                          -- why skipped (NULL when ran)
  credits_remaining INTEGER,
  edges_found INTEGER,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email list for tonight's-edge alerts. buyer_token ties a signup back to the visit's
-- attribution (buyer_sources) without requiring an account.
CREATE TABLE IF NOT EXISTS email_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  buyer_token TEXT,
  source TEXT,                          -- where the form was shown, e.g. 'picks_page'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Addresses that opted out. Kept separate from email_signups so re-running this file
-- never needs an ALTER, and so an unsubscribe survives the address signing up again
-- until they explicitly re-subscribe (handleSubscribe clears the row).
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email TEXT PRIMARY KEY,
  unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per ET day the daily email went out: the idempotency guard against a second
-- slot (or a cron redelivery) emailing the list twice.
CREATE TABLE IF NOT EXISTS daily_emails (
  date TEXT PRIMARY KEY,
  recipients INTEGER,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Final scores for games that have logged edges, keyed by the Odds API event id and
-- stored with Odds API team names so edges grade directly against them. 'unmatched'
-- rows stop retries for games ESPN never returned a final for (see gradeGames.js).
CREATE TABLE IF NOT EXISTS game_results (
  event_id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL,                 -- final | unmatched
  graded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per alert sent per ET day: keeps a failure that repeats (cron redelivery,
-- the same slot failing on retry) from emailing the owner more than once a day.
CREATE TABLE IF NOT EXISTS admin_alerts (
  date TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, alert_key)
);

-- One row per weekly recap (week_start = the Monday's ET date, YYYYMMDD). Each channel is
-- claimed separately ('sending' -> done, or back to NULL on failure) so a retry never
-- double-posts a channel that already went out.
CREATE TABLE IF NOT EXISTS weekly_recaps (
  week_start TEXT PRIMARY KEY,
  tweet_status TEXT,                    -- NULL | sending | posted
  tweet_id TEXT,
  email_status TEXT,                    -- NULL | sending | sent
  email_recipients INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per daily results tweet (date = the Eastern date being reported, YYYYMMDD).
-- status NULL -> sending -> posted; a failed post resets it to NULL so a retry can claim it.
CREATE TABLE IF NOT EXISTS daily_results_posts (
  date TEXT PRIMARY KEY,
  status TEXT,
  tweet_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per rate-limited API action (x_post, email), counted against free-plan limits
-- by usage.js. Odds API credits and xAI spend are tracked elsewhere (edge_scans header
-- balance, xai_spend_log).
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS api_usage_service_time ON api_usage (service, created_at);
