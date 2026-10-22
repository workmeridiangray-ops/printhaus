/**
 * Print Haus — Cloudflare Worker API
 * -----------------------------------
 * Backs the storefront's accounts, orders, and quote requests with a real
 * D1 database instead of browser localStorage. Static assets (index.html,
 * calc-data.json, erpnext-client.js) are served by the [assets] binding
 * configured in wrangler.toml; this file only handles /api/* routes —
 * everything else falls through to the static asset binding automatically
 * when `[assets]` + `main` are both set (Workers tries the asset first).
 *
 * Routes:
 *   POST /api/signup        { name, email, password }            -> { token, user }
 *   POST /api/login         { email, password }                  -> { token, user }
 *   POST /api/logout        (Authorization: Bearer <token>)       -> { ok }
 *   GET  /api/me            (Authorization: Bearer <token>)       -> { user }
 *   POST /api/orders        (auth) { customer, phone, address, note, items, subtotal, gst, total }
 *   GET  /api/orders        (auth) -> { orders: [...] }           (own orders only)
 *   POST /api/quotes        { company?, name, email, whatsapp?, department?, orderNumber?, message, product? }
 *   GET  /api/admin/orders  (header: X-Admin-Key) -> { orders: [...] }   (all orders)
 *   GET  /api/admin/quotes  (header: X-Admin-Key) -> { quotes: [...] }
 *   PATCH /api/admin/quotes/:id  (header: X-Admin-Key) { status } -> { ok }
 *
 *   -- Job orders (production tracking, admin-only) --
 *   GET   /api/admin/job-orders              -> { jobOrders: [...] }
 *   POST  /api/admin/job-orders              { sourceType, sourceId, title, customerName, customerEmail,
 *                                               priority?, dueDate?, materialCost?, laborCost?, overheadCost?,
 *                                               quotedPrice?, notes? } -> { ok, jobOrder: { id } }
 *   PATCH /api/admin/job-orders/:id          { stage?, priority?, dueDate?, materialCost?, laborCost?,
 *                                               overheadCost?, quotedPrice?, notes?, eventNote? } -> { ok }
 *        (a stage change is logged to job_order_events automatically; pass
 *         eventNote to attach a note to that log entry)
 *   GET   /api/admin/job-orders/:id/events   -> { events: [...] }
 *   GET   /api/admin/job-orders/:id/card     -> { job, events, business }  (printable job card)
 *
 *   -- Artwork uploads (R2-backed) --
 *   POST /api/upload           (auth) multipart/form-data "file" -> { key, filename, size, url }
 *   GET  /api/upload/:key      (auth, owner or admin) -> streams the file back
 *
 *   -- Order lifecycle / abandoned cart --
 *   GET  /api/orders/:id/events  (auth) -> { events: [...] }   (status timeline for one order)
 *   POST /api/cart/sync          (auth) { items } -> { ok }    (debounced client-side ping; cron sweeps for reminders)
 *   GET  /api/health             -> { ok, db, time }           (for an uptime monitor)
 *
 *   -- Payments (advance/balance — pay link is a stub until a gateway is configured) --
 *   POST  /api/admin/payments            { orderId, kind, amount } -> { payment: { id, payLink } }
 *   GET   /api/admin/payments            -> { payments: [...] }
 *   PATCH /api/admin/payments/:id        { status } -> { ok }
 *   POST  /api/pay-stub/:id              (no auth — stub "pay" action) -> { ok }
 *
 *   -- Credit notes / refunds (GST reversed: CGST+SGST or IGST) --
 *   POST  /api/admin/credit-notes        { orderId, reason, taxableAmount, gstMode?, gstRate? } -> { creditNote }
 *   GET   /api/admin/credit-notes        -> { creditNotes: [...] }
 *   PATCH /api/admin/credit-notes/:id    { status } -> { ok }
 *
 *   -- Proof approval (public, token-based) --
 *   POST  /api/admin/proof-approvals     { jobId, fileUrl? } -> { token, link }
 *   GET   /api/proof-approvals/:token    -> { proof }
 *   PATCH /api/proof-approvals/:token    { status, customerNote? } -> { ok }
 *
 *   -- Reports / settings / backup / activity --
 *   GET   /api/admin/reports/margin      -> { jobs: [...], totals }
 *   GET   /api/admin/settings            -> { settings }
 *   PATCH /api/admin/settings            { businessName?, gstin?, address?, logoUrl?, bankDetails?, brandColor?, alertEmail?, defaultCostPct? } -> { ok }
 *   GET   /api/admin/backup              -> full JSON dump of every table
 *   GET   /api/admin/activity            -> { activity: [...] }
 *
 * Auth model: a random session token is stored in the `sessions` table and
 * returned to the client, which keeps it in localStorage (same as before —
 * only the account/order DATA moved server-side, not the browser's handling
 * of its own token) and sends it back as `Authorization: Bearer <token>`.
 * Passwords are hashed with PBKDF2-SHA256 (Web Crypto, built into Workers —
 * no extra dependency) before ever touching the database.
 *
 * Admin access: set an ADMIN_KEY secret (`wrangler secret put ADMIN_KEY`)
 * and send it as the `X-Admin-Key` header from the admin dashboard. This
 * replaces the old hardcoded client-side "PrintAdmin123!" check.
 *
 * Email: set a RESEND_API_KEY secret (`wrangler secret put RESEND_API_KEY`,
 * get one free at resend.com) to enable order-status emails, abandoned-cart
 * reminders, payment reminders, and proof-approval emails. Without it,
 * sendEmail() silently no-ops — every feature still works and records data,
 * it just won't send mail. Optionally set MAIL_FROM to override the sender.
 *
 * Payments: no gateway is configured yet. createPayLink() returns a
 * placeholder /pay-stub/:id link (see POST /api/pay-stub/:id) so the
 * advance/balance/reminder flow can be built and tested end-to-end. Wire a
 * real Razorpay (or other) integration into createPayLink() once keys are
 * available — see the TODO there.
 *
 * Cron: wrangler.toml's [triggers] runs scheduled() hourly, which sends
 * abandoned-cart (1hr/24hr) and overdue-payment reminder emails. This only
 * takes effect once deployed with `wrangler deploy` — it is not simulated
 * in local dev without `wrangler dev --test-scheduled`.
 */

