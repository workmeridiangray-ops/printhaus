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

-- ---------- Job orders (production tracking — the ERPNext-equivalent piece) ----------
-- A job order is opened by an admin from either a paid order or a quote
-- request, and tracked through production stages with basic costing
-- (material/labor/overhead vs. the quoted/sold price), replacing what a
-- separate ERPNext Sales-Order-to-Work-Order flow would have done.
CREATE TABLE IF NOT EXISTS job_orders (
  id              TEXT PRIMARY KEY,         -- e.g. JOB-xxxxxxxx
  source_type     TEXT NOT NULL,            -- 'order' or 'quote'
  source_id       TEXT NOT NULL,            -- orders.id or quotes.id
  title           TEXT NOT NULL,            -- short description, e.g. "500 Business Cards - Matte"
  customer_name   TEXT,
  customer_email  TEXT,
  stage           TEXT NOT NULL DEFAULT 'Queued',  -- Queued / Design / Prepress / Printing / Finishing / QC / Ready / Dispatched / Delivered / On Hold / Cancelled
  priority        TEXT NOT NULL DEFAULT 'Normal',  -- Low / Normal / High / Rush
  due_date        TEXT,
  material_cost   REAL NOT NULL DEFAULT 0,
  labor_cost      REAL NOT NULL DEFAULT 0,
  overhead_cost   REAL NOT NULL DEFAULT 0,
  quoted_price    REAL NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stage-change history / production log for each job order.
CREATE TABLE IF NOT EXISTS job_order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES job_orders(id),
  stage       TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_joborders_stage  ON job_orders(stage);
CREATE INDEX IF NOT EXISTS idx_joborders_source ON job_orders(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_jobevents_job    ON job_order_events(job_id);
