-- ==========================================================
-- Nova Nation Exchange — SQLite schema
-- Auto-applied on server boot (idempotent).
-- ==========================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT,
  class_year TEXT,
  city TEXT,
  stripe_account_id TEXT,
  charges_enabled INTEGER DEFAULT 0,
  payouts_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS magic_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_magic_user ON magic_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,                   -- M01, W03, etc.
  sport TEXT NOT NULL,                   -- mbb | wbb
  sport_label TEXT NOT NULL,
  opponent TEXT NOT NULL,
  is_home INTEGER NOT NULL DEFAULT 0,
  is_neutral INTEGER NOT NULL DEFAULT 0,
  date_label TEXT NOT NULL,              -- 'Sat, Jan 24'
  date_iso TEXT NOT NULL,                -- '2026-01-24T16:30:00-05:00'
  time_label TEXT NOT NULL,              -- '4:30 PM'
  venue TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  row TEXT,
  seat TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  face_cents INTEGER NOT NULL DEFAULT 0,
  ask_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | sold | cancelled
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, game_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_id INTEGER REFERENCES users(id),
  buyer_email TEXT NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  ticket_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  proc_cents INTEGER NOT NULL,
  vase_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | refunded | failed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_listing ON transactions(listing_id);
CREATE INDEX IF NOT EXISTS idx_tx_session ON transactions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_tx_pi      ON transactions(stripe_payment_intent_id);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  status TEXT NOT NULL DEFAULT 'awaiting_seller', -- awaiting_seller | sent | confirmed | disputed
  seller_marked_at TEXT,
  buyer_confirmed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vase_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  amount_cents INTEGER NOT NULL,
  remitted INTEGER DEFAULT 0,
  remitted_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_slug TEXT NOT NULL,
  business_name TEXT NOT NULL,
  neighborhood TEXT,
  code TEXT NOT NULL,
  vase_match_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_created ON redemptions(created_at);