const PBKDF2_ITERATIONS = 100000;
const GST_RATE = 0.18;

// Mirrors index.html's cleanOptionLabel() exactly — the cart stores this
// cleaned label as item.opt, not calc-data.json's raw "Select Shape: ... |
// Quality: ... | Select Material: ..." key, so price recomputation has to
// re-derive the same cleaned label from each raw key to find the match.
function cleanOptionLabel(raw) {
  if (raw === '(default)') return 'Standard';
  return raw.split('|').map((seg) => {
    const idx = seg.indexOf(':');
    return (idx === -1 ? seg : seg.slice(idx + 1)).trim();
  }).join(' · ');
}

let calcDataCache = null;
async function getCalcData(env, request) {
  if (calcDataCache) return calcDataCache;
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new URL('/calc-data.json', request.url));
  if (!res.ok) return null;
  calcDataCache = await res.json();
  return calcDataCache;
}

// Recomputes a single cart item's price straight from the catalogue, so the
// server never trusts a client-supplied unit price or subtotal. Returns
// { unitPrice, lineTotal } or null if the item doesn't resolve to a real
// catalogue row (unknown slug/size/option, or no pricing at that quantity).
const MAX_ITEM_QTY = 1_000_000; // sanity ceiling — real catalogue rows top out far below this

function priceItem(calcData, item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.slug || typeof item.slug !== 'string') return null;
  const p = calcData[item.slug];
  if (!p) return null;
  if (!item.size || typeof item.size !== 'string') return null;
  const optMap = p.sizes && p.sizes[item.size];
  if (!optMap) return null;

  const qty = Number(item.qty);
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_ITEM_QTY) return null;

  // Find the raw option key whose cleaned label matches what the cart sent.
  const rawKey = Object.keys(optMap).find((k) => cleanOptionLabel(k) === item.opt);
  if (!rawKey) return null;
  const rows = optMap[rawKey];
  const row = rows.find((r) => r[0] === qty);
  if (!row) return null; // quantity not sold at this spec (no slab for it)

  const [, unitPrice] = row;
  return { unitPrice, lineTotal: +(unitPrice * qty).toFixed(2) };
}

// Recomputes the whole order from the catalogue. Throws (with a user-safe
// message) if any item doesn't resolve — never silently falls back to the
// client-supplied numbers.
// ---------- Status state machines ----------
// Without these, the admin dashboard's <select> let staff jump an order or
// job to any status in one click (e.g. Received -> Completed, skipping
// Processing/Printed/Shipped entirely), which corrupts the record of what
// actually happened and breaks anything that assumes a normal progression
// (customer emails, the margin report, automations). Enforced server-side
// so it can't be bypassed by calling the API directly either.
const ORDER_STATUS_TRANSITIONS = {
  Received: ['Processing', 'Cancelled'],
  Processing: ['Printed', 'Cancelled', 'On Hold'],
  Printed: ['Shipped', 'Cancelled', 'On Hold'],
  Shipped: ['Completed', 'Cancelled'],
  Completed: [], // terminal
  Cancelled: [], // terminal
  'On Hold': ['Processing', 'Printed', 'Cancelled']
};

