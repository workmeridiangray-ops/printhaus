-- Print Haus — D1 schema
-- Run once with: wrangler d1 execute printhaus --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  password   TEXT NOT NULL,          -- hashed (PBKDF2, see worker.js) — never stored plain
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,       -- random session token, sent as a cookie/bearer value
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,      -- e.g. PF-xxxxxxxx
  user_id     INTEGER NOT NULL REFERENCES users(id),
  customer    TEXT NOT NULL,
  phone       TEXT,
  address     TEXT,
  note        TEXT,
  subtotal    REAL NOT NULL,
  gst         REAL NOT NULL,
  total       REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Received',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       TEXT,
  opt        TEXT,
  qty        INTEGER NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id             TEXT PRIMARY KEY,   -- e.g. Q-xxxxxxxx
  company        TEXT,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  whatsapp       TEXT,
  department     TEXT,
  order_number   TEXT,
  message        TEXT,
  product        TEXT,
  status         TEXT NOT NULL DEFAULT 'New',   -- New / In Progress / Quoted / Closed
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
