# Print Haus

Printing-business storefront: product catalog, live price calculator, cart, wishlist, accounts, checkout, quote requests, and an admin dashboard. Accounts, orders, and quotes are backed by a real **Cloudflare D1** database via a **Cloudflare Worker** API — cart/wishlist stay in the browser (localStorage) as pre-checkout scratch state, which is normal for any storefront.

## Structure

- `public/index.html` — the single-page app (routing, UI, cart/catalog logic; calls the API below for accounts/orders/quotes)
- `public/pf-api.js` — browser-side client for the Worker API (signup/login, orders, quotes, admin)
- `public/erpnext-client.js` — optional ERPNext integration (see its own section below); inactive unless configured
- `public/calc-data.json` — the pricing dataset (225 products, sizes/options/quantity-tier pricing)
- `src/worker.js` — the Cloudflare Worker: serves `/api/*` routes against D1, and falls through to the static assets binding for everything else
- `schema.sql` — D1 table definitions (users, sessions, orders, order_items, quotes)
- `wrangler.toml` — Worker + D1 binding + static-assets config

## Deploy

The D1 database (`printhaus`, id `a6ce98e0-f17d-4d52-b2e3-9d39e21a9f8a`) and its schema have already been created directly against your Cloudflare account, and `wrangler.toml` is already wired to it — you only need to deploy the Worker:

```bash
npm install -g wrangler
wrangler login                               # authenticate with your Cloudflare account
wrangler secret put ADMIN_KEY                # set the admin dashboard key (pick your own value)
wrangler deploy                              # deploys the Worker + static assets together
```

If you ever need to (re)create the schema on a *different* D1 database:
```bash
wrangler d1 execute printhaus --remote --file=./schema.sql
```

## Local preview

```bash
npx wrangler dev
```
Note: local preview uses a local D1 emulation, separate from the remote database — run `wrangler dev --remote` to hit the real production database while testing locally.

## Job orders (production tracking)

The Admin Dashboard now includes a **Job Orders** panel — this is the
piece that would otherwise have needed ERPNext (Sales Order → Work Order).
From any paid order or quote request, click **Create Job** to open a job
order; it then tracks through production stages (Queued → Design →
Prepress → Printing → Finishing → QC → Ready → Dispatched → Delivered, plus
On Hold / Cancelled), with editable priority and material/labor/overhead
costs shown against the quoted price so you can see margin per job at a
glance. Backed by the `job_orders` and `job_order_events` tables in D1 —
see `schema.sql`.

## How accounts/orders/quotes work now

- **Sign up / Login** (`#account`) → `POST /api/signup` / `/api/login` → creates a row in `users`, a session token in `sessions`, returned to the browser and kept in `localStorage` (`pf_token`) — same place the old prototype kept its session, just holding a token instead of the whole user object.
- **Checkout** (`#checkout`) → `POST /api/orders` (needs the session token) → writes to `orders` + `order_items`.
- **My Orders** (`#orders`) → `GET /api/orders` → only returns the signed-in user's own orders.
- **Quote requests** (`#quote`) → `POST /api/quotes` → writes to `quotes`. No login required, same as before.
- **Admin dashboard** (`#admin`) → protected by the `ADMIN_KEY` secret (sent as the `X-Admin-Key` header) instead of the old hardcoded `PrintAdmin123!` client-side password. Set it with `wrangler secret put ADMIN_KEY` before deploying, then use that value to log into `/admin-login`.

Passwords are hashed (PBKDF2-SHA256, Web Crypto) before being stored — never kept in plain text.

## Notes

- Cart and wishlist intentionally stay in the browser's `localStorage` — that's normal for any storefront (no reason to round-trip a shopping cart to the server before checkout).
- No payment gateway is integrated yet — checkout records the order but doesn't charge anything.

## ERPNext integration (`public/erpnext-client.js`)

Quote requests and checkout orders can optionally also be created as real
documents in an ERPNext instance (Quotation and Sales Order doctypes), for
job-order tracking, BOM-based costing, etc. This is **optional and inactive
by default** — with no ERPNext configured, the site behaves exactly as the
plain localStorage prototype described above.

**ERPNext itself does not run on Cloudflare Workers.** It's a full
Frappe-framework app (Python + MariaDB + Redis) that needs its own host —
typically [Frappe Cloud](https://frappecloud.com) (managed, easiest to start
with), a VPS, or Docker. Set that up separately; this repo only talks to it
over its REST API once it's running.

### Setup

1. Stand up ERPNext (e.g. a Frappe Cloud site) and install the ERPNext app.
2. In ERPNext: **Settings → API Access** → create an API Key + Secret for an
   integration user scoped to Create/Read/Write on `Quotation` and
   `Sales Order` (not an Administrator login).
3. In ERPNext, under **Customize Form**, add these custom fields so the
   site's data has somewhere to land:
   - `Quotation`: `custom_department`, `custom_related_order`,
     `custom_product_of_interest`, `custom_message` (all Small Text/Data)
   - `Sales Order`: `custom_phone`, `custom_delivery_address`,
     `custom_order_notes` (Small Text/Data)
4. On the live site, open the browser console once and run:
   ```js
   PFErp.configure({
     baseUrl: 'https://your-site.frappecloud.com',
     apiKey: 'xxxxxxxx',
     apiSecret: 'xxxxxxxx'
   });
   ```
   This is stored in that browser's `localStorage` only (`pf_erp_config`).
   Reload the page — quote submissions and checkout now also create ERPNext
   documents; if either call fails, the local record is still saved so
   nothing is lost.

### Security note (read before going live)

Step 4 puts the ERPNext API key/secret in browser `localStorage`, which is
fine for your own testing but **not safe for a public storefront** — any
visitor's browser could read it. For production, swap the direct calls in
`erpnext-client.js`'s `request()` function for calls to a small server-side
proxy (e.g. a Cloudflare Worker route such as `POST /api/quote`) that holds
the real ERPNext credentials server-side and forwards the request. The
`PFErp.trySubmitQuote` / `trySubmitOrder` functions the rest of the site
calls don't need to change — only what's inside `request()`.

### What's deliberately not automated

ERPNext doesn't ship a dedicated "Job Order" doctype for print-shop
production the way some vertical systems do. The standard ERPNext pattern is
**Sales Order → Work Order** (the latter driven by a BOM), and triggering
that conversion is a workflow you set up inside ERPNext itself (a Frappe
automation or manual review step) — not something this client-side file
should do directly against production data. `erpnext-client.js` creates the
Sales Order; the Work Order / production step is intentionally left to
ERPNext's own tools.
