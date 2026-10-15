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
 */

const PBKDF2_ITERATIONS = 100000;

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
        const { customer, phone, address, note, items, subtotal, gst, total } = body;
        if (!customer || !address || !Array.isArray(items) || !items.length) return err('customer, address, and items are required');
        const id = 'PF-' + Date.now().toString().slice(-8);
        await db
          .prepare('INSERT INTO orders (id, user_id, customer, phone, address, note, subtotal, gst, total, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(id, user.id, customer, phone || '', address, note || '', subtotal, gst, total, 'Received')
          .run();
        for (const i of items) {
          await db
            .prepare('INSERT INTO order_items (order_id, slug, name, size, opt, qty, unit_price) VALUES (?,?,?,?,?,?,?)')
            .bind(id, i.slug, i.name, i.size || '', i.opt || '', i.qty, i.unit)
            .run();
        }
        return json({ ok: true, order: { id } });
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

      // ---------- Quotes (no auth required — same as the old quote form) ----------
      if (pathname === '/api/quotes' && request.method === 'POST') {
        const body = await request.json();
        const { company, name, email, whatsapp, department, orderNumber, message, product } = body;
        if (!name || !email || !message) return err('name, email, and message are required');
        const id = 'Q-' + Date.now().toString().slice(-8);
        await db
          .prepare('INSERT INTO quotes (id, company, name, email, whatsapp, department, order_number, message, product) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(id, company || '', name, email, whatsapp || '', department || '', orderNumber || '', message, product || null)
          .run();
        return json({ ok: true, quote: { id } });
      }

      // ---------- Admin ----------
      const adminKey = request.headers.get('X-Admin-Key');
      const adminOk = env.ADMIN_KEY && adminKey === env.ADMIN_KEY;

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
        const { status } = await request.json();
        if (!status) return err('status is required');
        await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, orderStatusMatch[1]).run();
        return json({ ok: true });
      }

      return err('Not found', 404);
    } catch (e) {
      return err('Server error: ' + e.message, 500);
    }
  }
};
