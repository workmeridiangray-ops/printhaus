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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        TEXT,
  opt         TEXT,
  qty         INTEGER NOT NULL,
  unit_price  REAL NOT NULL,
  artwork_key TEXT  -- R2 object key for an uploaded artwork file, if any
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

-- ---------- Gap-closing modules (abandoned cart, order updates, payments,
-- refunds/GST, job card [reuses job_orders], proof approval, margin report
-- [reuses job_orders], settings, activity log) ----------

-- Abandoned-cart tracking. The frontend pings this whenever a logged-in
-- user's cart changes; the scheduled() cron sweeps it for 1hr/24hr reminders
-- and marks reminded_1h / reminded_24h so each only fires once per cart.
CREATE TABLE IF NOT EXISTS carts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  items_json    TEXT NOT NULL,            -- snapshot of cart items at last update
  status        TEXT NOT NULL DEFAULT 'Active',  -- Active / Reminded / Recovered / Abandoned
  reminded_1h   INTEGER NOT NULL DEFAULT 0,
  reminded_24h  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Order status timeline + outbound email/notification log, so every
-- "received / artwork approved / printing / shipped" message is both a
-- record and a trigger (the cron / PATCH handler inserts a row here and
-- sends the matching email in the same step).
CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  status      TEXT NOT NULL,
  tracking    TEXT,                       -- tracking number/link, set on "Shipped"
  note        TEXT,
  emailed     INTEGER NOT NULL DEFAULT 0, -- 1 once the notification email succeeded
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payments: advance + balance + reminders. One row per payment event
-- (advance request, advance paid, balance request, balance paid). The pay
-- link is a stub (`pay_link`) until a gateway key is configured — see
-- worker.js createPayLink().
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,          -- e.g. PAY-xxxxxxxx
  order_id      TEXT NOT NULL REFERENCES orders(id),
  kind          TEXT NOT NULL,             -- 'advance' or 'balance'
  amount        REAL NOT NULL,
  pay_link      TEXT,
  status        TEXT NOT NULL DEFAULT 'Pending',  -- Pending / Paid / Cancelled
  reminded_at   TEXT,                       -- last reminder timestamp, for the reminder cron
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Credit notes / refunds, with GST reversed correctly (CGST+SGST for
-- intra-state, IGST for inter-state — `gst_mode` picks which applies).
CREATE TABLE IF NOT EXISTS credit_notes (
  id          TEXT PRIMARY KEY,            -- e.g. CN-xxxxxxxx
  order_id    TEXT NOT NULL REFERENCES orders(id),
  reason      TEXT NOT NULL,
  taxable_amount REAL NOT NULL,            -- refund amount excl. GST
  gst_mode    TEXT NOT NULL DEFAULT 'CGST_SGST',  -- CGST_SGST or IGST
  gst_rate    REAL NOT NULL DEFAULT 18,
  cgst        REAL NOT NULL DEFAULT 0,
  sgst        REAL NOT NULL DEFAULT 0,
  igst        REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL,               -- taxable_amount + gst
  status      TEXT NOT NULL DEFAULT 'Issued',  -- Issued / Refunded
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Artwork proof approval: a public token-based link sent to the customer;
-- they approve or request changes without needing an account.
CREATE TABLE IF NOT EXISTS proof_approvals (
  token         TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES job_orders(id),
  file_url      TEXT,
  status        TEXT NOT NULL DEFAULT 'Pending',  -- Pending / Approved / Changes Requested
  customer_note TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at  TEXT
);

-- Business settings — single-row table (id always 1) covering the
-- "setup page for new shops" item: name, GSTIN, address, logo, bank,
-- colours, alert email, default material cost %.
CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  business_name     TEXT NOT NULL DEFAULT 'Print Haus',
  gstin             TEXT,
  address           TEXT,
  logo_url          TEXT,
  bank_details       TEXT,
  brand_color       TEXT DEFAULT '#3c6b48',
  alert_email       TEXT,
  default_cost_pct  REAL NOT NULL DEFAULT 60,   -- used by the margin report when a job has no cost entered
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

-- Admin activity log — covers "more staff roles + an activity log".
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT,                        -- admin key label or staff email
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Artwork file uploads (R2-backed). Added via live migration; mirrored here
-- for fresh deploys.
CREATE TABLE IF NOT EXISTS uploads (
  key          TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  filename     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedupes a request by a client-generated key (sent as the
-- X-Idempotency-Key header) so a double-click, network retry, or payment
-- callback replay can't create a second order for the same submission.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  route       TEXT NOT NULL,
  order_id    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple D1-backed sliding-window rate limiter (see rateLimit() in
-- worker.js). One row per request attempt on a limited route; old rows
-- are pruned on each check so the table doesn't grow unbounded.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket      TEXT NOT NULL,     -- e.g. 'login:1.2.3.4'
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Product catalogue. Each product's full size -> option -> [[qty,price],...]
-- pricing table is stored as ONE JSON blob per product (sizes_json), not as
-- normalized rows. calc-data.json has 282,561 individual price-tier rows
-- across 225 products; a fully normalized schema would blow D1's free-tier
-- daily write cap (100,000/day) on the first migration run alone, and isn't
-- needed for what admin editing actually requires — editing one product's
-- whole price table at a time. 225 products = 225 blob writes.
CREATE TABLE IF NOT EXISTS products (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cat           TEXT NOT NULL,
  subcat        TEXT,
  mode          TEXT,
  qty_range     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  sizes_json    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    TEXT
);

-- Lightweight audit trail for product edits (who changed what, when) —
-- records the action and a short detail string, not a full before/after
-- diff of the (potentially large) pricing blob.
CREATE TABLE IF NOT EXISTS product_edit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,  -- 'create' / 'update' / 'archive' / 'unarchive' / 'duplicate'
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_carts_user          ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_carts_status         ON carts(status);
CREATE INDEX IF NOT EXISTS idx_orderevents_order    ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order       ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status      ON payments(status);
CREATE INDEX IF NOT EXISTS idx_creditnotes_order    ON credit_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_proofapprovals_job   ON proof_approvals(job_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_user     ON idempotency_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_ratelimit_bucket_time ON rate_limit_hits(bucket, created_at);
CREATE INDEX IF NOT EXISTS idx_products_cat         ON products(cat);
CREATE INDEX IF NOT EXISTS idx_products_active      ON products(active);
CREATE INDEX IF NOT EXISTS idx_productedit_slug     ON product_edit_log(slug);