function isValidOrderTransition(from, to) {
  if (!from) return true; // no current status on record — allow (defensive)
  if (from === to) return true; // no-op PATCH (e.g. re-saving tracking/note)
  const allowed = ORDER_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const JOB_STAGE_TRANSITIONS = {
  Queued: ['Design', 'Prepress', 'Printing', 'On Hold', 'Cancelled'],
  Design: ['Prepress', 'On Hold', 'Cancelled'],
  Prepress: ['Printing', 'On Hold', 'Cancelled'],
  Printing: ['Finishing', 'On Hold', 'Cancelled'],
  Finishing: ['QC', 'On Hold', 'Cancelled'],
  QC: ['Ready', 'Finishing', 'On Hold', 'Cancelled'], // QC can bounce back to Finishing on fail
  Ready: ['Dispatched', 'On Hold', 'Cancelled'],
  Dispatched: ['Delivered', 'On Hold'],
  Delivered: [], // terminal
  Cancelled: [], // terminal
  'On Hold': ['Queued', 'Design', 'Prepress', 'Printing', 'Finishing', 'QC', 'Ready', 'Cancelled']
};

function isValidJobTransition(from, to) {
  if (!from) return true;
  if (from === to) return true;
  const allowed = JOB_STAGE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const MAX_ORDER_ITEMS = 100; // sanity ceiling on cart size per order

async function priceOrder(env, request, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('No items in order.');
  if (items.length > MAX_ORDER_ITEMS) throw new Error(`Orders are limited to ${MAX_ORDER_ITEMS} items — please split this into multiple orders.`);
  const calcData = await getCalcData(env, request);
  if (!calcData) throw new Error('Pricing data is temporarily unavailable — please try again.');
  let subtotal = 0;
  const priced = [];
  for (const item of items) {
    const p = priceItem(calcData, item);
    if (!p) throw new Error(`Could not verify the price for "${item && item.name || (item && item.slug) || 'an item'}" — please re-select it and try again.`);
    subtotal += p.lineTotal;
    priced.push({ ...item, unit: p.unitPrice });
  }
  subtotal = +subtotal.toFixed(2);
  const gst = +(subtotal * GST_RATE).toFixed(2);
  const total = +(subtotal + gst).toFixed(2);
  return { items: priced, subtotal, gst, total };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltOut = btoa(String.fromCharCode(...salt));
  return `${saltOut}:${hashB64}`;
}

async function verifyPassword(password, stored) {
  const [saltB64] = stored.split(':');
  const recomputed = await hashPassword(password, saltB64);
  return recomputed === stored;
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Collision-resistant IDs for orders/payments/quotes/credit-notes/jobs.
// Replaces the old `'PF-' + Date.now().toString().slice(-8)` pattern, which
// truncates to the last 8 digits of the millisecond timestamp — two
// requests landing in the same millisecond (realistic under any concurrent
// load, e.g. a retried request racing the original) could collide and one
// INSERT would silently overwrite or conflict with the other. A short
// random suffix from crypto.getRandomValues makes collision astronomically
// unlikely while keeping IDs short and readable.
function newId(prefix) {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 8);
  return `${prefix}-${Date.now().toString(36)}${rand}`.toUpperCase();
}

async function getUserFromToken(db, token) {
  if (!token) return null;
  const row = await db
    .prepare('SELECT s.user_id, s.expires_at, u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, name: row.name, email: row.email };
}

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// ---------- Email (Resend API) ----------
// Requires a RESEND_API_KEY secret (`wrangler secret put RESEND_API_KEY`).
// Silently no-ops (and logs) if the key isn't set, so none of the features
// that trigger an email ever fail the request because mail isn't configured.
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !to) return { sent: false, reason: 'not configured' };
  try {
    const from = env.MAIL_FROM || 'Print Haus <orders@printhausindia.com>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    return { sent: res.ok, reason: res.ok ? null : 'send failed (' + res.status + ')' };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

const ORDER_STATUS_COPY = {
  Received: { subject: 'Order received', body: "We've received your order and will begin production shortly." },
  'Artwork Approved': { subject: 'Artwork approved', body: 'Your artwork has been approved — moving to print.' },
  Printing: { subject: 'Your order is printing', body: 'Your order is now in production.' },
  Shipped: { subject: 'Your order has shipped', body: 'Your order is on its way.' },
  Delivered: { subject: 'Order delivered', body: "Your order has been delivered. We'd love your feedback!" }
};

async function logOrderEvent(db, env, orderId, status, tracking, note) {
  const inserted = await db.prepare('INSERT INTO order_events (order_id, status, tracking, note) VALUES (?,?,?,?)')
    .bind(orderId, status, tracking || null, note || null).run();
  const eventId = inserted.meta.last_row_id;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!order) return;
  const user = await db.prepare('SELECT email, name FROM users WHERE id = ?').bind(order.user_id).first();
  const copy = ORDER_STATUS_COPY[status];
  if (!user || !copy) return;
  const trackLine = tracking ? `<p>Tracking: <a href="${tracking}">${tracking}</a></p>` : '';
  const result = await sendEmail(env, {
    to: user.email,
    subject: `${copy.subject} — Order ${orderId}`,
    html: `<p>Hi ${user.name},</p><p>${copy.body}</p>${trackLine}<p>— Print Haus</p>`
  });
  if (result.sent) {
    await db.prepare('UPDATE order_events SET emailed = 1 WHERE id = ?').bind(eventId).run();
  }
}

async function logActivity(db, actor, action, detail) {
  await db.prepare('INSERT INTO activity_log (actor, action, detail) VALUES (?,?,?)').bind(actor || 'admin', action, detail || null).run();
}

// ---------- Payments (stub pay-link until a gateway key is configured) ----------
// TODO: once Razorpay (or another gateway) keys are available, replace this
// with a real Orders API call that returns a live checkout URL. Until then
// this returns a clearly-marked placeholder link so the rest of the
// advance/balance/reminder flow can be built and tested end-to-end.
function createPayLink(env, paymentId, amount) {
  if (env.RAZORPAY_KEY_ID) {
    // Real integration point — left unimplemented pending keys.
  }
  return `https://printhaus.work-meridiangray.workers.dev/pay-stub/${paymentId}?amount=${amount}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const db = env.DB;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key'
        }
      });
    }

    if (pathname === '/api/health') {
      // Point an uptime monitor (e.g. UptimeRobot) at this URL.
      try {
        await db.prepare('SELECT 1').first();
        return json({ ok: true, db: true, time: new Date().toISOString() });
      } catch (e) {
        return json({ ok: false, db: false, error: e.message }, 503);
      }
    }

    if (!pathname.startsWith('/api/')) {
      // Not an API route — let the static assets binding serve it.
      return env.ASSETS ? env.ASSETS.fetch(request) : err('Not found', 404);
    }

    try {
      // ---------- Auth ----------
      if (pathname === '/api/signup' && request.method === 'POST') {
        const { name, email, password } = await request.json();
        if (!name || !email || !password) return err('name, email, and password are required');
        const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return err('An account with that email already exists', 409);
        const hashed = await hashPassword(password);
        const result = await db
          .prepare('INSERT INTO users (email, name, password) VALUES (?, ?, ?)')
          .bind(email, name, hashed)
          .run();
        const userId = result.meta.last_row_id;
        const token = randomToken();
        const expires = new Date(Date.now() + 30 * 86400000).toISOString();
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expires).run();
        return json({ token, user: { id: userId, name, email } });
      }

      if (pathname === '/api/login' && request.method === 'POST') {
        const { email, password } = await request.json();
        if (!email || !password) return err('email and password are required');
        const user = await db.prepare('SELECT id, name, email, password FROM users WHERE email = ?').bind(email).first();
        if (!user || !(await verifyPassword(password, user.password))) return err('Invalid email or password', 401);
        const token = randomToken();
        const expires = new Date(Date.now() + 30 * 86400000).toISOString();
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, expires).run();
        return json({ token, user: { id: user.id, name: user.name, email: user.email } });
      }

      if (pathname === '/api/logout' && request.method === 'POST') {
        const token = bearerToken(request);
        if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return json({ ok: true });
      }

      if (pathname === '/api/me' && request.method === 'GET') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        return json({ user });
      }

      // ---------- Orders (customer-scoped) ----------
      if (pathname === '/api/orders' && request.method === 'POST') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        const body = await request.json();
        const { customer, phone, address, note, items } = body;
        if (!customer || !address || !Array.isArray(items) || !items.length) return err('customer, address, and items are required');

        // Idempotency: the client sends a key (one per checkout attempt —
        // see pf-api.js placeOrder) in X-Idempotency-Key. A double-click,
        // browser retry, or flaky-connection resubmit reuses the same key,
        // so we return the order that was already created instead of
        // making a second one. Without a key, every submit is treated as
        // its own attempt (back-compat for any caller that doesn't send one).
        const idemKey = request.headers.get('X-Idempotency-Key');
        if (idemKey) {
          const existing = await db.prepare('SELECT order_id FROM idempotency_keys WHERE key = ? AND user_id = ?').bind(idemKey, user.id).first();
          if (existing && existing.order_id) {
            const o = await db.prepare('SELECT id, subtotal, gst, total FROM orders WHERE id = ?').bind(existing.order_id).first();
            if (o) return json({ ok: true, order: o, duplicate: true });
          }
        }

        // Prices, GST and total are never taken from the client — they are
        // recomputed from the catalogue here so a tampered request body
        // can't produce an order at an arbitrary price.
        let priced;
        try {
          priced = await priceOrder(env, request, items);
        } catch (e) {
          return err(e.message, 422);
        }

        const id = newId('PF');

        // Atomic: the order row and every item row commit together in one
        // D1 batch, or none of them do. Previously these were separate
        // .run() calls in a loop — a crash or hiccup partway through the
        // loop could leave an order with some items missing and no way to
        // tell from the order record alone.
        const statements = [
          db.prepare('INSERT INTO orders (id, user_id, customer, phone, address, note, subtotal, gst, total, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(id, user.id, customer, phone || '', address, note || '', priced.subtotal, priced.gst, priced.total, 'Received'),
          ...priced.items.map((i) =>
            db.prepare('INSERT INTO order_items (order_id, slug, name, size, opt, qty, unit_price, artwork_key) VALUES (?,?,?,?,?,?,?,?)')
              .bind(id, i.slug, i.name, i.size || '', i.opt || '', i.qty, i.unit, i.artworkKey || null)
          )
        ];
        if (idemKey) {
          statements.push(
            db.prepare('INSERT OR REPLACE INTO idempotency_keys (key, user_id, route, order_id) VALUES (?,?,?,?)')
              .bind(idemKey, user.id, '/api/orders', id)
          );
        }
        await db.batch(statements);

        return json({ ok: true, order: { id, subtotal: priced.subtotal, gst: priced.gst, total: priced.total } });
      }

      if (pathname === '/api/orders' && request.method === 'GET') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        const orders = await db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all();
        const withItems = await Promise.all(
          orders.results.map(async (o) => {
            const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(o.id).all();
            return { ...o, items: items.results };
          })
        );
        return json({ orders: withItems });
      }

      // ---------- Artwork uploads (R2) ----------
      // POST /api/upload — multipart/form-data, field "file". Auth required
      // (artwork is tied to the uploading account). Returns { key, filename,
      // size, url } where url is this same worker's /api/upload/:key route
      // (kept behind the worker rather than making the bucket public).
      if (pathname === '/api/upload' && request.method === 'POST') {
        if (!env.ARTWORK_BUCKET) return err('File uploads are not configured yet', 503);
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);

        const form = await request.formData().catch(() => null);
        const file = form && form.get('file');
        if (!file || typeof file === 'string') return err('No file provided');

        const MAX_BYTES = 25 * 1024 * 1024; // 25MB per file
        if (file.size > MAX_BYTES) return err('File is too large (25MB max)', 413);

        // Daily per-user cap — keeps R2 usage predictable (well inside the
        // free tier: 10GB storage / 1M writes / 10M reads per month) even
        // if a single account tries to spam uploads.
        const DAILY_UPLOAD_LIMIT = 30;
        const DAILY_BYTES_LIMIT = 200 * 1024 * 1024; // 200MB/user/day
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const usage = await db
          .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM uploads WHERE user_id = ? AND created_at > ?')
          .bind(user.id, since)
          .first();
        if (usage.n >= DAILY_UPLOAD_LIMIT) return err('Daily upload limit reached (30 files/day). Try again tomorrow.', 429);
        if (usage.bytes + file.size > DAILY_BYTES_LIMIT) return err('Daily upload data limit reached (200MB/day). Try again tomorrow.', 429);

        const ALLOWED = new Set([
          'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
          'application/pdf',
          'application/postscript', // .ai / .eps
          'image/vnd.adobe.photoshop',
          'application/x-photoshop',
          'application/octet-stream' // fallback for .ai/.psd/.cdr that the browser can't type
        ]);
        if (file.type && !ALLOWED.has(file.type)) return err('Unsupported file type: ' + file.type, 415);

        const safeName = (file.name || 'artwork').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
        const key = `artwork/${user.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;

        await env.ARTWORK_BUCKET.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || 'application/octet-stream' }
        });
        await db
          .prepare('INSERT INTO uploads (key, user_id, filename, size_bytes, content_type) VALUES (?,?,?,?,?)')
          .bind(key, user.id, safeName, file.size, file.type || '')
          .run();

        return json({ ok: true, key, filename: safeName, size: file.size, url: `/api/upload/${encodeURIComponent(key)}` });
      }

      // GET /api/upload/:key — streams the file back. Auth required; only
      // the uploader or an admin can fetch it.
      if (pathname.startsWith('/api/upload/') && request.method === 'GET') {
        if (!env.ARTWORK_BUCKET) return err('File uploads are not configured yet', 503);
        const key = decodeURIComponent(pathname.slice('/api/upload/'.length));
        const adminKey = request.headers.get('X-Admin-Key');
        const isAdmin = !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY;
        if (!isAdmin) {
          const user = await getUserFromToken(db, bearerToken(request));
          const row = await db.prepare('SELECT user_id FROM uploads WHERE key = ?').bind(key).first();
          if (!user || !row || row.user_id !== user.id) return err('Not authorized', 403);
        }
        const obj = await env.ARTWORK_BUCKET.get(key);
        if (!obj) return err('Not found', 404);
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=86400'
          }
        });
      }

      // ---------- Quotes (no auth required — same as the old quote form) ----------
      if (pathname === '/api/quotes' && request.method === 'POST') {
        const body = await request.json();
        const { company, name, email, whatsapp, department, orderNumber, message, product } = body;
        if (!name || !email || !message) return err('name, email, and message are required');
        const id = newId('Q');
        await db
          .prepare('INSERT INTO quotes (id, company, name, email, whatsapp, department, order_number, message, product) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(id, company || '', name, email, whatsapp || '', department || '', orderNumber || '', message, product || null)
          .run();
        return json({ ok: true, quote: { id } });
      }

      // My Quotations — quotes aren't user_id-linked (the form needs no
      // login), so this matches by the logged-in user's email instead.
      if (pathname === '/api/quotes/mine' && request.method === 'GET') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        const rows = await db.prepare('SELECT * FROM quotes WHERE email = ? ORDER BY created_at DESC').bind(user.email).all();
        return json({ quotes: rows.results });
      }

      // ---------- Admin ----------
      // Every admin route requires the ADMIN_KEY secret to be set
      // (`wrangler secret put ADMIN_KEY`) AND match the X-Admin-Key header.
      // No ADMIN_KEY configured = no admin access, full stop — this used to
      // fail open (!env.ADMIN_KEY || ...), which left every admin route,
      // including the DB backup, open to anyone with the URL. Never revert
      // to fail-open.
      const adminKey = request.headers.get('X-Admin-Key');
      const adminOk = !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY;

      if (pathname === '/api/admin/orders' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const orders = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        return json({ orders: orders.results });
      }

      if (pathname === '/api/admin/quotes' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const quotes = await db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all();
        return json({ quotes: quotes.results });
      }

      const quoteStatusMatch = pathname.match(/^\/api\/admin\/quotes\/([^/]+)$/);
      if (quoteStatusMatch && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const { status } = await request.json();
        if (!status) return err('status is required');
        await db.prepare('UPDATE quotes SET status = ? WHERE id = ?').bind(status, quoteStatusMatch[1]).run();
        return json({ ok: true });
      }

      const orderStatusMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if (orderStatusMatch && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const { status, tracking, note } = await request.json();
        if (!status) return err('status is required');
        if (!ORDER_STATUS_TRANSITIONS.hasOwnProperty(status)) return err(`Unknown status "${status}"`, 422);
        const current = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(orderStatusMatch[1]).first();
        if (!current) return err('Order not found', 404);
        if (!isValidOrderTransition(current.status, status)) {
          return err(`Cannot move an order from "${current.status}" to "${status}" — allowed next steps: ${ORDER_STATUS_TRANSITIONS[current.status].join(', ') || 'none (terminal status)'}`, 422);
        }
        await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, orderStatusMatch[1]).run();
        await logOrderEvent(db, env, orderStatusMatch[1], status, tracking, note);
        await logActivity(db, 'admin', 'order-status', `${orderStatusMatch[1]} -> ${status}`);
        return json({ ok: true });
      }

      const orderEventsMatch = pathname.match(/^\/api\/orders\/([^/]+)\/events$/);
      if (orderEventsMatch && request.method === 'GET') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        const order = await db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(orderEventsMatch[1], user.id).first();
        if (!order) return err('Not found', 404);
        const rows = await db.prepare('SELECT status, tracking, note, created_at FROM order_events WHERE order_id = ? ORDER BY created_at ASC').bind(orderEventsMatch[1]).all();
        return json({ events: rows.results });
      }

      // ---------- Abandoned-cart tracking ----------
      // The frontend calls this (debounced) whenever a logged-in user's
      // cart changes. The scheduled() cron below reads this table and sends
      // the 1hr / 24hr reminder emails. A cart with 0 items is treated as
      // "cleared" (status Recovered) rather than deleted, so re-adding
      // items resumes tracking under the same row.
      if (pathname === '/api/cart/sync' && request.method === 'POST') {
        const user = await getUserFromToken(db, bearerToken(request));
        if (!user) return err('Not authenticated', 401);
        const { items } = await request.json();
        if (!Array.isArray(items)) return err('items must be an array');
        const existing = await db.prepare("SELECT id FROM carts WHERE user_id = ? AND status IN ('Active','Reminded') ORDER BY id DESC LIMIT 1").bind(user.id).first();
        if (!items.length) {
          if (existing) await db.prepare("UPDATE carts SET status = 'Recovered', items_json = '[]', updated_at = datetime('now') WHERE id = ?").bind(existing.id).run();
          return json({ ok: true });
        }
        const itemsJson = JSON.stringify(items);
        if (existing) {
          await db.prepare("UPDATE carts SET items_json = ?, status = 'Active', reminded_1h = 0, reminded_24h = 0, updated_at = datetime('now') WHERE id = ?").bind(itemsJson, existing.id).run();
        } else {
          await db.prepare('INSERT INTO carts (user_id, items_json) VALUES (?,?)').bind(user.id, itemsJson).run();
        }
        return json({ ok: true });
      }

      // ---------- Payments (advance / balance, with stub pay-link) ----------
      if (pathname === '/api/admin/payments' && request.method === 'POST') {
        if (!adminOk) return err('Unauthorized', 401);
        const { orderId, kind, amount } = await request.json();
        if (!orderId || !kind || !amount) return err('orderId, kind, and amount are required');
        if (kind !== 'advance' && kind !== 'balance') return err('kind must be "advance" or "balance"');
        const id = newId('PAY');
        const payLink = createPayLink(env, id, amount);
        await db.prepare('INSERT INTO payments (id, order_id, kind, amount, pay_link) VALUES (?,?,?,?,?)')
          .bind(id, orderId, kind, amount, payLink).run();
        const order = await db.prepare('SELECT user_id FROM orders WHERE id = ?').bind(orderId).first();
        if (order) {
          const user = await db.prepare('SELECT email, name FROM users WHERE id = ?').bind(order.user_id).first();
          if (user) {
            await sendEmail(env, {
              to: user.email,
              subject: `Payment request — Order ${orderId}`,
              html: `<p>Hi ${user.name},</p><p>A ${kind} payment of ₹${amount} is due for your order ${orderId}.</p><p><a href="${payLink}">Pay now</a></p><p>— Print Haus</p>`
            });
          }
        }
        await logActivity(db, 'admin', 'payment-request', `${id} (${kind}, ₹${amount}) for ${orderId}`);
        return json({ ok: true, payment: { id, payLink } });
      }

      if (pathname === '/api/admin/payments' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const rows = await db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all();
        return json({ payments: rows.results });
      }

      const paymentStatusMatch = pathname.match(/^\/api\/admin\/payments\/([^/]+)$/);
      if (paymentStatusMatch && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const { status } = await request.json();
        if (!status) return err('status is required');
        const paidAt = status === 'Paid' ? ", paid_at = datetime('now')" : '';
        await db.prepare(`UPDATE payments SET status = ?${paidAt} WHERE id = ?`).bind(status, paymentStatusMatch[1]).run();
        return json({ ok: true });
      }

      // DEV/TEST ONLY: lets the advance/balance flow be exercised end-to-end
      // before a real payment gateway is wired up. Disabled in production
      // by default — anyone with a payment ID could otherwise mark it Paid
      // for free. Only enable by setting the ALLOW_PAY_STUB secret to "true"
      // on a test deployment; never set it on the live site, and remove
      // this route entirely once Razorpay (or another real gateway) is
      // wired into createPayLink().
      const payStubMatch = pathname.match(/^\/api\/pay-stub\/([^/]+)$/);
      if (payStubMatch && request.method === 'POST') {
        if (env.ALLOW_PAY_STUB !== 'true') return err('Payments are not configured yet. This order has not been charged.', 503);
        await db.prepare("UPDATE payments SET status = 'Paid', paid_at = datetime('now') WHERE id = ?").bind(payStubMatch[1]).run();
        return json({ ok: true, note: 'Stub payment recorded — no real gateway is connected yet.' });
      }

      // ---------- Credit notes / refunds (GST reversed correctly) ----------
      if (pathname === '/api/admin/credit-notes' && request.method === 'POST') {
        if (!adminOk) return err('Unauthorized', 401);
        const { orderId, reason, taxableAmount, gstMode, gstRate } = await request.json();
        if (!orderId || !reason || !taxableAmount) return err('orderId, reason, and taxableAmount are required');
        const mode = gstMode === 'IGST' ? 'IGST' : 'CGST_SGST';
        const rate = gstRate || 18;
        let cgst = 0, sgst = 0, igst = 0;
        if (mode === 'IGST') igst = +(taxableAmount * rate / 100).toFixed(2);
        else { cgst = +(taxableAmount * rate / 200).toFixed(2); sgst = cgst; }
        const total = +(taxableAmount + cgst + sgst + igst).toFixed(2);
        const id = newId('CN');
        await db.prepare(
          `INSERT INTO credit_notes (id, order_id, reason, taxable_amount, gst_mode, gst_rate, cgst, sgst, igst, total)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, orderId, reason, taxableAmount, mode, rate, cgst, sgst, igst, total).run();
        await logActivity(db, 'admin', 'credit-note', `${id} for ${orderId}: ₹${total}`);
        return json({ ok: true, creditNote: { id, cgst, sgst, igst, total } });
      }

      if (pathname === '/api/admin/credit-notes' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const rows = await db.prepare('SELECT * FROM credit_notes ORDER BY created_at DESC').all();
        return json({ creditNotes: rows.results });
      }

      const creditNoteStatusMatch = pathname.match(/^\/api\/admin\/credit-notes\/([^/]+)$/);
      if (creditNoteStatusMatch && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const { status } = await request.json();
        if (!status) return err('status is required');
        await db.prepare('UPDATE credit_notes SET status = ? WHERE id = ?').bind(status, creditNoteStatusMatch[1]).run();
        return json({ ok: true });
      }

      // ---------- Job orders (production tracking) ----------
      if (pathname === '/api/admin/job-orders' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const rows = await db.prepare('SELECT * FROM job_orders ORDER BY updated_at DESC').all();
        return json({ jobOrders: rows.results });
      }

      if (pathname === '/api/admin/job-orders' && request.method === 'POST') {
        if (!adminOk) return err('Unauthorized', 401);
        const body = await request.json();
        const { sourceType, sourceId, title, customerName, customerEmail, priority, dueDate, materialCost, laborCost, overheadCost, quotedPrice, notes } = body;
        if (!sourceType || !sourceId || !title) return err('sourceType, sourceId, and title are required');
        if (sourceType !== 'order' && sourceType !== 'quote') return err('sourceType must be "order" or "quote"');
        const id = newId('JOB');
        await db
          .prepare(
            `INSERT INTO job_orders
             (id, source_type, source_id, title, customer_name, customer_email, stage, priority, due_date, material_cost, labor_cost, overhead_cost, quoted_price, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            id, sourceType, sourceId, title, customerName || '', customerEmail || '',
            'Queued', priority || 'Normal', dueDate || null,
            materialCost || 0, laborCost || 0, overheadCost || 0, quotedPrice || 0, notes || ''
          )
          .run();
        await db.prepare('INSERT INTO job_order_events (job_id, stage, note) VALUES (?,?,?)').bind(id, 'Queued', 'Job order created').run();
        return json({ ok: true, jobOrder: { id } });
      }

      const jobEventsMatch = pathname.match(/^\/api\/admin\/job-orders\/([^/]+)\/events$/);
      if (jobEventsMatch && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const rows = await db.prepare('SELECT * FROM job_order_events WHERE job_id = ? ORDER BY created_at ASC').bind(jobEventsMatch[1]).all();
        return json({ events: rows.results });
      }

      const jobUpdateMatch = pathname.match(/^\/api\/admin\/job-orders\/([^/]+)$/);
      if (jobUpdateMatch && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const jobId = jobUpdateMatch[1];
        const body = await request.json();
        const fieldMap = {
          stage: 'stage', priority: 'priority', dueDate: 'due_date', materialCost: 'material_cost',
          laborCost: 'labor_cost', overheadCost: 'overhead_cost', quotedPrice: 'quoted_price', notes: 'notes'
        };
        if (body.stage !== undefined) {
          if (!JOB_STAGE_TRANSITIONS.hasOwnProperty(body.stage)) return err(`Unknown stage "${body.stage}"`, 422);
          const current = await db.prepare('SELECT stage FROM job_orders WHERE id = ?').bind(jobId).first();
          if (!current) return err('Job order not found', 404);
          if (!isValidJobTransition(current.stage, body.stage)) {
            return err(`Cannot move a job from "${current.stage}" to "${body.stage}" — allowed next steps: ${JOB_STAGE_TRANSITIONS[current.stage].join(', ') || 'none (terminal stage)'}`, 422);
          }
        }
        const sets = [];
        const values = [];
        for (const [key, col] of Object.entries(fieldMap)) {
          if (body[key] !== undefined) { sets.push(col + ' = ?'); values.push(body[key]); }
        }
        if (!sets.length) return err('No updatable fields provided');
        sets.push("updated_at = datetime('now')");
        values.push(jobId);
        await db.prepare(`UPDATE job_orders SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
        if (body.stage !== undefined) {
          await db.prepare('INSERT INTO job_order_events (job_id, stage, note) VALUES (?,?,?)').bind(jobId, body.stage, body.eventNote || '').run();
        }
        return json({ ok: true });
      }

      // One-page job card — the press-floor production sheet. Returns the
      // job order plus its event history and the shop's business details
      // (for the printed header), so the admin UI can render/print it
      // without a second round-trip.
      const jobCardMatch = pathname.match(/^\/api\/admin\/job-orders\/([^/]+)\/card$/);
      if (jobCardMatch && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const job = await db.prepare('SELECT * FROM job_orders WHERE id = ?').bind(jobCardMatch[1]).first();
        if (!job) return err('Not found', 404);
        const events = await db.prepare('SELECT * FROM job_order_events WHERE job_id = ? ORDER BY created_at ASC').bind(jobCardMatch[1]).all();
        const settings = await db.prepare('SELECT business_name, gstin, address, logo_url FROM settings WHERE id = 1').first();
        return json({ job, events: events.results, business: settings });
      }

      // ---------- Proof approval (public, token-based — no account needed) ----------
      if (pathname === '/api/admin/proof-approvals' && request.method === 'POST') {
        if (!adminOk) return err('Unauthorized', 401);
        const { jobId, fileUrl } = await request.json();
        if (!jobId) return err('jobId is required');
        const token = randomToken();
        await db.prepare('INSERT INTO proof_approvals (token, job_id, file_url) VALUES (?,?,?)').bind(token, jobId, fileUrl || null).run();
        const job = await db.prepare('SELECT customer_email, customer_name, title FROM job_orders WHERE id = ?').bind(jobId).first();
        const link = `https://printhaus.work-meridiangray.workers.dev/#proof-${token}`;
        if (job && job.customer_email) {
          await sendEmail(env, {
            to: job.customer_email,
            subject: `Proof ready for approval — ${job.title}`,
            html: `<p>Hi ${job.customer_name || ''},</p><p>Your artwork proof for "${job.title}" is ready. Please review and approve before we print.</p><p><a href="${link}">Review proof</a></p><p>— Print Haus</p>`
          });
        }
        await logActivity(db, 'admin', 'proof-sent', `${jobId}`);
        return json({ ok: true, token, link });
      }

      const proofGetMatch = pathname.match(/^\/api\/proof-approvals\/([^/]+)$/);
      if (proofGetMatch && request.method === 'GET') {
        const row = await db.prepare('SELECT p.*, j.title, j.customer_name FROM proof_approvals p JOIN job_orders j ON j.id = p.job_id WHERE p.token = ?').bind(proofGetMatch[1]).first();
        if (!row) return err('Not found', 404);
        return json({ proof: row });
      }

      if (proofGetMatch && request.method === 'PATCH') {
        const { status, customerNote } = await request.json();
        if (!status || (status !== 'Approved' && status !== 'Changes Requested')) return err('status must be "Approved" or "Changes Requested"');
        const row = await db.prepare('SELECT token, job_id, status AS current_status, created_at FROM proof_approvals WHERE token = ?').bind(proofGetMatch[1]).first();
        if (!row) return err('Not found', 404);

        // Already responded — a reload, resubmit, or stale tab must not
        // flip a finalized decision (e.g. Approved -> Changes Requested
        // after production has already started on the approved version).
        if (row.current_status !== 'Pending') {
          return err(`This proof was already marked "${row.current_status}" and can't be changed. Ask us to send a new proof if you need to.`, 409);
        }

        // Superseded — if a newer proof token exists for the same job (we
        // sent a revised proof after this one), this older link is stale
        // and must not be actionable even if it was never explicitly
        // responded to.
        const newer = await db.prepare('SELECT token FROM proof_approvals WHERE job_id = ? AND created_at > ? LIMIT 1').bind(row.job_id, row.created_at).first();
        if (newer) {
          return err('This proof link has been replaced by a newer one. Please use the latest proof link we sent you.', 409);
        }

        await db.prepare("UPDATE proof_approvals SET status = ?, customer_note = ?, responded_at = datetime('now') WHERE token = ?")
          .bind(status, customerNote || null, proofGetMatch[1]).run();

        if (status === 'Approved') {
          // Readiness check: for an order-sourced job with payment records,
          // at least the advance must be Paid before approval can move
          // production forward. Previously this moved straight to Printing
          // on approval alone — a customer link reaching "Approved" was
          // enough to start production even if nothing had been paid.
          // Quote-sourced jobs and order-sourced jobs with no payment
          // records at all (not every job requires an upfront payment) are
          // left to proceed as before — this only blocks the case where
          // payment IS expected and hasn't happened.
          const job = await db.prepare('SELECT source_type, source_id FROM job_orders WHERE id = ?').bind(row.job_id).first();
          let blocked = false;
          if (job && job.source_type === 'order') {
            const payments = await db.prepare('SELECT status FROM payments WHERE order_id = ?').bind(job.source_id).all();
            if (payments.results.length) {
              const advancePaid = payments.results.some((p) => p.status === 'Paid');
              if (!advancePaid) blocked = true;
            }
          }
          if (blocked) {
            await db.prepare('INSERT INTO job_order_events (job_id, stage, note) VALUES (?,?,?)')
              .bind(row.job_id, 'On Hold', 'Proof approved by customer, but held — payment not yet received').run();
            await db.prepare("UPDATE job_orders SET stage = 'On Hold', updated_at = datetime('now') WHERE id = ?").bind(row.job_id).run();
            return json({ ok: true, held: true, reason: 'payment-pending' });
          }
          await db.prepare("UPDATE job_orders SET stage = 'Printing', updated_at = datetime('now') WHERE id = ?").bind(row.job_id).run();
          await db.prepare('INSERT INTO job_order_events (job_id, stage, note) VALUES (?,?,?)').bind(row.job_id, 'Printing', 'Proof approved by customer').run();
        }
        return json({ ok: true });
      }

      // ---------- Margin report (quoted price vs. material+labor+overhead) ----------
      // Jobs with no cost entered fall back to settings.default_cost_pct of
      // the quoted price, so the report doesn't show a false ~100% margin
      // for jobs nobody has costed yet (flagged via estimated: true).
      if (pathname === '/api/admin/reports/margin' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const settings = await db.prepare('SELECT default_cost_pct FROM settings WHERE id = 1').first();
        const defaultPct = (settings && settings.default_cost_pct) || 60;
        const rows = await db.prepare("SELECT * FROM job_orders WHERE stage != 'Cancelled' ORDER BY created_at DESC").all();
        const report = rows.results.map((j) => {
          const costEntered = j.material_cost + j.labor_cost + j.overhead_cost;
          const estimated = costEntered === 0 && j.quoted_price > 0;
          const cost = estimated ? +(j.quoted_price * defaultPct / 100).toFixed(2) : costEntered;
          const margin = j.quoted_price - cost;
          const marginPct = j.quoted_price ? +((margin / j.quoted_price) * 100).toFixed(1) : 0;
          return { id: j.id, title: j.title, quotedPrice: j.quoted_price, cost, margin, marginPct, estimated, createdAt: j.created_at };
        });
        const totals = report.reduce((a, r) => ({ revenue: a.revenue + r.quotedPrice, cost: a.cost + r.cost, margin: a.margin + r.margin }), { revenue: 0, cost: 0, margin: 0 });
        return json({ jobs: report, totals });
      }

      // ---------- Settings (the "setup page for new shops" item) ----------
      if (pathname === '/api/admin/settings' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
        return json({ settings: row });
      }

      if (pathname === '/api/admin/settings' && request.method === 'PATCH') {
        if (!adminOk) return err('Unauthorized', 401);
        const body = await request.json();
        const fieldMap = {
          businessName: 'business_name', gstin: 'gstin', address: 'address', logoUrl: 'logo_url',
          bankDetails: 'bank_details', brandColor: 'brand_color', alertEmail: 'alert_email', defaultCostPct: 'default_cost_pct'
        };
        const sets = [];
        const values = [];
        for (const [key, col] of Object.entries(fieldMap)) {
          if (body[key] !== undefined) { sets.push(col + ' = ?'); values.push(body[key]); }
        }
        if (!sets.length) return err('No updatable fields provided');
        sets.push("updated_at = datetime('now')");
        await db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).bind(...values).run();
        await logActivity(db, 'admin', 'settings-updated', Object.keys(body).join(', '));
        return json({ ok: true });
      }

      // ---------- Backup ----------
      // D1 has no built-in scheduled-backup API reachable from a Worker, so
      // this dumps every table as JSON for the admin to download — wire it
      // to a daily cron (see scheduled() below) that emails the file as an
      // attachment link, or download it manually from the admin dashboard.
      // A one-click *restore* from this format is NOT implemented — D1
      // writes would need a separate import script run via wrangler.
      if (pathname === '/api/admin/backup' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const tables = ['users', 'orders', 'order_items', 'quotes', 'job_orders', 'job_order_events', 'carts', 'order_events', 'payments', 'credit_notes', 'proof_approvals', 'settings', 'activity_log'];
        const dump = {};
        for (const t of tables) {
          const rows = await db.prepare(`SELECT * FROM ${t}`).all();
          dump[t] = rows.results;
        }
        dump._exportedAt = new Date().toISOString();
        return json(dump);
      }

      // ---------- Activity log ----------
      if (pathname === '/api/admin/activity' && request.method === 'GET') {
        if (!adminOk) return err('Unauthorized', 401);
        const rows = await db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200').all();
        return json({ activity: rows.results });
      }

      return err('Not found', 404);
    } catch (e) {
      return err('Server error: ' + e.message, 500);
    }
  },

  // Runs on the cron schedule set in wrangler.toml ([triggers] crons).
  // Handles: abandoned-cart reminders (1hr / 24hr), and payment reminders
  // for pending dues older than 48 hours. Each check only fires once per
  // row (reminded_1h/24h flags, payments.reminded_at), so re-runs are safe.
  async scheduled(event, env, ctx) {
    const db = env.DB;

    // Abandoned carts
    const carts = await db.prepare("SELECT * FROM carts WHERE status = 'Active'").all();
    const now = Date.now();
    for (const cart of carts.results) {
      const ageMs = now - new Date(cart.updated_at + 'Z').getTime();
      const user = await db.prepare('SELECT email, name FROM users WHERE id = ?').bind(cart.user_id).first();
      if (!user) continue;
      if (!cart.reminded_1h && ageMs >= 3600000) {
        const r = await sendEmail(env, {
          to: user.email,
          subject: 'You left something in your cart',
          html: `<p>Hi ${user.name},</p><p>You still have items waiting in your Print Haus cart. Come finish your order whenever you're ready.</p><p><a href="https://printhaus.work-meridiangray.workers.dev/#cart">View your cart</a></p>`
        });
        if (r.sent) await db.prepare("UPDATE carts SET reminded_1h = 1, status = 'Reminded' WHERE id = ?").bind(cart.id).run();
      } else if (!cart.reminded_24h && ageMs >= 86400000) {
        const r = await sendEmail(env, {
          to: user.email,
          subject: 'Still thinking it over?',
          html: `<p>Hi ${user.name},</p><p>Your cart is still saved — no minimum order quantity, and most orders dispatch within 3 days once you confirm.</p><p><a href="https://printhaus.work-meridiangray.workers.dev/#cart">Complete your order</a></p>`
        });
        if (r.sent) await db.prepare('UPDATE carts SET reminded_24h = 1 WHERE id = ?').bind(cart.id).run();
      }
    }

    // Payment reminders — pending payments older than 48h, reminded at most once/24h
    const duePayments = await db.prepare("SELECT * FROM payments WHERE status = 'Pending'").all();
    for (const p of duePayments.results) {
      const createdAgeMs = now - new Date(p.created_at + 'Z').getTime();
      const lastReminderMs = p.reminded_at ? now - new Date(p.reminded_at + 'Z').getTime() : Infinity;
      if (createdAgeMs < 48 * 3600000 || lastReminderMs < 24 * 3600000) continue;
      const order = await db.prepare('SELECT user_id FROM orders WHERE id = ?').bind(p.order_id).first();
      if (!order) continue;
      const user = await db.prepare('SELECT email, name FROM users WHERE id = ?').bind(order.user_id).first();
      if (!user) continue;
      const r = await sendEmail(env, {
        to: user.email,
        subject: `Payment reminder — Order ${p.order_id}`,
        html: `<p>Hi ${user.name},</p><p>A ${p.kind} payment of ₹${p.amount} is still pending for order ${p.order_id}.</p><p><a href="${p.pay_link}">Pay now</a></p>`
      });
      if (r.sent) await db.prepare("UPDATE payments SET reminded_at = datetime('now') WHERE id = ?").bind(p.id).run();
    }
  }
};
